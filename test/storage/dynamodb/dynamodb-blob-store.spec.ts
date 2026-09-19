import { Readable } from "node:stream";
import { DynamoDBClient, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConcurrentUpdateError,
  DynamoDbBlobStore,
  ObjectAlreadyExistsError,
  ObjectNotFoundError,
  StorageConfigurationError,
  type StorageEnvironment,
} from "../../../src/index.js";
import {
  MAX_DYNAMODB_PAYLOAD_BYTES,
} from "../../../src/storage/adapters/dynamodb/dynamodb-blob-store.js";
import { createStore } from "../../../src/storage/adapters/dynamodb/provider.js";
import { blobStoreContract } from "../../helpers/blob-store-contract.js";

const key = "d".repeat(43);
const ciphertext = { algorithm: "AES-256-GCM", ciphertext: "synthetic+/==_-", nonce: "opaque" };

interface Request {
  headers: Record<string, string>;
  body?: unknown;
}

interface RequestBody {
  TableName: string;
  Key?: Record<string, AttributeValue>;
  Item?: Record<string, AttributeValue>;
  ConsistentRead?: boolean;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  ReturnValues?: string;
  ReturnValuesOnConditionCheckFailure?: string;
}

class DynamoTransport {
  readonly requests: { operation: string; input: RequestBody }[] = [];
  readonly items = new Map<string, Record<string, AttributeValue>>();
  error: string | undefined;
  writeError: string | undefined;
  networkError: Error | undefined;
  loseWriteResponse = false;
  deleteBeforeWrite = false;

  async handle(request: Request) {
    const text = typeof request.body === "string" ? request.body
      : request.body instanceof Uint8Array ? new TextDecoder().decode(request.body) : undefined;
    if (text === undefined) throw new Error("Unexpected request body.");
    const input = JSON.parse(text) as RequestBody;
    const operation = request.headers["x-amz-target"]?.split(".").at(-1) ?? "";
    this.requests.push({ operation, input });
    const response = (body: object, statusCode = 200) => ({
      response: {
        statusCode,
        headers: { "content-type": "application/x-amz-json-1.0" },
        body: Readable.from([Buffer.from(JSON.stringify(body))]),
      },
    });
    const failure = (name: string) => response({
      __type: `com.amazonaws.dynamodb.v20120810#${name}`,
      message: "Storage request failed.",
    }, 400);
    if (this.networkError) throw this.networkError;
    if (this.error) return failure(this.error);
    if (operation === "GetItem") {
      const id = input.Key?.key?.S;
      if (!id) throw new Error("Missing request key.");
      const item = this.items.get(id);
      return response(item === undefined ? {} : { Item: item });
    }
    if (operation !== "PutItem" || !input.Item?.key?.S) {
      throw new Error("Unexpected storage request.");
    }
    if (this.writeError) return failure(this.writeError);
    const id = input.Item.key.S;
    if (this.deleteBeforeWrite) this.items.delete(id);
    if (input.ConditionExpression === "attribute_not_exists(#key)") {
      if (input.ExpressionAttributeNames?.["#key"] !== "key") throw new Error("Invalid create condition.");
      if (this.items.has(id)) return failure("ConditionalCheckFailedException");
    } else if (input.ConditionExpression === "#version = :expected") {
      if (input.ExpressionAttributeNames?.["#version"] !== "version" ||
          !input.ExpressionAttributeValues?.[":expected"]?.N) throw new Error("Invalid CAS condition.");
      if (this.items.get(id)?.version?.N !== input.ExpressionAttributeValues[":expected"].N) {
        return failure("ConditionalCheckFailedException");
      }
    } else {
      throw new Error("Unconditional writes are prohibited.");
    }
    this.items.set(id, input.Item);
    if (this.loseWriteResponse) throw new Error("Connection reset.");
    return response({});
  }
}

function fixture(transport = new DynamoTransport(), prefix?: string) {
  const client = new DynamoDBClient({
    region: "us-east-1",
    credentials: { accessKeyId: "synthetic-access-key", secretAccessKey: "synthetic-secret-key" },
    maxAttempts: 1,
    requestHandler: transport,
  });
  return {
    transport, client,
    store: new DynamoDbBlobStore(client, "synthetic-table", prefix === undefined ? {} : { prefix }),
  };
}

function row(version = 1, value: unknown = ciphertext): Record<string, AttributeValue> {
  return {
    key: { S: key },
    version: { N: String(version) },
    payload: { S: JSON.stringify({ version, value }) },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

blobStoreContract("DynamoDB independent SDK clients", async () => {
  const { transport, store } = fixture();
  return { first: store, second: fixture(transport).store };
});

describe("DynamoDbBlobStore", () => {
  it("persists exact opaque JSON and uses strongly consistent reads and conditional writes", async () => {
    const { store, transport } = fixture();
    await store.create(key, ciphertext);
    expect(transport.items.get(key)).toEqual(row());
    expect(transport.requests[0]?.input).toMatchObject({
      TableName: "synthetic-table",
      ConditionExpression: "attribute_not_exists(#key)",
      ExpressionAttributeNames: { "#key": "key" },
      ReturnValues: "NONE",
      ReturnValuesOnConditionCheckFailure: "NONE",
    });
    expect(await store.read(key)).toEqual({ version: 1, value: ciphertext });
    await expect(store.compareAndSwap(key, 1, { ciphertext: "next" })).resolves.toBe(2);
    for (const request of transport.requests.filter((request) => request.operation === "GetItem")) {
      expect(request.input).toMatchObject({ ConsistentRead: true, Key: { key: { S: key } } });
    }
    expect(transport.requests.at(-1)?.input).toMatchObject({
      ConditionExpression: "#version = :expected",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":expected": { N: "1" } },
      Item: { version: { N: "2" } },
    });
  });

  it("maps creation and CAS conflicts without mutating the winner", async () => {
    const { store, transport } = fixture();
    await store.create(key, ciphertext);
    await expect(store.create(key, null)).rejects.toBeInstanceOf(ObjectAlreadyExistsError);
    transport.writeError = "ConditionalCheckFailedException";
    await expect(store.compareAndSwap(key, 1, null)).rejects.toBeInstanceOf(ConcurrentUpdateError);
    expect(transport.items.get(key)).toEqual(row());
  });

  it("has one winner when both independent clients read the same version", async () => {
    const { transport, store } = fixture();
    await store.create(key, ciphertext);
    const second = fixture(transport).store;
    const results = await Promise.allSettled([
      store.compareAndSwap(key, 1, { ciphertext: "first" }),
      second.compareAndSwap(key, 1, { ciphertext: "second" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(ConcurrentUpdateError),
    });
    expect(transport.requests.filter((request) => request.input.ConditionExpression === "#version = :expected"))
      .toHaveLength(2);
  });

  it("does not recreate an item deleted between read and conditional update", async () => {
    const { transport, store } = fixture();
    await store.create(key, ciphertext);
    transport.deleteBeforeWrite = true;
    await expect(store.compareAndSwap(key, 1, null)).rejects.toBeInstanceOf(ConcurrentUpdateError);
    expect(transport.items.has(key)).toBe(false);
  });

  it("does not confuse missing items with missing tables, permissions, or throttling", async () => {
    const { transport, store } = fixture();
    await expect(store.read(key)).resolves.toBeUndefined();
    await expect(store.compareAndSwap(key, 1, null)).rejects.toBeInstanceOf(ObjectNotFoundError);
    for (const error of ["ResourceNotFoundException", "AccessDeniedException", "ProvisionedThroughputExceededException"]) {
      transport.error = error;
      const before = transport.requests.length;
      await expect(store.read(key)).rejects.toMatchObject({ name: error });
      await expect(store.create(key, null)).rejects.toMatchObject({ name: error });
      await expect(store.compareAndSwap(key, 1, null)).rejects.toMatchObject({ name: error });
      expect(transport.requests.length - before).toBe(3);
    }
  });

  it("propagates transport and CAS write errors without read-back or retries", async () => {
    const { transport, store } = fixture();
    transport.networkError = new Error("Synthetic network failure.");
    await expect(store.read(key)).rejects.toBe(transport.networkError);
    await expect(store.create(key, ciphertext)).rejects.toBe(transport.networkError);
    transport.networkError = undefined;
    await store.create(key, ciphertext);
    for (const name of ["ResourceNotFoundException", "AccessDeniedException", "ProvisionedThroughputExceededException"]) {
      transport.writeError = name;
      const before = transport.requests.length;
      await expect(store.compareAndSwap(key, 1, null)).rejects.toMatchObject({ name });
      expect(transport.requests.length - before).toBe(2);
    }
  });

  it("fails ambiguous create and CAS outcomes even when the write was committed", async () => {
    const { transport, store } = fixture();
    transport.loseWriteResponse = true;
    await expect(store.create(key, ciphertext)).rejects.toThrow("Connection reset.");
    expect(transport.requests).toHaveLength(1);
    expect(transport.items.get(key)).toEqual(row());
    await expect(store.compareAndSwap(key, 1, { ciphertext: "next" })).rejects.toThrow("Connection reset.");
    expect(transport.requests).toHaveLength(3);
    expect(transport.items.get(key)?.version).toEqual({ N: "2" });
  });

  it.each([
    {}, { ...row(), key: { S: "other" } }, { ...row(), key: { N: "1" } },
    { key: { S: key }, version: { N: "1" } },
    { ...row(), payload: { N: "1" } }, { ...row(), version: { S: "1" } },
    { ...row(), version: { N: "0" } }, { ...row(), version: { N: "-1" } },
    { ...row(), version: { N: "1.5" } }, { ...row(), version: { N: "NaN" } },
    { ...row(), version: { N: "9007199254740992" } },
    { ...row(), version: { N: "2" } }, { ...row(), payload: { S: "not-json" } },
    { ...row(), payload: { S: '{"version":1}' } },
    { ...row(), payload: { S: '{"version":0,"value":null}' } },
  ])("rejects malformed or mismatched items before CAS writes (%#)", async (item) => {
    const { transport, store } = fixture();
    transport.items.set(key, item);
    await expect(store.read(key)).rejects.toThrow();
    await expect(store.compareAndSwap(key, 1, null)).rejects.toThrow();
    expect(transport.requests.every((request) => request.operation === "GetItem")).toBe(true);
  });

  it("accepts exactly 350 KiB of UTF-8 payload and rejects oversized reads and writes", async () => {
    const { transport, store } = fixture();
    const overhead = Buffer.byteLength(JSON.stringify({ version: 1, value: "" }));
    const exact = "x".repeat(MAX_DYNAMODB_PAYLOAD_BYTES - overhead);
    await store.create(key, exact);
    expect(Buffer.byteLength(transport.items.get(key)?.payload?.S ?? "")).toBe(MAX_DYNAMODB_PAYLOAD_BYTES);
    expect((await store.read<string>(key))?.value).toBe(exact);
    const before = transport.requests.length;
    for (const value of [exact + "x", "é".repeat(MAX_DYNAMODB_PAYLOAD_BYTES / 2)]) {
      await expect(store.create(key, value)).rejects.toThrow("size limit");
      await expect(store.compareAndSwap(key, 1, value)).rejects.toThrow("size limit");
    }
    expect(transport.requests).toHaveLength(before);
    transport.items.set(key, row(1, exact + "x"));
    await expect(store.read(key)).rejects.toThrow("size limit");
  });

  it("normalizes bounded prefixes and preserves opaque keys", async () => {
    for (const prefix of ["synthetic-integration", "synthetic-integration/", "opaque/nested/"]) {
      const { transport, store } = fixture(new DynamoTransport(), prefix);
      await store.create(key, ciphertext);
      expect(await store.read(key)).toEqual({ version: 1, value: ciphertext });
      const qualified = `${prefix.replace(/\/$/, "")}/${key}`;
      expect(transport.items.has(qualified)).toBe(true);
    }
    const { client } = fixture();
    for (const prefix of ["../", "a/../b", "/root", "a//b", "a\\b", "a%2fb", "x".repeat(513)]) {
      expect(() => new DynamoDbBlobStore(client, "synthetic-table", { prefix })).toThrow("prefix");
    }
    for (const table of ["ab", "x".repeat(256), "table/name", "table name"]) {
      expect(() => new DynamoDbBlobStore(client, table)).toThrow("table");
    }
  });

  it("rejects invalid keys, versions, and unsupported JSON before network I/O", async () => {
    const { transport, store } = fixture();
    for (const badKey of ["short", "../" + key, key + "/", "x".repeat(129), "é".repeat(32)]) {
      await expect(store.read(badKey)).rejects.toThrow("key");
      await expect(store.create(badKey, null)).rejects.toThrow("key");
      await expect(store.compareAndSwap(badKey, 1, null)).rejects.toThrow("key");
    }
    for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(store.compareAndSwap(key, version, null)).rejects.toThrow("version");
    }
    const circular: { self?: object } = {};
    circular.self = circular;
    for (const value of [undefined, { missing: undefined }, [undefined], [,], NaN, Infinity, -0,
      1n, () => null, Symbol("synthetic"), new Date(0), new Map(), circular, new Proxy({}, {})]) {
      await expect(store.create(key, value)).rejects.toThrow("Invalid or oversized storage object.");
      await expect(store.compareAndSwap(key, 1, value)).rejects.toThrow("Invalid or oversized storage object.");
    }
    expect(transport.requests).toHaveLength(0);
  });

  it("allows the final safe version but rejects its increment", async () => {
    const { transport, store } = fixture();
    transport.items.set(key, row(Number.MAX_SAFE_INTEGER - 1));
    expect(await store.compareAndSwap(key, Number.MAX_SAFE_INTEGER - 1, null)).toBe(Number.MAX_SAFE_INTEGER);
    expect((await store.read(key))?.version).toBe(Number.MAX_SAFE_INTEGER);
    const before = transport.requests.length;
    await expect(store.compareAndSwap(key, Number.MAX_SAFE_INTEGER, null)).rejects.toThrow("version limit");
    expect(transport.requests).toHaveLength(before);
  });
});

function configured(environment: StorageEnvironment, emulator = false) {
  return createStore({
    environment, emulator,
    createStore: async () => { throw new Error("Unexpected nested provider."); },
  });
}

describe("DynamoDB provider", () => {
  const environment = { DYNAMODB_TABLE: "synthetic-table", AWS_REGION: "us-east-1" };

  it("uses the default credential provider and disables retries", async () => {
    const send = vi.spyOn(DynamoDBClient.prototype, "send").mockImplementation(async () => ({ $metadata: {} }));
    const store = await configured(environment);
    expect(store).toBeInstanceOf(DynamoDbBlobStore);
    await expect(store.read(key)).resolves.toBeUndefined();
    const client = send.mock.contexts[0];
    if (!(client instanceof DynamoDBClient)) throw new Error("Missing configured SDK client.");
    expect(await client.config.maxAttempts()).toBe(1);
    expect(await client.config.region()).toBe("us-east-1");
    expect(typeof client.config.credentials).toBe("function");
    client.destroy();
  });

  it("accepts explicit secure endpoints and loopback emulators with prefixes", async () => {
    for (const [endpoint, emulator] of [
      ["https://dynamodb.us-east-1.amazonaws.com", false],
      ["http://127.0.0.1:8000", true],
      ["http://localhost:8000", true],
      ["http://[::1]:8000", true],
    ] as const) {
      const store = await configured({ ...environment, DYNAMODB_ENDPOINT_URL: endpoint, STORAGE_PREFIX: "synthetic/" }, emulator);
      expect(store).toBeInstanceOf(DynamoDbBlobStore);
    }
  });

  it.each([
    { DYNAMODB_TABLE: "", AWS_REGION: "us-east-1" },
    { DYNAMODB_TABLE: "synthetic-table", AWS_REGION: "" },
    { ...environment, DYNAMODB_TABLE: "invalid/table" },
    { ...environment, DYNAMODB_ENDPOINT_URL: "http://remote.invalid" },
    { ...environment, DYNAMODB_ENDPOINT_URL: "http://127.0.0.1:8000" },
    { ...environment, DYNAMODB_ENDPOINT_URL: "https://example.invalid/path" },
    { ...environment, DYNAMODB_ENDPOINT_URL: "https://example.invalid/?query=value" },
    { ...environment, DYNAMODB_ENDPOINT_URL: "https://user:synthetic@example.invalid/" },
    { ...environment, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  ])("fails closed on invalid provider configuration (%#)", async (env) => {
    await expect(async () => configured(env)).rejects.toBeInstanceOf(StorageConfigurationError);
  });

  it("requires loopback endpoints for emulator mode and keeps process TLS enabled", async () => {
    await expect(async () => configured(environment, true)).rejects.toBeInstanceOf(StorageConfigurationError);
    await expect(async () => configured({
      ...environment, DYNAMODB_ENDPOINT_URL: "https://remote.invalid",
    }, true)).rejects.toBeInstanceOf(StorageConfigurationError);
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    await expect(async () => configured(environment)).rejects.toBeInstanceOf(StorageConfigurationError);
  });
});
