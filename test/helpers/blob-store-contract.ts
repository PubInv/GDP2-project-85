import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConcurrentUpdateError,
  ObjectAlreadyExistsError,
  ObjectNotFoundError,
  type BlobStore,
} from "../../src/index.js";

export interface StorePair {
  first: BlobStore;
  second: BlobStore;
}

export function blobStoreContract(name: string, setup: () => Promise<StorePair>): void {
  describe(`${name} BlobStore contract`, () => {
    const key = () => randomBytes(24).toString("hex");

    it("distinguishes a missing object from a stored null", async () => {
      const { first, second } = await setup();
      const id = key();
      expect(await first.read(id)).toBeUndefined();
      await first.create(id, null);
      expect(await second.read(id)).toEqual({ version: 1, value: null });
    });

    it("creates once and never overwrites on duplicate creation", async () => {
      const { first, second } = await setup();
      const id = key();
      const value = { ciphertext: "synthetic-opaque-value" };
      await first.create(id, value);
      value.ciphertext = "changed-outside-store";
      await expect(second.create(id, { ciphertext: "replacement" }))
        .rejects.toBeInstanceOf(ObjectAlreadyExistsError);
      expect(await second.read(id)).toEqual({
        version: 1, value: { ciphertext: "synthetic-opaque-value" },
      });
    });

    it("round-trips nested JSON without sharing mutable references", async () => {
      const { first, second } = await setup();
      const id = key();
      const value = { data: [null, true, 2, { encoded: "test" }] };
      await first.create(id, value);
      const read = await first.read<typeof value>(id);
      expect(read?.value).toEqual(value);
      read!.value.data.push({ encoded: "local mutation" });
      expect((await second.read(id))?.value).toEqual(value);
    });

    it("increments versions and rejects stale and missing CAS", async () => {
      const { first, second } = await setup();
      const id = key();
      await expect(first.compareAndSwap(id, 1, "missing"))
        .rejects.toBeInstanceOf(ObjectNotFoundError);
      await first.create(id, "one");
      expect(await second.compareAndSwap(id, 1, "two")).toBe(2);
      await expect(first.compareAndSwap(id, 1, "stale"))
        .rejects.toBeInstanceOf(ConcurrentUpdateError);
      expect(await first.read(id)).toEqual({ version: 2, value: "two" });
      expect(await first.compareAndSwap(id, 2, "three")).toBe(3);
    });

    it("allows only one concurrent create across independent clients", async () => {
      const { first, second } = await setup();
      const id = key();
      const results = await Promise.allSettled([
        first.create(id, "first"), second.create(id, "second"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const failure = results.find((result) => result.status === "rejected");
      expect(failure).toMatchObject({ reason: expect.any(ObjectAlreadyExistsError) });
    });

    it("allows only one writer for a version across independent clients", async () => {
      const { first, second } = await setup();
      const id = key();
      await first.create(id, "initial");
      const results = await Promise.allSettled([
        first.compareAndSwap(id, 1, "first"),
        second.compareAndSwap(id, 1, "second"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const failure = results.find((result) => result.status === "rejected");
      expect(failure).toMatchObject({ reason: expect.any(ConcurrentUpdateError) });
      const winner = await first.read<string>(id);
      expect(winner?.version).toBe(2);
      expect(["first", "second"]).toContain(winner?.value);
    });
  });
}
