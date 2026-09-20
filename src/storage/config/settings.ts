export type StorageEnvironment = Readonly<Record<string, string | undefined>>;
export type StorageBackend = "memory" | "file" | "azure" | "s3" | "dynamodb" | "ipfs";

export class StorageConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

export function required(env: StorageEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new StorageConfigurationError(`Set ${name} before selecting this backend.`);
  }
  return value;
}

export function flag(env: StorageEnvironment, name: string): boolean {
  const value = env[name];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new StorageConfigurationError(`${name} must be true or false.`);
}

export function positiveInteger(
  env: StorageEnvironment,
  name: string,
  fallback: number,
): number {
  if (env[name] === undefined) return fallback;
  const value = required(env, name);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new StorageConfigurationError(`${name} must be a positive safe integer.`);
  }
  return Number(value);
}

export function providerName(
  env: StorageEnvironment,
  name = "STORAGE_BACKEND",
  fallback = "file",
): string {
  const value = env[name] ?? fallback;
  if (/^[a-z][a-z0-9-]{0,63}$/.test(value)) return value;
  throw new StorageConfigurationError(`${name} must be a lowercase provider name.`);
}

export function storageEndpoint(
  value: string,
  name: string,
  allowLocalHttp = false,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StorageConfigurationError(`${name} must be a valid endpoint URL.`);
  }
  const local = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(allowLocalHttp && local && url.protocol === "http:"))) {
    throw new StorageConfigurationError(
      `${name} requires HTTPS without embedded credentials, query, or fragment; explicit emulator mode permits loopback HTTP only.`,
    );
  }
  return url;
}
