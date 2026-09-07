import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConcurrentUpdateError,
  FileBlobStore,
  ObjectAlreadyExistsError,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("FileBlobStore", () => {
  it("persists opaque objects and enforces versions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gphr-store-"));
    temporaryDirectories.push(directory);
    const first = new FileBlobStore(directory);
    const second = new FileBlobStore(directory);
    const key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    await first.create(key, { encrypted: "value-1" });
    await expect(first.create(key, { encrypted: "duplicate" })).rejects.toBeInstanceOf(
      ObjectAlreadyExistsError,
    );
    expect(await second.read(key)).toEqual({
      version: 1,
      value: { encrypted: "value-1" },
    });

    await first.compareAndSwap(key, 1, { encrypted: "value-2" });
    await expect(
      second.compareAndSwap(key, 1, { encrypted: "stale" }),
    ).rejects.toBeInstanceOf(ConcurrentUpdateError);
  });

  it("allows only one concurrent writer for the same version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gphr-store-"));
    temporaryDirectories.push(directory);
    const first = new FileBlobStore(directory);
    const second = new FileBlobStore(directory);
    const key = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await first.create(key, { encrypted: "initial" });

    const results = await Promise.allSettled([
      first.compareAndSwap(key, 1, { encrypted: "first" }),
      second.compareAndSwap(key, 1, { encrypted: "second" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      reason: expect.any(ConcurrentUpdateError),
    });
  });
});
