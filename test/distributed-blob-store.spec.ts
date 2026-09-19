import { describe, expect, it } from "vitest";
import {
  MAX_DISTRIBUTED_BLOB_BYTES,
  rawContentCid,
  type DistributedContentStore,
} from "../src/storage/distributed-blob-store.js";
import {
  DistributedBlobStore, InMemoryBlobStore,
  ConcurrentUpdateError, ObjectAlreadyExistsError, ObjectNotFoundError,
} from "../src/index.js";

const key = "a".repeat(32);
class Content implements DistributedContentStore {
  readonly blocks = new Map<string, Uint8Array>();
  public async put(bytes: Uint8Array): Promise<string> {
    const cid = await rawContentCid(bytes);
    this.blocks.set(cid, Uint8Array.from(bytes));
    return cid;
  }
  public async get(cid: string): Promise<Uint8Array> {
    const bytes = this.blocks.get(cid);
    if (!bytes) throw new Error("Content unavailable.");
    return Uint8Array.from(bytes);
  }
}

function fixture() {
  const metadata = new InMemoryBlobStore();
  const content = new Content();
  return { metadata, content, store: new DistributedBlobStore(metadata, content) };
}

describe("DistributedBlobStore", () => {
  it("round trips opaque ciphertext without placing it in the pointer index", async () => {
    const { store, metadata, content } = fixture();
    const value = { ciphertext: "synthetic-ciphertext", nonce: "opaque" };
    expect(await store.read(key)).toBeUndefined();
    await store.create(key, value);
    expect(await store.read(key)).toEqual({ version: 1, value });
    expect(JSON.stringify(metadata.snapshot())).not.toContain("synthetic-ciphertext");
    expect([...content.blocks.values()].map((bytes) => Buffer.from(bytes).toString()).join(""))
      .not.toContain("Patient");
    expect(await store.compareAndSwap(key, 1, null)).toBe(2);
    expect(await store.read(key)).toEqual({ version: 2, value: null });
  });

  it("preserves create, missing and stale-version errors", async () => {
    const { store } = fixture();
    await expect(store.compareAndSwap(key, 1, {})).rejects.toBeInstanceOf(ObjectNotFoundError);
    await store.create(key, {});
    await expect(store.create(key, {})).rejects.toBeInstanceOf(ObjectAlreadyExistsError);
    await expect(store.compareAndSwap(key, 2, {})).rejects.toBeInstanceOf(ConcurrentUpdateError);
  });

  it("allows only one concurrent publisher across adapter instances", async () => {
    const { store, metadata, content } = fixture();
    const other = new DistributedBlobStore(metadata, content);
    await store.create(key, "old");
    const results = await Promise.allSettled([
      store.compareAndSwap(key, 1, "first"),
      other.compareAndSwap(key, 1, "second"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected"))
      .toMatchObject({ reason: expect.any(ConcurrentUpdateError) });
    expect((await store.read(key))?.version).toBe(2);
    expect(content.blocks.size).toBe(3);
  });

  it("allows only one concurrent create across adapter instances", async () => {
    const { store, metadata, content } = fixture();
    const results = await Promise.allSettled([
      store.create(key, "first"),
      new DistributedBlobStore(metadata, content).create(key, "second"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected"))
      .toMatchObject({ reason: expect.any(ObjectAlreadyExistsError) });
  });

  it("keeps pending replication invisible to readers", async () => {
    const { metadata, content } = fixture();
    let complete!: () => void;
    const replication = new Promise<void>((resolve) => { complete = resolve; });
    let started!: () => void;
    const uploadStarted = new Promise<void>((resolve) => { started = resolve; });
    const store = new DistributedBlobStore(metadata, {
      put: async (bytes) => {
        const cid = await content.put(bytes);
        started();
        await replication;
        return cid;
      },
      get: content.get.bind(content),
    });
    const create = store.create(key, "opaque");
    await uploadStarted;
    expect(await store.read(key)).toBeUndefined();
    complete();
    await create;
    expect(await store.read(key)).toEqual({ version: 1, value: "opaque" });
  });

  it("never publishes before replication succeeds and propagates index errors", async () => {
    const { metadata, content } = fixture();
    const failed = new DistributedBlobStore(metadata, {
      put: async () => { throw new Error("Replication unavailable."); },
      get: content.get.bind(content),
    });
    await expect(failed.create(key, {})).rejects.toThrow("Replication unavailable");
    expect(await metadata.read(key)).toBeUndefined();
    const store = new DistributedBlobStore({
      read: metadata.read.bind(metadata),
      create: async () => { throw new Error("Index unavailable."); },
      compareAndSwap: metadata.compareAndSwap.bind(metadata),
    }, content);
    await expect(store.create(key, {})).rejects.toThrow("Index unavailable");
    expect(content.blocks.size).toBe(1);
  });

  it("rejects unavailable, truncated and modified content", async () => {
    const { store, content } = fixture();
    await store.create(key, "opaque");
    const [cid, bytes] = [...content.blocks.entries()][0]!;
    content.blocks.set(cid, bytes.slice(0, -1));
    await expect(store.read(key)).rejects.toThrow("integrity");
    content.blocks.set(cid, Uint8Array.from([1, 2]));
    await expect(store.read(key)).rejects.toThrow("integrity");
    content.blocks.delete(cid);
    await expect(store.read(key)).rejects.toThrow("unavailable");
  });

  it("rejects content stores that return another CID", async () => {
    const { metadata, content } = fixture();
    const store = new DistributedBlobStore(metadata, {
      put: () => rawContentCid(Uint8Array.from([1])),
      get: content.get.bind(content),
    });
    await expect(store.create(key, {})).rejects.toThrow("integrity");
    expect(await metadata.read(key)).toBeUndefined();
  });

  it.each(["../bad", "a", "a/b", "秘密".repeat(32)])("rejects key %s", async (bad) => {
    const { store } = fixture();
    await expect(store.read(bad)).rejects.toThrow("key");
    await expect(store.create(bad, {})).rejects.toThrow("key");
    await expect(store.compareAndSwap(bad, 1, {})).rejects.toThrow("key");
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects invalid write version %s", async (version) => {
      await expect(fixture().store.compareAndSwap(key, version, {})).rejects.toThrow();
    },
  );

  it.each([null, {}, { cid: "invalid", format: "ipfs-raw-v1" },
    { cid: "invalid", format: "other" }])("rejects malformed pointer %j", async (value) => {
    const { metadata, store } = fixture();
    await metadata.create(key, value);
    await expect(store.read(key)).rejects.toThrow();
    await expect(store.compareAndSwap(key, 1, {})).rejects.toThrow();
  });

  it("rejects invalid JSON values and oversized raw blocks without publication", async () => {
    const { store, metadata } = fixture();
    await expect(store.create(key, undefined)).rejects.toThrow();
    await expect(store.create(key, "x".repeat(MAX_DISTRIBUTED_BLOB_BYTES))).rejects.toThrow("size");
    expect(await metadata.read(key)).toBeUndefined();
  });

  it("rejects invalid encoding and serialized content despite correct hashes", async () => {
    for (const bytes of [Uint8Array.from([255]), Buffer.from("{secret"),
      Buffer.from('{"version":2,"value":null}')]) {
      const { store, metadata, content } = fixture();
      const cid = await content.put(bytes);
      await metadata.create(key, { format: "ipfs-raw-v1", cid });
      await expect(store.read(key)).rejects.toThrow();
    }
  });
});
