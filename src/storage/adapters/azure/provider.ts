import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import type { StorageProviderFactory } from "../../config/provider.js";
import { StorageConfigurationError, required, storageEndpoint } from "../../config/settings.js";
import { AzureBlobStore } from "./azure-blob-store.js";

export const createStore: StorageProviderFactory = ({ environment: env, emulator }) => {
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
      required(env, "AZURE_STORAGE_EMULATOR_ACCOUNT"), required(env, "AZURE_STORAGE_EMULATOR_KEY"),
    )
    : new DefaultAzureCredential();
  const client = new BlobServiceClient(endpoint.href, credential, {
    retryOptions: { maxTries: 1, tryTimeoutInMs: 30_000 },
  });
  return new AzureBlobStore(client.getContainerClient(container));
};
