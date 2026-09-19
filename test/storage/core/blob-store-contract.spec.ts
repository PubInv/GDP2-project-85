import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { FileBlobStore, InMemoryBlobStore } from "../../../src/index.js";
import { blobStoreContract } from "../../helpers/blob-store-contract.js";

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
  }
});

blobStoreContract("memory", async () => {
  const store = new InMemoryBlobStore();
  return { first: store, second: store };
});

blobStoreContract("file (same-process clients)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gphr-contract-"));
  directories.push(directory);
  return { first: new FileBlobStore(directory), second: new FileBlobStore(directory) };
});
