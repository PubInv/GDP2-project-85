import { resolve } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import type { BlobStore } from "./blob-store.js";
import { FileBlobStore } from "./file-blob-store.js";
import { InMemoryBlobStore } from "./in-memory-blob-store.js";
import { AzureBlobStore } from "./azure-blob-store.js";
import { S3BlobStore } from "./s3-blob-store.js";
import { DistributedBlobStore } from "./distributed-blob-store.js";
import { IpfsClusterClient } from "./ipfs-cluster-client.js";
import {
  StorageConfigurationError,
  flag,
  loadRuntimeSecret,
  positiveInteger,
  required,
  storageBackend,
  storageEndpoint,
  type StorageBackend,
  type StorageEnvironment,
} from "./configuration.js";

export async function createConfiguredBlobStore(
  env: StorageEnvironment = process.env,
): Promise<BlobStore> {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new StorageConfigurationError("TLS certificate validation must remain enabled.");
  }
  const emulator = flag(env, "STORAGE_EMULATOR");
  const backend = storageBackend(env);

  const create = (selected: Exclude<StorageBackend, "ipfs">): BlobStore => {
    switch (selected) {
      case "memory": return new InMemoryBlobStore();
      case "file": return new FileBlobStore(resolve(env.STORAGE_FILE_DIRECTORY ?? ".data/web"));
      case "azure": {
        if (env.AZURE_STORAGE_CONNECTION_STRING || env.AZURE_STORAGE_SAS_TOKEN) {
          throw new StorageConfigurationError("Use Azure workload identity rather than connection strings or SAS tokens.");
        }
        const endpoint = storageEndpoint(
          required(env, "AZURE_STORAGE_ACCOUNT_URL"), "AZURE_STORAGE_ACCOUNT_URL", emulator,
        );
        const container = required(env, "AZURE_STORAGE_CONTAINER");
        if (!/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(container)) {
          throw new StorageConfigurationError("AZURE_STORAGE_CONTAINER must be a valid private container name.");
        }
        if (emulator && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
          throw new StorageConfigurationError("Azure emulator credentials are permitted only on loopback.");
        }
        const credential = emulator
          ? new StorageSharedKeyCredential(
            required(env, "AZURE_STORAGE_EMULATOR_ACCOUNT"),
            required(env, "AZURE_STORAGE_EMULATOR_KEY"),
          )
          : new DefaultAzureCredential();
        const client = new BlobServiceClient(endpoint.href, credential, {
          retryOptions: { maxTries: 1, tryTimeoutInMs: 30_000 },
        });
        return new AzureBlobStore(client.getContainerClient(container));
      }
      case "s3": {
        const bucket = required(env, "S3_BUCKET");
        if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
            bucket.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
          throw new StorageConfigurationError("S3_BUCKET must be a valid general-purpose bucket name.");
        }
        const endpointValue = env.S3_ENDPOINT_URL;
        if (emulator && !endpointValue) {
          throw new StorageConfigurationError("S3 emulator mode requires a loopback S3_ENDPOINT_URL.");
        }
        const endpoint = endpointValue
          ? storageEndpoint(endpointValue, "S3_ENDPOINT_URL", emulator) : undefined;
        if (endpoint && (endpoint.pathname !== "/" ||
            (emulator && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))) {
          throw new StorageConfigurationError("S3_ENDPOINT_URL must be an endpoint root; emulator mode requires loopback.");
        }
        const client = new S3Client({
          region: required(env, "AWS_REGION"),
          maxAttempts: 1,
          ...(endpoint ? { endpoint: endpoint.href, forcePathStyle: true } : {}),
          requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
        });
        return new S3BlobStore(client, bucket, {
          ...(env.STORAGE_PREFIX ? { prefix: env.STORAGE_PREFIX } : {}),
          ...(env.S3_KMS_KEY_ID ? { kmsKeyId: env.S3_KMS_KEY_ID } : {}),
        });
      }
    }
  };

  if (backend !== "ipfs") return create(backend);
  if (!flag(env, "IPFS_PRIVATE_NETWORK")) {
    throw new StorageConfigurationError("IPFS_PRIVATE_NETWORK=true must acknowledge a separately provisioned private swarm.");
  }
  const metadataBackend = storageBackend(env, "IPFS_METADATA_BACKEND", "azure");
  if (metadataBackend === "ipfs" || metadataBackend === "memory" ||
      (metadataBackend === "file" && !emulator)) {
    throw new StorageConfigurationError("IPFS metadata requires azure or s3; file is allowed only in local emulator mode.");
  }
  const kubo = storageEndpoint(required(env, "IPFS_API_URL"), "IPFS_API_URL", emulator);
  const cluster = storageEndpoint(required(env, "IPFS_CLUSTER_API_URL"), "IPFS_CLUSTER_API_URL", emulator);
  if (emulator && [kubo, cluster].some((url) =>
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new StorageConfigurationError("IPFS emulator mode requires loopback endpoints.");
  }
  const min = positiveInteger(env, "IPFS_REPLICATION_MIN", 2);
  const max = positiveInteger(env, "IPFS_REPLICATION_MAX", 3);
  if (max < min || (!emulator && min < 2)) {
    throw new StorageConfigurationError("IPFS replication requires max >= min and at least two copies outside emulator mode.");
  }
  const apiAuth = await loadRuntimeSecret(env, "IPFS_API_AUTH");
  const clusterAuth = await loadRuntimeSecret(env, "IPFS_CLUSTER_AUTH");
  if (!emulator && (!apiAuth || !clusterAuth)) {
    throw new StorageConfigurationError("Remote IPFS APIs require runtime authorization from secret files or Key Vault.");
  }
  const content = new IpfsClusterClient({
    kuboUrl: kubo.href,
    clusterUrl: cluster.href,
    minReplicas: min,
    maxReplicas: max,
    timeoutMs: positiveInteger(env, "IPFS_TIMEOUT_MS", 30_000),
    allowInsecureLocal: emulator,
    ...(apiAuth ? { kuboAuthorization: apiAuth } : {}),
    ...(clusterAuth ? { clusterAuthorization: clusterAuth } : {}),
  });
  return new DistributedBlobStore(create(metadataBackend), content);
}
