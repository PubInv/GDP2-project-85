import { S3Client } from "@aws-sdk/client-s3";
import type { StorageProviderFactory } from "../../config/provider.js";
import { StorageConfigurationError, required, storageEndpoint } from "../../config/settings.js";
import { S3BlobStore } from "./s3-blob-store.js";

export const createStore: StorageProviderFactory = ({ environment: env, emulator }) => {
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
};
