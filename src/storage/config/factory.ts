import type { BlobStore } from "../core/blob-store.js";
import type { StorageFactoryOptions, StorageProviderRegistry } from "./provider.js";
import { StorageConfigurationError, flag, providerName, type StorageEnvironment } from "./settings.js";

const builtinProviders: StorageProviderRegistry = Object.freeze({
  memory: async (context) => (await import("../adapters/memory/provider.js")).createStore(context),
  file: async (context) => (await import("../adapters/file/provider.js")).createStore(context),
  azure: async (context) => (await import("../adapters/azure/provider.js")).createStore(context),
  s3: async (context) => (await import("../adapters/s3/provider.js")).createStore(context),
  dynamodb: async (context) => (await import("../adapters/dynamodb/provider.js")).createStore(context),
  ipfs: async (context) => (await import("../adapters/ipfs/provider.js")).createStore(context),
});

export async function createConfiguredBlobStore(
  env: StorageEnvironment = process.env,
  options: StorageFactoryOptions = {},
): Promise<BlobStore> {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new StorageConfigurationError("TLS certificate validation must remain enabled.");
  }
  const environment = Object.freeze({ ...env });
  const emulator = flag(environment, "STORAGE_EMULATOR");
  for (const [name, factory] of Object.entries(options.providers ?? {})) {
    providerName({ STORAGE_BACKEND: name });
    if (Object.hasOwn(builtinProviders, name) || typeof factory !== "function") {
      throw new StorageConfigurationError("Additional providers must be functions with distinct non-builtin names.");
    }
  }
  const providers = Object.freeze({ ...builtinProviders, ...options.providers });
  const create = async (name: string, ancestors: ReadonlySet<string>): Promise<BlobStore> => {
    if (!Object.hasOwn(providers, name)) {
      throw new StorageConfigurationError("Unknown storage backend. Select a built-in or register an additional provider.");
    }
    if (ancestors.has(name)) throw new StorageConfigurationError("Storage provider dependency cycle.");
    const factory = providers[name]!;
    return factory({
      environment,
      emulator,
      createStore: (dependency) => create(dependency, new Set([...ancestors, name])),
    });
  };
  return create(providerName(environment), new Set());
}
