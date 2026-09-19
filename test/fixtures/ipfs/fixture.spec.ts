import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { CLUSTER_IMAGE, KUBO_IMAGE, containerArguments, isolatedIntegrationEnvironment, secretInput } from "./fixture.js";

describe("private IPFS Docker fixture configuration (no Docker required)", () => {
  const options = {
    name: "unique-kubo1", network: "unique-private", alias: "kubo1",
    dataVolume: "unique-data", secretsVolume: "unique-secrets", scriptDirectory: "/project/fixture",
  };

  it.each(["kubo", "cluster"] as const)("isolates %s APIs and secret mounts", (kind) => {
    const args = containerArguments({ ...options, alias: `${kind}1`, kind });
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain(
      `type=volume,source=unique-data,target=${kind === "kubo" ? "/data/ipfs" : "/data/ipfs-cluster"},volume-nocopy`,
    );
    expect(args).toContain("type=volume,source=unique-secrets,target=/run/fixture-secrets,readonly");
    expect(args).not.toContain("--publish");
    expect(args).not.toContain("--publish-all");
    expect(args).toContain("unique-private");
    expect(args.join(" ")).not.toContain("CLUSTER_SECRET=");
    expect(args).toContain(kind === "kubo" ? KUBO_IMAGE : CLUSTER_IMAGE);
    expect(args).not.toContain("latest");
  });

  it("forces a private swarm and explicitly bootstraps Raft followers", () => {
    expect(containerArguments({ ...options, kind: "kubo" })).toContain("LIBP2P_FORCE_PNET=1");
    const bootstrap = "/dns4/cluster1/tcp/9096/p2p/public-peer-id";
    const args = containerArguments({ ...options, alias: "cluster2", kind: "cluster", bootstrap });
    expect(args.slice(-2)).toEqual(["--bootstrap", bootstrap]);
    expect(args).toContain("CLUSTER_IPFSHTTP_NODEMULTIADDRESS=/dns4/kubo2/tcp/5001");
    expect(args).toContain("CLUSTER_REPLICATIONFACTORMIN=2");
    expect(args).toContain("CLUSTER_REPLICATIONFACTORMAX=3");
  });

  it("generates independent fresh swarm and cluster secrets", () => {
    const first = secretInput();
    expect(first).toMatch(/^[a-f0-9]{64}\n[a-f0-9]{64}\n$/);
    const [swarm, cluster] = first.split("\n");
    expect(swarm === cluster).toBe(false);
    expect(first === secretInput()).toBe(false);
  });

  it("does not inherit production auth providers or a cloud backup backend", () => {
    const excluded = [
      "IPFS_API_AUTH", "IPFS_API_AUTH_FILE", "IPFS_API_AUTH_KEYVAULT_SECRET",
      "IPFS_CLUSTER_AUTH", "IPFS_CLUSTER_AUTH_FILE", "IPFS_CLUSTER_AUTH_KEYVAULT_SECRET",
      "IPFS_API_AUTH_AWS_SECRET_ID", "IPFS_CLUSTER_AUTH_AWS_SECRET_ID", "IPFS_BACKUP_BACKEND",
      "AZURE_KEY_VAULT_URL", "AZURE_LOG_LEVEL",
    ];
    const inherited = Object.fromEntries(excluded.map((key) => [key, "synthetic-test-setting"]));
    inherited.PATH = "synthetic-path";
    const environment = isolatedIntegrationEnvironment(inherited);
    expect(environment).toEqual({ PATH: "synthetic-path" });
    for (const key of excluded) expect(inherited[key]).toBe("synthetic-test-setting");
  });

  it("disables public discovery before starting the private Kubo daemon", async () => {
    const script = await readFile(new URL("./kubo.sh", import.meta.url), "utf8");
    for (const setting of [
      "export LIBP2P_FORCE_PNET=1", "ipfs bootstrap rm --all",
      "ipfs config Routing.Type none", "ipfs config --json Provide.Enabled false",
      "ipfs config --json AutoConf.Enabled false", "ipfs config --json AutoTLS.Enabled false",
      "ipfs config --json Discovery.MDNS.Enabled false",
      "ipfs config --json Routing.DelegatedRouters '[]'",
      "ipfs config --json Ipns.DelegatedPublishers '[]'",
    ]) {
      expect(script.includes(setting)).toBe(true);
      expect(script.indexOf(setting)).toBeLessThan(script.indexOf("exec ipfs daemon"));
    }
    const attributes = await readFile(new URL("./.gitattributes", import.meta.url), "utf8");
    expect(attributes).toContain("*.sh text eol=lf");
  });
});
