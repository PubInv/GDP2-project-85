import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ConcurrentUpdateError,
  ObjectAlreadyExistsError,
  ObjectNotFoundError,
  type BlobStore,
  type StoredObject,
} from "./blob-store.js";

const SAFE_KEY = /^[A-Za-z0-9_-]{32,128}$/;
const fileLocks = new Map<string, Promise<void>>();

export class FileBlobStore implements BlobStore {
  public constructor(private readonly rootDirectory: string) {}

  public async read<T>(key: string): Promise<StoredObject<T> | undefined> {
    const path = this.pathFor(key);
    try {
      return JSON.parse(await readFile(path, "utf8")) as StoredObject<T>;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  public async create(key: string, value: unknown): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    try {
      await writeFile(
        this.pathFor(key),
        JSON.stringify({ version: 1, value } satisfies StoredObject),
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new ObjectAlreadyExistsError(key);
      }
      throw error;
    }
  }

  public async compareAndSwap(
    key: string,
    expectedVersion: number,
    value: unknown,
  ): Promise<number> {
    const path = this.pathFor(key);
    return withFileLock(path, async () => {
      const stored = await this.read(key);
      if (stored === undefined) {
        throw new ObjectNotFoundError(key);
      }
      if (stored.version !== expectedVersion) {
        throw new ConcurrentUpdateError(key);
      }

      const version = stored.version + 1;
      await writeFile(
        path,
        JSON.stringify({ version, value } satisfies StoredObject),
        "utf8",
      );
      return version;
    });
  }

  private pathFor(key: string): string {
    if (!SAFE_KEY.test(key)) {
      throw new Error("Blob key contains unsupported characters.");
    }
    return join(this.rootDirectory, `${key}.json`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = fileLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  fileLocks.set(path, queued);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fileLocks.get(path) === queued) {
      fileLocks.delete(path);
    }
  }
}
