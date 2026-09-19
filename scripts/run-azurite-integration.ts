import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No emulator port allocated.");
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  const graceful = await Promise.race([
    exited.then(() => true), delay(3_000, false, { ref: false }),
  ]);
  if (!graceful) {
    child.kill("SIGKILL");
    await Promise.race([
      exited,
      delay(3_000, undefined, { ref: false }).then(() => {
        throw new Error("Emulator child did not terminate.");
      }),
    ]);
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    console.error("Azure integration requires TLS certificate validation to remain enabled.");
    throw new Error("Unsafe TLS configuration.");
  }
  const environment = { ...process.env };
  delete environment.AZURE_STORAGE_CONNECTION_STRING;
  delete environment.AZURE_STORAGE_SAS_TOKEN;
  delete environment.AZURE_LOG_LEVEL;
  delete environment.AZURITE_DB;
  // Azure loggers read this variable when imported, including readiness-request logging.
  delete process.env.AZURE_LOG_LEVEL;
  const { BlobServiceClient, StorageSharedKeyCredential } = await import("@azure/storage-blob");
  const port = await unusedPort();
  const workspace = resolve(".data");
  await mkdir(workspace, { recursive: true });
  const directory = await mkdtemp(join(workspace, "azurite-integration-"));
  const account = "syntheticaccount";
  const key = randomBytes(32).toString("base64");
  const endpoint = `http://127.0.0.1:${port}/${account}`;
  const emulator = spawn(process.execPath, [
    resolve("node_modules/azurite/dist/src/blob/main.js"),
    "--silent", "--disableTelemetry", "--skipApiVersionCheck", "--blobHost", "127.0.0.1",
    "--blobPort", `${port}`, "--location", directory,
  ], {
    env: { ...environment, AZURITE_ACCOUNTS: `${account}:${key}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let emulatorStage = "loading";
  let outputTail = "";
  const observeOutput = (chunk: Buffer): void => {
    // Inspect bounded output only for fixed stage markers; never print emulator logs.
    outputTail = (outputTail + chunk.toString("utf8")).slice(-8192);
    if (outputTail.includes("service successfully listens")) emulatorStage = "listening";
    else if (outputTail.includes("service is starting")) emulatorStage = "binding";
    else if (outputTail.includes("EADDRINUSE")) emulatorStage = "port unavailable";
    else if (outputTail.includes("MODULE_NOT_FOUND")) emulatorStage = "missing dependency";
  };
  emulator.stdout?.on("data", observeOutput);
  emulator.stderr?.on("data", observeOutput);
  let launchFailed = false;
  let interrupted = false;
  let tests: ChildProcess | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      try {
        if (tests) await stop(tests);
      } finally {
        await stop(emulator);
        await rm(directory, { recursive: true, force: true });
      }
    })();
    return cleanupPromise;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted = true;
    void cleanup().then(
      () => process.exit(signal === "SIGINT" ? 130 : 143),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  emulator.once("error", () => { launchFailed = true; });
  try {
    const client = new BlobServiceClient(endpoint, new StorageSharedKeyCredential(account, key), {
      retryOptions: { maxTries: 1, tryTimeoutInMs: 1_000 },
    });
    const container = client.getContainerClient(`synthetic-${randomBytes(8).toString("hex")}`);
    let ready = false;
    const started = Date.now();
    const deadline = started + 120_000;
    let nextProgress = started + 10_000;
    console.log("Launching loopback Azurite with telemetry disabled; startup deadline is 120 seconds.");
    while (Date.now() < deadline) {
      if (interrupted || launchFailed || emulator.exitCode !== null || emulator.signalCode !== null) {
        console.error(`Azurite startup stopped during ${emulatorStage}.`);
        throw new Error("Azurite failed to start.");
      }
      try {
        await container.createIfNotExists({ abortSignal: AbortSignal.timeout(2_000) });
        ready = true;
        break;
      } catch {
        // Startup readiness is the only retry loop; adapter failures are not retried.
        if (Date.now() >= nextProgress) {
          console.log(`Waiting for Azurite readiness (${Math.floor((Date.now() - started) / 1000)} seconds; stage: ${emulatorStage}).`);
          nextProgress = Date.now() + 10_000;
        }
        await delay(250);
      }
    }
    if (!ready) {
      console.error(`Azurite startup deadline exceeded during ${emulatorStage}.`);
      throw new Error("Azurite did not become ready.");
    }
    if (interrupted) throw new Error("Integration cancelled.");
    console.log(`Loopback Azurite ready after ${Math.ceil((Date.now() - started) / 1000)} seconds; running external-provider integration tests.`);
    tests = spawn(process.execPath, [
      resolve("node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts",
    ], {
      env: {
        ...environment,
        STORAGE_INTEGRATION: "true",
        STORAGE_BACKEND: "azure",
        STORAGE_EMULATOR: "true",
        AZURE_STORAGE_ACCOUNT_URL: endpoint,
        AZURE_STORAGE_CONTAINER: container.containerName,
        AZURE_STORAGE_EMULATOR_ACCOUNT: account,
        AZURE_STORAGE_EMULATOR_KEY: key,
      },
      stdio: "inherit",
    });
    const [exitCode] = await once(tests, "exit");
    if (exitCode !== 0) throw new Error("Azure emulator integration tests failed.");
  } finally {
    await cleanup();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

try {
  await main();
} catch {
  console.error("Azure emulator integration failed. Ensure dependencies are installed and loopback ports are available.");
  process.exitCode = 1;
}
