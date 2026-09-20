import {
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  ConcurrentUpdateError,
  ObjectAlreadyExistsError,
  ObjectNotFoundError,
  type BlobStore,
  type StoredObject,
} from "../../core/blob-store.js";
import {
  assertBlobKey,
  assertExpectedVersion,
  decodeStoredObject,
  encodeStoredObject,
  nextVersion,
} from "../../core/storage-validation.js";

export const MAX_DYNAMODB_PAYLOAD_BYTES = 350 * 1024;

export interface DynamoDbBlobStoreOptions {
  prefix?: string;
}

function assertPayloadSize(payload: string): void {
  if (Buffer.byteLength(payload, "utf8") > MAX_DYNAMODB_PAYLOAD_BYTES) {
    throw new Error("Storage object exceeds item size limit.");
  }
}

function conditionFailed(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "name" in error && error.name === "ConditionalCheckFailedException";
}

function stringAttribute(attribute: AttributeValue | undefined): string {
  if (attribute === undefined || attribute === null || typeof attribute.S !== "string" ||
      Object.keys(attribute).length !== 1) {
    throw new Error("Invalid stored item.");
  }
  return attribute.S;
}

/** Requires a single-region table with only the string partition key `key`. */
export class DynamoDbBlobStore implements BlobStore {
  readonly #prefix: string;

  public constructor(
    private readonly client: DynamoDBClient,
    private readonly tableName: string,
    options: DynamoDbBlobStoreOptions = {},
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)) {
      throw new Error("Invalid storage table.");
    }
    const prefix = options.prefix ?? "";
    if (prefix.length > 512 || (prefix !== "" &&
        !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(prefix))) {
      throw new Error("Invalid storage prefix.");
    }
    this.#prefix = prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
  }

  public async read<T>(key: string): Promise<StoredObject<T> | undefined> {
    assertBlobKey(key);
    const qualifiedKey = `${this.#prefix}${key}`;
    const response = await this.client.send(new GetItemCommand({
      TableName: this.tableName,
      Key: { key: { S: qualifiedKey } },
      ConsistentRead: true,
    }), { abortSignal: AbortSignal.timeout(30_000) });
    const item = response.Item;
    if (item === undefined) return undefined;
    if (item === null || !Object.hasOwn(item, "key") || !Object.hasOwn(item, "version") ||
        !Object.hasOwn(item, "payload") || stringAttribute(item.key) !== qualifiedKey) {
      throw new Error("Invalid stored item.");
    }
    const rowVersion = item.version?.N;
    if (typeof rowVersion !== "string" || !/^[1-9]\d{0,15}$/.test(rowVersion) ||
        Object.keys(item.version ?? {}).length !== 1) {
      throw new Error("Invalid stored item version.");
    }
    const version = Number(rowVersion);
    assertExpectedVersion(version);
    const payload = stringAttribute(item.payload);
    assertPayloadSize(payload);
    const stored = decodeStoredObject<T>(payload);
    if (stored.version !== version) throw new Error("Stored item version mismatch.");
    return stored;
  }

  public async create(key: string, value: unknown): Promise<void> {
    assertBlobKey(key);
    const payload = encodeStoredObject({ version: 1, value });
    assertPayloadSize(payload);
    try {
      await this.client.send(new PutItemCommand({
        TableName: this.tableName,
        Item: {
          key: { S: `${this.#prefix}${key}` },
          version: { N: "1" },
          payload: { S: payload },
        },
        ConditionExpression: "attribute_not_exists(#key)",
        ExpressionAttributeNames: { "#key": "key" },
        ReturnValues: "NONE",
        ReturnValuesOnConditionCheckFailure: "NONE",
      }), { abortSignal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (conditionFailed(error)) throw new ObjectAlreadyExistsError("storage object");
      throw error;
    }
  }

  public async compareAndSwap(key: string, expectedVersion: number, value: unknown): Promise<number> {
    assertBlobKey(key);
    const version = nextVersion(expectedVersion);
    const payload = encodeStoredObject({ version, value });
    assertPayloadSize(payload);
    const current = await this.read(key);
    if (current === undefined) throw new ObjectNotFoundError("storage object");
    if (current.version !== expectedVersion) throw new ConcurrentUpdateError("storage object");
    try {
      await this.client.send(new PutItemCommand({
        TableName: this.tableName,
        Item: {
          key: { S: `${this.#prefix}${key}` },
          version: { N: String(version) },
          payload: { S: payload },
        },
        ConditionExpression: "#version = :expected",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":expected": { N: String(expectedVersion) } },
        ReturnValues: "NONE",
        ReturnValuesOnConditionCheckFailure: "NONE",
      }), { abortSignal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (conditionFailed(error)) throw new ConcurrentUpdateError("storage object");
      throw error;
    }
    return version;
  }
}
