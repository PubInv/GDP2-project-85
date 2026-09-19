import type { BlobStore } from "../core/blob-store.js";
import type { StorageEnvironment } from "./settings.js";

export interface StorageProviderContext {
  readonly environment: StorageEnvironment;
  readonly emulator: boolean;
  createStore(provider: string): Promise<BlobStore>;
}

export type StorageProviderFactory =
  (context: StorageProviderContext) => BlobStore | Promise<BlobStore>;

export type StorageProviderRegistry = Readonly<Record<string, StorageProviderFactory>>;

export interface StorageFactoryOptions {
  /** Additional providers; built-in names cannot be overridden accidentally. */
  providers?: StorageProviderRegistry;
}
