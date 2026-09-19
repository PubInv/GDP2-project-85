import { open } from "node:fs/promises";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

export type StorageEnvironment = Readonly<Record<string, string | undefined>>;
export type StorageBackend = "memory" | "file" | "azure" | "s3" | "ipfs";

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

export function storageBackend(
  env: StorageEnvironment,
  name = "STORAGE_BACKEND",
  fallback: StorageBackend = "file",
): StorageBackend {
  const value = env[name] ?? fallback;
  if (value === "memory" || value === "file" || value === "azure" ||
      value === "s3" || value === "ipfs") return value;
  throw new StorageConfigurationError(`${name} must be memory, file, azure, s3, or ipfs.`);
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

// Secrets are retrieved at runtime, never encoded in the configuration file.
export async function loadRuntimeSecret(
  env: StorageEnvironment,
  setting: string,
): Promise<string | undefined> {
  const file = env[`${setting}_FILE`];
  const name = env[`${setting}_KEYVAULT_SECRET`];
  if (env[setting] !== undefined) {
    throw new StorageConfigurationError(
      `Use ${setting}_FILE or ${setting}_KEYVAULT_SECRET, not an inline secret.`,
    );
  }
  if (file && name) {
    throw new StorageConfigurationError(`Choose one runtime secret source for ${setting}.`);
  }
  if (!file && !name) return undefined;
  let secret: string | undefined;
  if (file) {
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16_384) {
        throw new StorageConfigurationError(`${setting} must be a small regular secret file.`);
      }
      secret = (await handle.readFile("utf8")).trim();
    } finally {
      await handle.close();
    }
  } else {
    if (!name || !/^[A-Za-z0-9-]{1,127}$/.test(name)) {
      throw new StorageConfigurationError(`${setting}_KEYVAULT_SECRET is invalid.`);
    }
    const vault = storageEndpoint(required(env, "AZURE_KEY_VAULT_URL"), "AZURE_KEY_VAULT_URL");
    const vaultSuffixes = [".vault.azure.net", ".vault.usgovcloudapi.net", ".vault.azure.cn"];
    if (vault.pathname !== "/" || (vault.port && vault.port !== "443") ||
        !vaultSuffixes.some((suffix) => vault.hostname.endsWith(suffix))) {
      throw new StorageConfigurationError("AZURE_KEY_VAULT_URL must identify an Azure vault root.");
    }
    const client = new SecretClient(vault.href, new DefaultAzureCredential(), {
      retryOptions: { maxRetries: 2 },
    });
    secret = (await client.getSecret(name)).value?.trim();
  }
  if (!secret || secret.length > 16_384 || /[\r\n]/.test(secret)) {
    throw new StorageConfigurationError(`${setting} must contain a nonempty single-line secret.`);
  }
  return secret;
}
