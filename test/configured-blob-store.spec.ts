import { describe, expect, it, vi } from "vitest";
import {
  AzureBlobStore,
  FileBlobStore,
  InMemoryBlobStore,
  S3BlobStore,
  StorageConfigurationError,
  createConfiguredBlobStore,
} from "../src/index.js";

describe("configured store selection", () => {
  it("preserves the local default and supports memory explicitly", async () => {
    expect(await createConfiguredBlobStore({})).toBeInstanceOf(FileBlobStore);
    expect(await createConfiguredBlobStore({ STORAGE_BACKEND: "memory" }))
      .toBeInstanceOf(InMemoryBlobStore);
  });

  it("constructs cloud adapters without fetching credentials or creating resources", async () => {
    expect(await createConfiguredBlobStore({
      STORAGE_BACKEND: "azure",
      AZURE_STORAGE_ACCOUNT_URL: "https://synthetic.blob.core.windows.net",
      AZURE_STORAGE_CONTAINER: "synthetic-records",
    })).toBeInstanceOf(AzureBlobStore);
    expect(await createConfiguredBlobStore({
      STORAGE_BACKEND: "s3", S3_BUCKET: "synthetic-records", AWS_REGION: "us-east-1",
    })).toBeInstanceOf(S3BlobStore);
  });

  it("fails closed instead of falling back when a selected backend is incomplete", async () => {
    for (const env of [
      { STORAGE_BACKEND: "unknown" },
      { STORAGE_BACKEND: "azure" },
      { STORAGE_BACKEND: "s3" },
      { STORAGE_BACKEND: "ipfs" },
      { STORAGE_BACKEND: "azure", AZURE_STORAGE_CONNECTION_STRING: "not-a-real-key" },
    ]) {
      await expect(createConfiguredBlobStore(env)).rejects.toBeInstanceOf(StorageConfigurationError);
    }
  });

  it("never directs emulator credentials to a remote cloud endpoint", async () => {
    await expect(createConfiguredBlobStore({
      STORAGE_BACKEND: "azure", STORAGE_EMULATOR: "true",
      AZURE_STORAGE_ACCOUNT_URL: "https://synthetic.blob.core.windows.net",
      AZURE_STORAGE_CONTAINER: "synthetic-records",
    })).rejects.toThrow("loopback");
    await expect(createConfiguredBlobStore({
      STORAGE_BACKEND: "s3", STORAGE_EMULATOR: "true",
      S3_BUCKET: "synthetic-records", AWS_REGION: "us-east-1",
    })).rejects.toThrow("loopback");
    await expect(createConfiguredBlobStore({
      STORAGE_BACKEND: "s3", STORAGE_EMULATOR: "true",
      S3_BUCKET: "synthetic-records", AWS_REGION: "us-east-1",
      S3_ENDPOINT_URL: "https://remote.example.test",
    })).rejects.toThrow("loopback");
    await expect(createConfiguredBlobStore({
      STORAGE_BACKEND: "ipfs", STORAGE_EMULATOR: "true",
      IPFS_PRIVATE_NETWORK: "true", IPFS_METADATA_BACKEND: "file",
      IPFS_API_URL: "https://remote.example.test",
      IPFS_CLUSTER_API_URL: "http://127.0.0.1:9094",
    })).rejects.toThrow("loopback");
  });

  it("validates resource names and refuses TLS bypass", async () => {
    await expect(createConfiguredBlobStore({
      STORAGE_BACKEND: "azure",
      AZURE_STORAGE_ACCOUNT_URL: "https://synthetic.blob.core.windows.net",
      AZURE_STORAGE_CONTAINER: "../invalid",
    })).rejects.toThrow("container name");
    await expect(createConfiguredBlobStore({
      STORAGE_BACKEND: "s3", S3_BUCKET: "not/a/bucket", AWS_REGION: "us-east-1",
    })).rejects.toThrow("bucket name");
    await expect(createConfiguredBlobStore({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }))
      .rejects.toThrow("TLS certificate validation");
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    try {
      await expect(createConfiguredBlobStore({})).rejects.toThrow("TLS certificate validation");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("requires a private IPFS acknowledgement and durable index outside emulator mode", async () => {
    await expect(createConfiguredBlobStore({ STORAGE_BACKEND: "ipfs" }))
      .rejects.toThrow("IPFS_PRIVATE_NETWORK");
    for (const backend of ["file", "memory", "ipfs"]) {
      await expect(createConfiguredBlobStore({
        STORAGE_BACKEND: "ipfs", IPFS_PRIVATE_NETWORK: "true", IPFS_METADATA_BACKEND: backend,
      })).rejects.toThrow("IPFS metadata");
    }
  });

  it("rejects insufficient replication and missing remote API authentication", async () => {
    const base = {
      STORAGE_BACKEND: "ipfs", IPFS_PRIVATE_NETWORK: "true", IPFS_METADATA_BACKEND: "azure",
      IPFS_API_URL: "https://private-kubo.example.test",
      IPFS_CLUSTER_API_URL: "https://private-cluster.example.test",
    };
    await expect(createConfiguredBlobStore({ ...base, IPFS_REPLICATION_MIN: "1" }))
      .rejects.toThrow("replication");
    await expect(createConfiguredBlobStore({
      ...base, IPFS_REPLICATION_MIN: "3", IPFS_REPLICATION_MAX: "2",
    })).rejects.toThrow("replication");
    await expect(createConfiguredBlobStore(base)).rejects.toThrow("runtime authorization");
  });
});
