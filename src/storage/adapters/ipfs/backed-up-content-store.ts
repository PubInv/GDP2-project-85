import { ObjectAlreadyExistsError, type BlobStore } from "../../core/blob-store.js";
import {
  MAX_DISTRIBUTED_BLOB_BYTES, rawContentCid, validateRawCid, type DistributedContentStore,
} from "./distributed-blob-store.js";

/** Backup completion is part of publication, not an asynchronous best-effort task. */
export class BackedUpContentStore implements DistributedContentStore {
  public constructor(
    private readonly primary: DistributedContentStore,
    private readonly backup: BlobStore,
  ) {}

  public async put(input: Uint8Array): Promise<string> {
    if (!(input instanceof Uint8Array) || input.byteLength > MAX_DISTRIBUTED_BLOB_BYTES) {
      throw new Error("Invalid distributed content size.");
    }
    const bytes = Uint8Array.from(input);
    const cid = await rawContentCid(bytes);
    const published = await this.primary.put(bytes);
    if (published !== cid) throw new Error("Primary content integrity check failed.");
    try {
      await this.backup.create(cid, {
        format: "ipfs-backup-v1",
        cid,
        bytes: Buffer.from(bytes).toString("base64"),
      });
    } catch (error) {
      if (!(error instanceof ObjectAlreadyExistsError)) throw error;
      // A duplicate is safe only when the existing immutable backup is intact.
      await this.backupBytes(cid);
    }
    return cid;
  }

  public get(cid: string): Promise<Uint8Array> {
    // Do not hide a missing/corrupt primary with an implicit recovery path.
    return this.primary.get(validateRawCid(cid));
  }

  public async restore(value: string): Promise<string> {
    const cid = validateRawCid(value);
    const bytes = await this.backupBytes(cid);
    if (await this.primary.put(bytes) !== cid) {
      throw new Error("Restored content integrity check failed.");
    }
    return cid;
  }

  private async backupBytes(cid: string): Promise<Uint8Array> {
    const stored = await this.backup.read(cid);
    if (!stored || stored.version !== 1) throw new Error("Immutable content backup is unavailable.");
    const value = stored.value;
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
        !("format" in value) || value.format !== "ipfs-backup-v1" ||
        !("cid" in value) || value.cid !== cid || !("bytes" in value) ||
        typeof value.bytes !== "string" ||
        value.bytes.length > 4 * Math.ceil(MAX_DISTRIBUTED_BLOB_BYTES / 3)) {
      throw new Error("Invalid content backup.");
    }
    const bytes = Buffer.from(value.bytes, "base64");
    if (bytes.toString("base64") !== value.bytes || await rawContentCid(bytes) !== cid) {
      throw new Error("Backup content integrity check failed.");
    }
    return bytes;
  }
}
