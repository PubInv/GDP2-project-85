import {
  ConcurrentUpdateError,
  ObjectAlreadyExistsError,
  ObjectNotFoundError,
  type BlobStore,
  type StoredObject,
} from "./blob-store.js";

export class InMemoryBlobStore implements BlobStore {
  readonly #objects = new Map<string, StoredObject>();

  public async read<T>(key: string): Promise<StoredObject<T> | undefined> {
    const stored = this.#objects.get(key);
    return stored === undefined
      ? undefined
      : (structuredClone(stored) as StoredObject<T>);
  }

  public async create(key: string, value: unknown): Promise<void> {
    if (this.#objects.has(key)) {
      throw new ObjectAlreadyExistsError(key);
    }
    this.#objects.set(key, { version: 1, value: structuredClone(value) });
  }

  public async compareAndSwap(
    key: string,
    expectedVersion: number,
    value: unknown,
  ): Promise<number> {
    const stored = this.#objects.get(key);
    if (stored === undefined) {
      throw new ObjectNotFoundError(key);
    }
    if (stored.version !== expectedVersion) {
      throw new ConcurrentUpdateError(key);
    }

    const version = stored.version + 1;
    this.#objects.set(key, { version, value: structuredClone(value) });
    return version;
  }

  public snapshot(): Record<string, StoredObject> {
    return Object.fromEntries(
      [...this.#objects.entries()].map(([key, value]) => [
        key,
        structuredClone(value),
      ]),
    );
  }
}
