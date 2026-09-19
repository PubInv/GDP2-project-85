import { describe, expect, it, vi } from "vitest";
import * as secrets from "../../../src/storage/config/secrets.js";
import {
  AzureBlobStore,
  DistributedBlobStore,
  DynamoDbBlobStore,
  FileBlobStore,
  InMemoryBlobStore,
  S3BlobStore,
  StorageConfigurationError,
  createConfiguredBlobStore,
} from "../../../src/index.js";

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    async getToken(): Promise<never> {
      throw new Error("Provider construction must not fetch credentials.");
    }
  },
}));

describe("configured store selection", () => {
  it("composes independently registered IPFS index and backup providers", async () => {
    const index = vi.fn(() => new InMemoryBlobStore());
    const backup = vi.fn(() => new InMemoryBlobStore());
    const store = await createConfiguredBlobStore({
      STORAGE_BACKEND: "ipfs", STORAGE_EMULATOR: "true", IPFS_PRIVATE_NETWORK: "true",
      IPFS_API_URL: "http://127.0.0.1:5001", IPFS_CLUSTER_API_URL: "http://127.0.0.1:9094",
      IPFS_METADATA_BACKEND: "test-index", IPFS_BACKUP_BACKEND: "test-backup",
    }, { providers: { "test-index": index, "test-backup": backup } });
    expect(store).toBeInstanceOf(DistributedBlobStore);
    expect(index).toHaveBeenCalledOnce();
    expect(backup).toHaveBeenCalledOnce();
  });

  it("rejects recursive or metadata-only backup providers", async () => {
    for (const provider of ["ipfs", "dynamodb"]) {
      await expect(createConfiguredBlobStore({
        STORAGE_BACKEND: "ipfs", STORAGE_EMULATOR: "true", IPFS_PRIVATE_NETWORK: "true",
        IPFS_API_URL: "http://127.0.0.1:5001", IPFS_CLUSTER_API_URL: "http://127.0.0.1:9094",
        IPFS_METADATA_BACKEND: "file", IPFS_BACKUP_BACKEND: provider,
      })).rejects.toThrow("separate durable object store");
    }
  });

  it("requires SSE-KMS for remote S3 backups without fetching cloud credentials", async () => {
    const authorization = vi.spyOn(secrets, "loadRuntimeSecret").mockResolvedValue("synthetic-header");
    const env = {
      STORAGE_BACKEND: "ipfs", IPFS_PRIVATE_NETWORK: "true",
      IPFS_API_URL: "https://private-kubo.example.test",
      IPFS_CLUSTER_API_URL: "https://private-cluster.example.test",
      IPFS_METADATA_BACKEND: "dynamodb", IPFS_BACKUP_BACKEND: "s3",
      DYNAMODB_TABLE: "synthetic-metadata", S3_BUCKET: "synthetic-backups",
      AWS_REGION: "us-east-1",
    };
    try {
      await expect(createConfiguredBlobStore(env)).rejects.toThrow("S3_KMS_KEY_ID");
      expect(await createConfiguredBlobStore({
        ...env, S3_KMS_KEY_ID: "alias/synthetic-backup",
      })).toBeInstanceOf(DistributedBlobStore);
    } finally {
      authorization.mockRestore();
    }
  });

  it("selects a registered implementation without touching unused providers", async () => {
    const instance = new InMemoryBlobStore();
    const selected = vi.fn(() => instance);
    const unused = vi.fn(() => { throw new Error("Must not initialize an unused provider."); });
    expect(await createConfiguredBlobStore(
      { STORAGE_BACKEND: "custom" },
      { providers: { custom: selected, unused } },
    )).toBe(instance);
    expect(selected).toHaveBeenCalledOnce();
    expect(unused).not.toHaveBeenCalled();
  });

  it("allows composition through the registry and snapshots configuration", async () => {
    const env = { STORAGE_BACKEND: "composed", STORAGE_FILE_DIRECTORY: ".data/custom" };
    const store = await createConfiguredBlobStore(env, {
      providers: {
        composed: async ({ environment, emulator, createStore }) => {
          expect(Object.isFrozen(environment)).toBe(true);
          expect(emulator).toBe(false);
          expect(environment.STORAGE_FILE_DIRECTORY).toBe(".data/custom");
          return createStore("memory");
        },
      },
    });
    expect(store).toBeInstanceOf(InMemoryBlobStore);
  });

  it("rejects self-dependencies, transitive cycles, and unknown dependencies", async () => {
    await expect(createConfiguredBlobStore({ STORAGE_BACKEND: "cycle" }, {
      providers: { cycle: ({ createStore }) => createStore("cycle") },
    })).rejects.toThrow("dependency cycle");
    await expect(createConfiguredBlobStore({ STORAGE_BACKEND: "first" }, {
      providers: {
        first: ({ createStore }) => createStore("second"),
        second: ({ createStore }) => createStore("first"),
      },
    })).rejects.toThrow("dependency cycle");
    await expect(createConfiguredBlobStore({ STORAGE_BACKEND: "custom" }, {
      providers: { custom: ({ createStore }) => createStore("missing") },
    })).rejects.toThrow("Unknown storage backend");
  });

  it("does not silently override built-ins or accept inherited provider names", async () => {
    await expect(createConfiguredBlobStore({}, {
      providers: { azure: () => new InMemoryBlobStore() },
    })).rejects.toThrow("distinct non-builtin names");
    await expect(createConfiguredBlobStore({ STORAGE_BACKEND: "constructor" }))
      .rejects.toThrow("Unknown storage backend");
    await expect(createConfiguredBlobStore({}, {
      providers: { "../bad": () => new InMemoryBlobStore() },
    })).rejects.toThrow("lowercase provider name");
  });

  it("propagates selected-provider failures without falling back", async () => {
    const error = new Error("synthetic provider unavailable");
    await expect(createConfiguredBlobStore({ STORAGE_BACKEND: "custom" }, {
      providers: { custom: () => { throw error; } },
    })).rejects.toBe(error);
  });

  it("does not require cloud configuration when the local provider is selected", async () => {
    expect(await createConfiguredBlobStore({
      STORAGE_BACKEND: "file",
      AZURE_STORAGE_ACCOUNT_URL: "not-a-url",
      S3_BUCKET: "../invalid",
      IPFS_API_URL: "http://untrusted.test",
    })).toBeInstanceOf(FileBlobStore);
  });

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
    expect(await createConfiguredBlobStore({
      STORAGE_BACKEND: "dynamodb", DYNAMODB_TABLE: "synthetic-metadata", AWS_REGION: "us-east-1",
    })).toBeInstanceOf(DynamoDbBlobStore);
  }, 15_000);

  it("composes the AWS hybrid without cloud calls at construction", async () => {
    expect(await createConfiguredBlobStore({
      STORAGE_BACKEND: "ipfs", STORAGE_EMULATOR: "true", IPFS_PRIVATE_NETWORK: "true",
      IPFS_API_URL: "http://127.0.0.1:5001", IPFS_CLUSTER_API_URL: "http://127.0.0.1:9094",
      IPFS_METADATA_BACKEND: "dynamodb", IPFS_BACKUP_BACKEND: "s3",
      DYNAMODB_TABLE: "synthetic-metadata", DYNAMODB_ENDPOINT_URL: "http://127.0.0.1:8000",
      S3_BUCKET: "synthetic-backups", S3_ENDPOINT_URL: "http://127.0.0.1:9000",
      AWS_REGION: "us-east-1",
    })).toBeInstanceOf(DistributedBlobStore);
  });

  it("fails closed instead of falling back when a selected backend is incomplete", async () => {
    for (const env of [
      { STORAGE_BACKEND: "unknown" },
      { STORAGE_BACKEND: "azure" },
      { STORAGE_BACKEND: "s3" },
      { STORAGE_BACKEND: "dynamodb" },
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
