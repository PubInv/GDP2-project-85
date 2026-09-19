import type { StorageProviderFactory } from "../../config/provider.js";
import {
  StorageConfigurationError, flag, positiveInteger, providerName, required, storageEndpoint,
} from "../../config/settings.js";
import { loadRuntimeSecret } from "../../config/secrets.js";
import { DistributedBlobStore, type DistributedContentStore } from "./distributed-blob-store.js";
import { IpfsClusterClient } from "./ipfs-cluster-client.js";
import { BackedUpContentStore } from "./backed-up-content-store.js";

export const createStore: StorageProviderFactory = async ({
  environment: env, emulator, createStore: createDependency,
}) => {
  if (!flag(env, "IPFS_PRIVATE_NETWORK")) {
    throw new StorageConfigurationError("IPFS_PRIVATE_NETWORK=true must acknowledge a separately provisioned private swarm.");
  }
  const metadataBackend = providerName(env, "IPFS_METADATA_BACKEND", "azure");
  if (metadataBackend === "ipfs" || metadataBackend === "memory" ||
      (metadataBackend === "file" && !emulator)) {
    throw new StorageConfigurationError("IPFS metadata requires a durable atomic provider; file is allowed only in local emulator mode.");
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
    throw new StorageConfigurationError("Remote IPFS APIs require runtime authorization from secret files, Key Vault, or Secrets Manager.");
  }
  let content: DistributedContentStore = new IpfsClusterClient({
    kuboUrl: kubo.href,
    clusterUrl: cluster.href,
    minReplicas: min,
    maxReplicas: max,
    timeoutMs: positiveInteger(env, "IPFS_TIMEOUT_MS", 30_000),
    allowInsecureLocal: emulator,
    ...(apiAuth ? { kuboAuthorization: apiAuth } : {}),
    ...(clusterAuth ? { clusterAuthorization: clusterAuth } : {}),
  });
  if (env.IPFS_BACKUP_BACKEND !== undefined) {
    const backupBackend = providerName(env, "IPFS_BACKUP_BACKEND");
    if (backupBackend === "ipfs" || backupBackend === "dynamodb" ||
        (!emulator && ["file", "memory"].includes(backupBackend))) {
      throw new StorageConfigurationError("IPFS backups require a separate durable object store.");
    }
    if (!emulator && backupBackend === "s3") required(env, "S3_KMS_KEY_ID");
    content = new BackedUpContentStore(content, await createDependency(backupBackend));
  }
  return new DistributedBlobStore(await createDependency(metadataBackend), content);
};
