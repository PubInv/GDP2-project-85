import { open } from "node:fs/promises";
import {
  StorageConfigurationError, required, storageEndpoint, type StorageEnvironment,
} from "./settings.js";

// Secrets are retrieved at runtime, never encoded in the configuration file.
export async function loadRuntimeSecret(
  env: StorageEnvironment,
  setting: string,
): Promise<string | undefined> {
  const file = env[`${setting}_FILE`];
  const name = env[`${setting}_KEYVAULT_SECRET`];
  const awsSecret = env[`${setting}_AWS_SECRET_ID`];
  if (env[setting] !== undefined) {
    throw new StorageConfigurationError(
      `Use a mounted file, Key Vault, or AWS Secrets Manager reference for ${setting}, not an inline secret.`,
    );
  }
  if ([file, name, awsSecret].filter(Boolean).length > 1) {
    throw new StorageConfigurationError(`Choose one runtime secret source for ${setting}.`);
  }
  if (!file && !name && !awsSecret) return undefined;
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
  } else if (awsSecret) {
    if (awsSecret.length > 2048 || /[\s\x00-\x1f\x7f]/.test(awsSecret)) {
      throw new StorageConfigurationError(`${setting}_AWS_SECRET_ID is invalid.`);
    }
    const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const client = new SecretsManagerClient({
      region: required(env, "AWS_REGION"),
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
    });
    try {
      secret = (await client.send(new GetSecretValueCommand({ SecretId: awsSecret }), {
        abortSignal: AbortSignal.timeout(30_000),
      })).SecretString?.trim();
    } finally {
      client.destroy();
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
    const { DefaultAzureCredential } = await import("@azure/identity");
    const { SecretClient } = await import("@azure/keyvault-secrets");
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
