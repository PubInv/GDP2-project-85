import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CLUSTER_IMAGE, KUBO_IMAGE, SECRET_INIT_SCRIPT, containerArguments, isolatedIntegrationEnvironment, secretInput,
} from "../test/fixtures/ipfs/fixture.js";
import { createApiRelay, isPrivateIPv4, type ApiRelay } from "../test/fixtures/ipfs/api-relay.js";

const prefix = `gphr-ipfs-${randomBytes(10).toString("hex")}`;
const network = `${prefix}-network`;
const secretsVolume = `${prefix}-secrets`;
let metadataDirectory: string | undefined;
const containers: string[] = [];
const volumes: string[] = [];
const relays: ApiRelay[] = [];
let networkCreated = false;
let interrupted = false;
let tests: ChildProcess | undefined;
let stage = "checking Docker engine";

async function docker(args: string[], input?: string, timeout = 60_000): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < 1_000_000) output += chunk;
      else child.kill("SIGKILL");
    });
    // Never include Docker output, argv, config, or a captured upstream exception in errors.
    child.once("error", () => { clearTimeout(timer); reject(new Error("Docker command failed.")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done(output.trim());
      else reject(new Error("Docker command failed."));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Fixture API request failed.");
  }
  return response;
}

async function waitUntil(check: () => Promise<boolean>, timeout = 120_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Fixture interrupted.");
    try {
      if (await check()) return;
    } catch {
      // Readiness is retried; neither adapter writes nor the integration suite are retried.
    }
    await delay(500);
  }
  throw new Error("Fixture readiness deadline exceeded.");
}

async function volume(name: string): Promise<void> {
  volumes.push(name);
  await docker(["volume", "create", name]);
}

async function waitForMembers(cluster: string, expected: number): Promise<void> {
  stage = `waiting for ${expected} healthy Cluster members`;
  let previous = "";
  await waitUntil(async () => {
    const text = await (await request(`${cluster}/peers`)).text();
    const peers = text.trim().split("\n").map((line) =>
      JSON.parse(line) as { id?: string; error?: string; ipfs?: { id?: string; error?: string } });
    const healthy = peers.filter((peer) => peer.id && !peer.error && peer.ipfs?.id && !peer.ipfs.error).length;
    const summary = `Cluster members observed: ${peers.length}; healthy Kubo connections: ${healthy}.`;
    if (summary !== previous) console.log(summary);
    previous = summary;
    return peers.length === expected && healthy === expected;
  });
}

async function node(kind: "kubo" | "cluster", index: number, bootstrap?: string): Promise<string> {
  if (interrupted) throw new Error("Fixture interrupted.");
  const name = `${prefix}-${kind}${index}`;
  const dataVolume = `${name}-data`;
  stage = `creating ${kind} ${index} data volume`;
  await volume(dataVolume);
  containers.push(name);
  stage = `creating ${kind} ${index} container`;
  await docker(containerArguments({
    name, network, alias: `${kind}${index}`, dataVolume, secretsVolume,
    scriptDirectory: resolve("test/fixtures/ipfs"), kind,
    ...(bootstrap ? { bootstrap } : {}),
  }));
  stage = `starting ${kind} ${index} container`;
  await docker(["start", name]);
  stage = `connecting ${kind} ${index} private API through loopback relay`;
  const address = await docker([
    "inspect", "--format", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, name,
  ]);
  if (!isPrivateIPv4(address)) throw new Error("Fixture container lacks a private IPv4 address.");
  const relay = await createApiRelay(address, kind === "kubo" ? 5001 : 9094);
  relays.push(relay);
  const endpoint = relay.endpoint;
  stage = `waiting for ${kind} ${index} API readiness`;
  try {
    await waitUntil(async () => {
      const info = await (await request(`${endpoint}${kind === "kubo" ? "/api/v0/id" : "/id"}`,
        kind === "kubo" ? { method: "POST" } : {})).json() as { ID?: string; id?: string };
      return typeof (kind === "kubo" ? info.ID : info.id) === "string";
    });
  } catch {
    const state = await docker(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", name]);
    if (/^[a-z]+ \d+$/.test(state)) console.error(`Fixture ${kind} ${index} container state: ${state}.`);
    throw new Error("Fixture API readiness failed.");
  }
  return endpoint;
}

async function cleanup(): Promise<void> {
  if (tests && tests.exitCode === null && tests.signalCode === null) {
    tests.kill("SIGKILL");
    await new Promise<void>((done) => tests!.once("close", () => done()));
  }
  let failed = false;
  for (const relay of relays) {
    try { await relay.close(); } catch { failed = true; }
  }
  for (const name of [...containers].reverse()) {
    // A failed create may leave nothing to remove; only absence is safe to ignore.
    try {
      await docker(["container", "inspect", "--format", "{{.Id}}", name]);
    } catch { continue; }
    try { await docker(["rm", "--force", "--volumes", name]); } catch { failed = true; }
  }
  for (const name of [...volumes].reverse()) {
    try { await docker(["volume", "rm", name]); } catch { failed = true; }
  }
  if (networkCreated) {
    try { await docker(["network", "rm", network]); } catch { failed = true; }
  }
  if (metadataDirectory) await rm(metadataDirectory, { recursive: true, force: true });
  if (failed) throw new Error("Fixture cleanup incomplete.");
}

async function runSuite(kubo: string, cluster: string): Promise<void> {
  metadataDirectory = await mkdtemp(join(tmpdir(), `${prefix}-index-`));
  const environment = isolatedIntegrationEnvironment(process.env);
  await new Promise<void>((done, reject) => {
    tests = spawn(process.execPath, [
      resolve("node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts",
    ], {
      env: {
        ...environment, STORAGE_INTEGRATION: "true", STORAGE_BACKEND: "ipfs",
        STORAGE_EMULATOR: "true", IPFS_PRIVATE_NETWORK: "true",
        IPFS_API_URL: kubo, IPFS_CLUSTER_API_URL: cluster, IPFS_METADATA_BACKEND: "file",
        STORAGE_FILE_DIRECTORY: metadataDirectory, IPFS_REPLICATION_MIN: "2", IPFS_REPLICATION_MAX: "3",
      },
      stdio: "inherit",
    });
    tests.once("error", () => reject(new Error("Integration tests could not start.")));
    tests.once("close", (code) => code === 0 ? done() : reject(new Error("Integration tests failed.")));
  });
}

async function survivalProbe(kubo: string[], cluster: string): Promise<void> {
  // Opaque synthetic bytes only: no patient tokens, application keys, or plaintext records.
  const bytes = randomBytes(1024);
  const form = new FormData();
  form.set("file", new Blob([bytes]), "synthetic-ciphertext.bin");
  const added = await (await request(`${kubo[0]}/api/v0/add?pin=false&cid-version=1`, {
    method: "POST", body: form,
  })).json() as { Hash: string };
  if (!/^[a-zA-Z0-9]+$/.test(added.Hash)) throw new Error("Invalid probe CID.");
  await request(`${cluster}/pins/${added.Hash}?replication-min=2&replication-max=3`, { method: "POST" });
  // Require all three concrete Kubo replicas before killing the original ingestion node.
  await waitUntil(async () => {
    const pins = await Promise.all(kubo.map(async (endpoint) => {
      const result = await (await request(`${endpoint}/api/v0/pin/ls?arg=${added.Hash}&type=recursive`, {
        method: "POST",
      })).json() as { Keys?: Record<string, unknown> };
      return result.Keys?.[added.Hash] !== undefined;
    }));
    return pins.every(Boolean);
  });
  stage = "verifying existing ciphertext after ingress-node loss";
  await docker(["stop", "--time", "5", `${prefix}-cluster1`, `${prefix}-kubo1`]);
  const received = Buffer.from(await (await request(`${kubo[1]}/api/v0/cat?arg=${added.Hash}`, {
    method: "POST",
  })).arrayBuffer());
  if (!bytes.equals(received)) throw new Error("Replicated ciphertext was not preserved.");
  console.log("Existing synthetic ciphertext survived ingress Kubo/Cluster loss; independent replica read matched.");
}

async function main(): Promise<void> {
  const onSignal = () => {
    interrupted = true;
    tests?.kill("SIGKILL");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"], undefined, 15_000);
    stage = "checking native Linux Docker host";
    if (process.platform !== "linux") throw new Error("Fixture requires a native Linux Docker host.");
    stage = "pulling pinned official images";
    await docker(["pull", KUBO_IMAGE], undefined, 300_000);
    await docker(["pull", CLUSTER_IMAGE], undefined, 300_000);
    if (interrupted) throw new Error("Fixture interrupted.");
    stage = "creating isolated network and secret volume";
    await docker(["network", "create", "--internal", "--driver", "bridge", network]);
    networkCreated = true;
    await volume(secretsVolume);
    const initializer = `${prefix}-secret-init`;
    containers.push(initializer);
    await docker([
      "create", "--name", initializer, "--network", "none", "--interactive",
      "--log-driver", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--user", "0:0",
      "--mount", `type=volume,source=${secretsVolume},target=/secrets`,
      "--entrypoint", "/bin/sh", KUBO_IMAGE, "-c", SECRET_INIT_SCRIPT,
    ]);
    await docker(["start", "--attach", "--interactive", initializer], secretInput());
    stage = "starting private Kubo peers";
    const kubo = [await node("kubo", 1), await node("kubo", 2), await node("kubo", 3)];
    const ids = await Promise.all(kubo.map(async (endpoint) =>
      (await (await request(`${endpoint}/api/v0/id`, { method: "POST" })).json() as { ID: string }).ID));
    for (let from = 0; from < 3; from++) {
      for (let to = 0; to < 3; to++) {
        if (from === to) continue;
        const address = `/dns4/kubo${to + 1}/tcp/4001/p2p/${ids[to]}`;
        await request(`${kubo[from]}/api/v0/swarm/connect?arg=${encodeURIComponent(address)}`, { method: "POST" });
      }
    }
    stage = "bootstrapping three Raft Cluster peers";
    const cluster = await node("cluster", 1);
    const identity = await (await request(`${cluster}/id`)).json() as { id: string };
    const bootstrap = `/dns4/cluster1/tcp/9096/p2p/${identity.id}`;
    await waitForMembers(cluster, 1);
    await node("cluster", 2, bootstrap);
    // An HTTP listener is ready before its Raft membership change has committed.
    await waitForMembers(cluster, 2);
    await node("cluster", 3, bootstrap);
    await waitForMembers(cluster, 3);
    stage = "waiting for three valid Cluster freespace metrics";
    let metricSummary = "";
    await waitUntil(async () => {
      const metrics = await (await request(`${cluster}/monitor/metrics/freespace`)).json() as { valid?: boolean }[];
      const valid = metrics.filter((metric) => metric.valid === true).length;
      const summary = `Cluster freespace metrics observed: ${metrics.length}; valid: ${valid}.`;
      if (summary !== metricSummary) console.log(summary);
      metricSummary = summary;
      return metrics.length === 3 && valid === 3;
    });
    stage = "running application integration tests";
    console.log("Three private Kubo/Cluster peers ready; running application integration tests.");
    await runSuite(kubo[0]!, cluster);
    stage = "replicating independent synthetic ciphertext probe";
    await survivalProbe(kubo, cluster);
  } finally {
    const failedStage = stage;
    stage = "cleaning up fixture-owned resources";
    await cleanup();
    stage = failedStage;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

try {
  await main();
} catch {
  console.error(`Private IPFS integration failed while ${stage}. Docker engine and Linux containers are required; no daemon logs or secrets are emitted.`);
  process.exitCode = 1;
}
