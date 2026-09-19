import { randomBytes } from "node:crypto";

export const KUBO_IMAGE = "ipfs/kubo:v0.43.1";
export const CLUSTER_IMAGE = "ipfs/ipfs-cluster:v1.1.6";

export function isolatedIntegrationEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  for (const setting of [
    "IPFS_API_AUTH", "IPFS_API_AUTH_FILE", "IPFS_API_AUTH_KEYVAULT_SECRET",
    "IPFS_CLUSTER_AUTH", "IPFS_CLUSTER_AUTH_FILE", "IPFS_CLUSTER_AUTH_KEYVAULT_SECRET",
    "IPFS_API_AUTH_AWS_SECRET_ID", "IPFS_CLUSTER_AUTH_AWS_SECRET_ID", "IPFS_BACKUP_BACKEND",
    "AZURE_KEY_VAULT_URL", "AZURE_LOG_LEVEL",
  ]) delete environment[setting];
  return environment;
}

// Secret values travel only on stdin, never Docker argv, labels, or its saved environment.
export function secretInput(): string {
  return `${randomBytes(32).toString("hex")}\n${randomBytes(32).toString("hex")}\n`;
}

export const SECRET_INIT_SCRIPT = [
  "set -eu",
  "umask 077",
  "read -r swarm",
  "read -r cluster",
  "printf '/key/swarm/psk/1.0.0/\\n/base16/\\n%s\\n' \"$swarm\" > /secrets/swarm.key",
  "printf '%s\\n' \"$cluster\" > /secrets/cluster-secret",
  "chmod 400 /secrets/swarm.key /secrets/cluster-secret",
].join("\n");

export function containerArguments(options: {
  name: string;
  network: string;
  alias: string;
  dataVolume: string;
  secretsVolume: string;
  scriptDirectory: string;
  kind: "kubo" | "cluster";
  bootstrap?: string;
}): string[] {
  const kubo = options.kind === "kubo";
  return [
    "create", "--name", options.name, "--network", options.network,
    "--network-alias", options.alias, "--user", "0:0",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--read-only", "--log-driver", "none",
    "--mount", `type=volume,source=${options.dataVolume},target=${kubo ? "/data/ipfs" : "/data/ipfs-cluster"},volume-nocopy`,
    "--mount", `type=volume,source=${options.secretsVolume},target=/run/fixture-secrets,readonly`,
    "--mount", `type=bind,source=${options.scriptDirectory},target=/fixture,readonly`,
    ...(kubo
      ? ["--env", "IPFS_FORCE_PNET=1"]
      : [
        "--env", "CLUSTER_RESTAPI_HTTPLISTENMULTIADDRESS=/ip4/0.0.0.0/tcp/9094",
        "--env", `CLUSTER_IPFSHTTP_NODEMULTIADDRESS=/dns4/${options.alias.replace("cluster", "kubo")}/tcp/5001`,
        "--env", "CLUSTER_REPLICATIONFACTORMIN=2",
        "--env", "CLUSTER_REPLICATIONFACTORMAX=3",
        "--env", "CLUSTER_MONITORPINGINTERVAL=2s",
      ]),
    "--entrypoint", "/bin/sh", kubo ? KUBO_IMAGE : CLUSTER_IMAGE,
    `/fixture/${options.kind}.sh`,
    ...(options.bootstrap ? ["--bootstrap", options.bootstrap] : []),
  ];
}
