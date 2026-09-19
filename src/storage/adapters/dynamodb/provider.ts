import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { StorageProviderFactory } from "../../config/provider.js";
import { StorageConfigurationError, required, storageEndpoint } from "../../config/settings.js";
import { DynamoDbBlobStore } from "./dynamodb-blob-store.js";

export const createStore: StorageProviderFactory = ({ environment: env, emulator }) => {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new StorageConfigurationError("TLS certificate validation must remain enabled.");
  }
  const tableName = required(env, "DYNAMODB_TABLE");
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)) {
    throw new StorageConfigurationError("DYNAMODB_TABLE must be a valid table name.");
  }
  const endpointValue = env.DYNAMODB_ENDPOINT_URL;
  if (emulator && !endpointValue) {
    throw new StorageConfigurationError("DynamoDB emulator mode requires a loopback DYNAMODB_ENDPOINT_URL.");
  }
  const endpoint = endpointValue
    ? storageEndpoint(endpointValue, "DYNAMODB_ENDPOINT_URL", emulator) : undefined;
  if (endpoint && (endpoint.pathname !== "/" ||
      (emulator && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))) {
    throw new StorageConfigurationError("DYNAMODB_ENDPOINT_URL must be an endpoint root; emulator mode requires loopback.");
  }
  const client = new DynamoDBClient({
    region: required(env, "AWS_REGION"),
    maxAttempts: 1,
    ...(endpoint ? { endpoint: endpoint.href } : {}),
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
  });
  return new DynamoDbBlobStore(client, tableName, {
    ...(env.STORAGE_PREFIX ? { prefix: env.STORAGE_PREFIX } : {}),
  });
};
