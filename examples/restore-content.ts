import {
  DistributedBlobStore, StorageConfigurationError, createConfiguredBlobStore,
} from "../src/index.js";

try {
  const key = process.argv[2];
  if (!key || !/^[A-Za-z0-9_-]{32,128}$/.test(key)) {
    throw new StorageConfigurationError("Provide one opaque storage object key to restore.");
  }
  const store = await createConfiguredBlobStore();
  if (!(store instanceof DistributedBlobStore)) {
    throw new StorageConfigurationError("Restoration requires STORAGE_BACKEND=ipfs with a configured backup.");
  }
  await store.restore(key);
  console.log("Encrypted content restored and replication policy confirmed. Metadata was not changed.");
} catch (error) {
  console.error(error instanceof StorageConfigurationError
    ? error.message : "Encrypted content restore failed; no metadata update was attempted.");
  process.exitCode = 1;
}
