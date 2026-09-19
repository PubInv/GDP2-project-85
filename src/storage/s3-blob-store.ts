import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  ConcurrentUpdateError,
  ObjectAlreadyExistsError,
  ObjectNotFoundError,
  type BlobStore,
  type StoredObject,
} from "./blob-store.js";
import {
  assertBlobKey,
  decodeStoredObject,
  disposeBody,
  encodeStoredObject,
  nextVersion,
  readBoundedBody,
  requireEtag,
} from "./storage-validation.js";

export interface S3BlobStoreOptions {
  prefix?: string;
  kmsKeyId?: string;
}

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error &&
    typeof error.name === "string" ? error.name : undefined;
}

function isPreconditionFailure(error: unknown): boolean {
  return errorStatus(error) === 412;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "$metadata" in error &&
      typeof error.$metadata === "object" && error.$metadata !== null &&
      "httpStatusCode" in error.$metadata && typeof error.$metadata.httpStatusCode === "number") {
    return error.$metadata.httpStatusCode;
  }
  return undefined;
}

export class S3BlobStore implements BlobStore {
  readonly #prefix: string;
  readonly #kmsKeyId: string | undefined;

  public constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    options: S3BlobStoreOptions = {},
  ) {
    const prefix = options.prefix ?? "";
    if (prefix.length > 512 || (prefix !== "" &&
        !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(prefix))) {
      throw new Error("Invalid storage prefix.");
    }
    if (!bucket || bucket.length > 255 || /[\s/\\]/.test(bucket)) {
      throw new Error("Invalid storage bucket.");
    }
    if (options.kmsKeyId !== undefined && (!options.kmsKeyId ||
        options.kmsKeyId.length > 2048 || /[\s\x00-\x1f\x7f]/.test(options.kmsKeyId))) {
      throw new Error("Invalid storage encryption configuration.");
    }
    this.#prefix = prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
    this.#kmsKeyId = options.kmsKeyId;
  }

  async #read<T>(key: string): Promise<{ stored: StoredObject<T>; etag: string } | undefined> {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: `${this.#prefix}${key}`,
      }), { abortSignal: AbortSignal.timeout(30_000) });
      let etag: string;
      try {
        etag = requireEtag(response.ETag);
      } catch (error) {
        disposeBody(response.Body);
        throw error;
      }
      const text = await readBoundedBody(response.Body, response.ContentLength);
      return { stored: decodeStoredObject<T>(text), etag };
    } catch (error) {
      if (errorName(error) === "NoSuchKey" && errorStatus(error) === 404) return undefined;
      throw error;
    }
  }

  public async read<T>(key: string): Promise<StoredObject<T> | undefined> {
    assertBlobKey(key);
    return (await this.#read<T>(key))?.stored;
  }

  #write(key: string, text: string, condition: { IfNoneMatch: "*" } | { IfMatch: string }) {
    return this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${this.#prefix}${key}`,
      Body: text,
      ContentLength: Buffer.byteLength(text),
      ContentType: "application/json",
      ...condition,
      ...(this.#kmsKeyId ? {
        ServerSideEncryption: "aws:kms" as const,
        SSEKMSKeyId: this.#kmsKeyId,
      } : {}),
    }), { abortSignal: AbortSignal.timeout(30_000) });
  }

  public async create(key: string, value: unknown): Promise<void> {
    assertBlobKey(key);
    const text = encodeStoredObject({ version: 1, value });
    try {
      await this.#write(key, text, { IfNoneMatch: "*" });
    } catch (error) {
      if (errorName(error) === "ConditionalRequestConflict") {
        throw new ConcurrentUpdateError("storage object");
      }
      if (isPreconditionFailure(error)) throw new ObjectAlreadyExistsError("storage object");
      throw error;
    }
  }

  public async compareAndSwap(key: string, expectedVersion: number, value: unknown): Promise<number> {
    assertBlobKey(key);
    const version = nextVersion(expectedVersion);
    const text = encodeStoredObject({ version, value });
    const current = await this.#read(key);
    if (!current) throw new ObjectNotFoundError("storage object");
    if (current.stored.version !== expectedVersion) throw new ConcurrentUpdateError("storage object");
    try {
      await this.#write(key, text, { IfMatch: current.etag });
    } catch (error) {
      if (isPreconditionFailure(error) || errorName(error) === "ConditionalRequestConflict" ||
          errorName(error) === "NoSuchKey") {
        throw new ConcurrentUpdateError("storage object");
      }
      throw error;
    }
    return version;
  }
}
