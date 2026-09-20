import type { ContainerClient } from "@azure/storage-blob";
import {
  ConcurrentUpdateError,
  ObjectAlreadyExistsError,
  ObjectNotFoundError,
  type BlobStore,
  type StoredObject,
} from "../../core/blob-store.js";
import {
  assertBlobKey,
  decodeStoredObject,
  disposeBody,
  encodeStoredObject,
  nextVersion,
  readBoundedBody,
  requireEtag,
} from "../../core/storage-validation.js";

function azureCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("details" in error && typeof error.details === "object" && error.details !== null &&
      "errorCode" in error.details && typeof error.details.errorCode === "string") {
    return error.details.errorCode;
  }
  return "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export class AzureBlobStore implements BlobStore {
  public constructor(private readonly container: ContainerClient) {}

  async #read<T>(key: string): Promise<{ stored: StoredObject<T>; etag: string } | undefined> {
    try {
      // Body and ETag must come from the same GET, never a separate properties request.
      const response = await this.container.getBlockBlobClient(key).download(0, undefined, {
        maxRetryRequests: 0,
        abortSignal: AbortSignal.timeout(30_000),
      });
      let etag: string;
      try {
        etag = requireEtag(response.etag);
      } catch (error) {
        disposeBody(response.readableStreamBody);
        throw error;
      }
      const text = await readBoundedBody(response.readableStreamBody, response.contentLength);
      return { stored: decodeStoredObject<T>(text), etag };
    } catch (error) {
      if (azureCode(error) === "BlobNotFound" && typeof error === "object" &&
          error !== null && "statusCode" in error && error.statusCode === 404) return undefined;
      throw error;
    }
  }

  public async read<T>(key: string): Promise<StoredObject<T> | undefined> {
    assertBlobKey(key);
    return (await this.#read<T>(key))?.stored;
  }

  public async create(key: string, value: unknown): Promise<void> {
    assertBlobKey(key);
    const text = encodeStoredObject({ version: 1, value });
    try {
      await this.container.getBlockBlobClient(key).upload(text, Buffer.byteLength(text), {
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: "application/json" },
        abortSignal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const code = azureCode(error);
      if (code === "ConditionNotMet" || code === "BlobAlreadyExists") {
        throw new ObjectAlreadyExistsError("storage object");
      }
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
      await this.container.getBlockBlobClient(key).upload(text, Buffer.byteLength(text), {
        conditions: { ifMatch: current.etag },
        blobHTTPHeaders: { blobContentType: "application/json" },
        abortSignal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const code = azureCode(error);
      if (code === "ConditionNotMet" || code === "BlobNotFound") {
        throw new ConcurrentUpdateError("storage object");
      }
      throw error;
    }
    return version;
  }
}
