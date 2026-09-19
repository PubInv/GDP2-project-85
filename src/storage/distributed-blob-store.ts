import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import {
  ConcurrentUpdateError,
  ObjectNotFoundError,
  type BlobStore,
  type StoredObject,
} from "./blob-store.js";
import {
  assertBlobKey,
  decodeStoredObject,
  encodeStoredObject,
  nextVersion,
} from "./storage-validation.js";

export const MAX_DISTRIBUTED_BLOB_BYTES = 1024 * 1024 - 1;

/** put resolves only after the configured replication threshold is observed. */
export interface DistributedContentStore {
  put(bytes: Uint8Array): Promise<string>;
  get(cid: string): Promise<Uint8Array>;
}

export function validateRawCid(value: unknown): string {
  try {
    if (typeof value !== "string" || value.length > 128) throw new Error();
    const cid = CID.parse(value);
    if (cid.version !== 1 || cid.code !== raw.code ||
        cid.multihash.code !== sha256.code || cid.multihash.size !== 32 ||
        cid.toString() !== value) throw new Error();
    return value;
  } catch {
    throw new Error("Invalid distributed content identifier.");
  }
}

export async function rawContentCid(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
      bytes.byteLength > MAX_DISTRIBUTED_BLOB_BYTES) {
    throw new Error("Invalid distributed content size.");
  }
  return CID.createV1(raw.code, await sha256.digest(bytes)).toString();
}

function pointer(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !("format" in value) ||
      value.format !== "ipfs-raw-v1" || !("cid" in value)) {
    throw new Error("Invalid distributed storage pointer.");
  }
  return validateRawCid(value.cid);
}

/** Atomicity comes exclusively from the injected metadata BlobStore. */
export class DistributedBlobStore implements BlobStore {
  public constructor(
    private readonly metadata: BlobStore,
    private readonly content: DistributedContentStore,
  ) {}

  public async read<T>(key: string): Promise<StoredObject<T> | undefined> {
    assertBlobKey(key);
    const stored = await this.metadata.read(key);
    if (stored === undefined) return undefined;
    if (!Number.isSafeInteger(stored.version) || stored.version < 1) {
      throw new Error("Invalid storage object version.");
    }
    const cid = pointer(stored.value);
    const bytes = await this.content.get(cid);
    if (await rawContentCid(bytes) !== cid) {
      throw new Error("Distributed content integrity check failed.");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Invalid distributed content encoding.");
    }
    const decoded = decodeStoredObject<T>(text);
    if (decoded.version !== 1) throw new Error("Invalid distributed content format.");
    return { version: stored.version, value: decoded.value };
  }

  public async create(key: string, value: unknown): Promise<void> {
    assertBlobKey(key);
    const cid = await this.upload(value);
    await this.metadata.create(key, { format: "ipfs-raw-v1", cid });
  }

  public async compareAndSwap(
    key: string,
    expectedVersion: number,
    value: unknown,
  ): Promise<number> {
    assertBlobKey(key);
    nextVersion(expectedVersion);
    const stored = await this.metadata.read(key);
    if (!stored) throw new ObjectNotFoundError(key);
    if (stored.version !== expectedVersion) throw new ConcurrentUpdateError(key);
    pointer(stored.value);
    const cid = await this.upload(value);
    return this.metadata.compareAndSwap(key, expectedVersion, { format: "ipfs-raw-v1", cid });
  }

  private async upload(value: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(encodeStoredObject({ version: 1, value }));
    const expected = await rawContentCid(bytes);
    const actual = validateRawCid(await this.content.put(bytes));
    if (actual !== expected) throw new Error("Distributed content integrity check failed.");
    return actual;
  }
}
