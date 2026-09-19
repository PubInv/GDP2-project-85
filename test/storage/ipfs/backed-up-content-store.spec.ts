import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  BackedUpContentStore, DistributedBlobStore, InMemoryBlobStore, PatientRecordService,
  createClinicianCredential, type DistributedContentStore,
} from "../../../src/index.js";
import {
  rawContentCid, MAX_DISTRIBUTED_BLOB_BYTES,
} from "../../../src/storage/adapters/ipfs/distributed-blob-store.js";

class TestContent implements DistributedContentStore {
  public readonly blocks = new Map<string, Uint8Array>();
  public async put(bytes: Uint8Array): Promise<string> {
    const cid = await rawContentCid(bytes);
    this.blocks.set(cid, Uint8Array.from(bytes));
    return cid;
  }
  public async get(cid: string): Promise<Uint8Array> {
    const bytes = this.blocks.get(cid);
    if (!bytes) throw new Error("Synthetic primary unavailable.");
    return Uint8Array.from(bytes);
  }
}

function fixture() {
  const primary = new TestContent();
  const backup = new InMemoryBlobStore();
  const metadata = new InMemoryBlobStore();
  const content = new BackedUpContentStore(primary, backup);
  const store = new DistributedBlobStore(metadata, content);
  return { primary, backup, metadata, content, store };
}

describe("durable encrypted content backup composition", () => {
  it("requires primary and backup completion before publishing a pointer", async () => {
    const { store, metadata, primary, backup } = fixture();
    const order: string[] = [];
    const put = primary.put.bind(primary);
    vi.spyOn(primary, "put").mockImplementation(async (bytes) => {
      order.push("primary"); return put(bytes);
    });
    const save = backup.create.bind(backup);
    vi.spyOn(backup, "create").mockImplementation(async (key, value) => {
      order.push("backup"); return save(key, value);
    });
    const publish = metadata.create.bind(metadata);
    vi.spyOn(metadata, "create").mockImplementation(async (key, value) => {
      order.push("metadata"); return publish(key, value);
    });
    await store.create("a".repeat(32), { ciphertext: "synthetic" });
    expect(order).toEqual(["primary", "backup", "metadata"]);
    expect(Object.keys(backup.snapshot())).toHaveLength(1);
  });

  it("leaves new pointers absent and old state untouched when backup writes fail", async () => {
    const { store, metadata, backup } = fixture();
    const existing = "a".repeat(32);
    await store.create(existing, { ciphertext: "initial" });
    const before = metadata.snapshot();
    vi.spyOn(backup, "create").mockRejectedValue(new Error("Synthetic backup unavailable."));
    await expect(store.create("b".repeat(32), { ciphertext: "new" })).rejects.toThrow("backup unavailable");
    await expect(store.compareAndSwap(existing, 1, { ciphertext: "changed" })).rejects.toThrow();
    expect(metadata.snapshot()).toEqual(before);
    expect(await store.read(existing)).toEqual({ version: 1, value: { ciphertext: "initial" } });
  });

  it("does not claim success after primary failures or invalid returned CIDs", async () => {
    const { content, primary, backup } = fixture();
    const bytes = randomBytes(32);
    vi.spyOn(primary, "put").mockRejectedValueOnce(new Error("Synthetic pin failure."));
    await expect(content.put(bytes)).rejects.toThrow("pin failure");
    expect(backup.snapshot()).toEqual({});
    vi.spyOn(primary, "put").mockResolvedValueOnce(await rawContentCid(randomBytes(32)));
    await expect(content.put(bytes)).rejects.toThrow("integrity");
    expect(backup.snapshot()).toEqual({});
  });

  it("does not publish metadata after an ambiguous backup response", async () => {
    const { store, backup, metadata } = fixture();
    const create = backup.create.bind(backup);
    vi.spyOn(backup, "create").mockImplementation(async (key, value) => {
      await create(key, value);
      throw new Error("Synthetic backup response lost after commit.");
    });
    await expect(store.create("a".repeat(32), { ciphertext: "synthetic" }))
      .rejects.toThrow("response lost");
    expect(Object.keys(backup.snapshot())).toHaveLength(1);
    expect(metadata.snapshot()).toEqual({});
  });

  it("deduplicates matching backups but rejects changed or missing duplicate backups", async () => {
    const { content, backup } = fixture();
    const bytes = randomBytes(32);
    const cid = await content.put(bytes);
    expect(await content.put(bytes)).toBe(cid);
    expect((await backup.read(cid))?.version).toBe(1);
    const original = await backup.read(cid);
    await backup.compareAndSwap(cid, 1, original!.value);
    await expect(content.put(bytes)).rejects.toThrow("Immutable content backup");
  });

  it("requires explicit restore and never masks missing primary data", async () => {
    const { store, metadata, primary } = fixture();
    const key = "a".repeat(32);
    await store.create(key, { ciphertext: "synthetic" });
    const before = metadata.snapshot();
    primary.blocks.clear();
    await expect(store.read(key)).rejects.toThrow("primary unavailable");
    await store.restore(key);
    expect(await store.read(key)).toEqual({ version: 1, value: { ciphertext: "synthetic" } });
    expect(metadata.snapshot()).toEqual(before);
  });

  it("rejects corrupt backup bytes and failed restore replication without updating metadata", async () => {
    const { store, metadata, backup, primary } = fixture();
    const key = "a".repeat(32);
    await store.create(key, { ciphertext: "synthetic" });
    const before = metadata.snapshot();
    const read = backup.read.bind(backup);
    vi.spyOn(backup, "read").mockImplementation(async <T>(cid: string) => {
      const stored = await read<T>(cid);
      if (stored && typeof stored.value === "object" && stored.value !== null && "bytes" in stored.value) {
        stored.value.bytes = randomBytes(32).toString("base64");
      }
      return stored;
    });
    primary.blocks.clear();
    await expect(store.restore(key)).rejects.toThrow("integrity");
    expect(primary.blocks.size).toBe(0);
    expect(metadata.snapshot()).toEqual(before);
    vi.restoreAllMocks();
    vi.spyOn(primary, "put").mockRejectedValue(new Error("Synthetic restore pin failure."));
    await expect(store.restore(key)).rejects.toThrow("restore pin failure");
    expect(metadata.snapshot()).toEqual(before);
  });

  it("refuses missing keys, unavailable backups, and restores without a backup provider", async () => {
    const { store, content, primary } = fixture();
    await expect(store.restore("a".repeat(32))).rejects.toThrow("Object not found");
    await expect(content.restore(await rawContentCid(randomBytes(32)))).rejects.toThrow("unavailable");
    const withoutBackup = new DistributedBlobStore(new InMemoryBlobStore(), primary);
    await expect(withoutBackup.restore("a".repeat(32))).rejects.toThrow("no configured backup");
  });

  it("bounds backup size before uploading", async () => {
    const { content, primary } = fixture();
    await expect(content.put(new Uint8Array(MAX_DISTRIBUTED_BLOB_BYTES + 1))).rejects.toThrow("size");
    await expect(content.put(new Uint8Array())).rejects.toThrow("size");
    expect(primary.blocks.size).toBe(0);
  });

  it("restores an encrypted record without persisting patient factors or plaintext in backups", async () => {
    const { store, primary, backup } = fixture();
    const records = new PatientRecordService(store);
    const access = { clinician: createClinicianCredential(), biometricToken: randomBytes(32).toString("base64url") };
    await records.enroll(access);
    const entry = await records.append({
      ...access,
      resource: { resourceType: "Condition", id: "synthetic-backup-record", code: { text: "SYNTHETIC-BACKUP-MARKER" } },
    });
    const snapshot = backup.snapshot();
    for (const stored of Object.values(snapshot)) {
      const value = stored.value;
      if (typeof value !== "object" || value === null || !("bytes" in value) ||
          typeof value.bytes !== "string") throw new Error("Invalid fixture.");
      const decoded = Buffer.from(value.bytes, "base64").toString("utf8");
      expect(decoded).not.toContain("SYNTHETIC-BACKUP-MARKER");
      expect(decoded).not.toContain(access.biometricToken);
      expect(decoded).not.toContain(access.clinician.privateKeyPem);
    }
    const rawEvent = await store.read(entry.eventId);
    expect(rawEvent).toBeDefined();
    const cid = await rawContentCid(new TextEncoder().encode(JSON.stringify({ version: 1, value: rawEvent!.value })));
    primary.blocks.delete(cid);
    await expect(records.assemble(access)).rejects.toThrow();
    await store.restore(entry.eventId);
    expect(await records.assemble(access)).toHaveLength(1);
  });
});
