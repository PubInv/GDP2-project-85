export interface StoredObject<T = unknown> {
  version: number;
  value: T;
}

export interface BlobStore {
  read<T>(key: string): Promise<StoredObject<T> | undefined>;
  create(key: string, value: unknown): Promise<void>;
  compareAndSwap(
    key: string,
    expectedVersion: number,
    value: unknown,
  ): Promise<number>;
}

export class ObjectAlreadyExistsError extends Error {
  public constructor(key: string) {
    super(`Object already exists: ${key}`);
    this.name = "ObjectAlreadyExistsError";
  }
}

export class ObjectNotFoundError extends Error {
  public constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = "ObjectNotFoundError";
  }
}

export class ConcurrentUpdateError extends Error {
  public constructor(key: string) {
    super(`Object changed concurrently: ${key}`);
    this.name = "ConcurrentUpdateError";
  }
}
