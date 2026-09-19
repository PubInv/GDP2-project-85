import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  flag, positiveInteger, required, providerName, storageEndpoint,
} from "../../../src/storage/config/settings.js";
import { loadRuntimeSecret } from "../../../src/storage/config/secrets.js";

const vault = vi.hoisted(() => ({ getSecret: vi.fn() }));
const aws = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = aws.send;
    destroy = aws.destroy;
  },
  GetSecretValueCommand: class {
    constructor(public input: { SecretId: string }) {}
  },
}));
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {},
}));
vi.mock("@azure/keyvault-secrets", () => ({
  SecretClient: class {
    getSecret = vault.getSecret;
  },
}));

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

describe("storage configuration", () => {
  it("defaults to file and validates provider names independently of registration", () => {
    expect(providerName({})).toBe("file");
    for (const backend of ["", "../provider", "S3", "__proto__", "x".repeat(65)]) {
      expect(() => providerName({ STORAGE_BACKEND: backend })).toThrow();
    }
    for (const backend of ["file", "memory", "s3", "azure", "ipfs"]) {
      expect(providerName({ STORAGE_BACKEND: backend })).toBe(backend);
    }
    expect(providerName({ STORAGE_BACKEND: "custom-provider" })).toBe("custom-provider");
  });

  it("validates required values, booleans, and integer limits", () => {
    expect(() => required({}, "S3_BUCKET")).toThrow("S3_BUCKET");
    expect(() => required({ S3_BUCKET: " " }, "S3_BUCKET")).toThrow();
    expect(flag({}, "FLAG")).toBe(false);
    expect(flag({ FLAG: "true" }, "FLAG")).toBe(true);
    expect(() => flag({ FLAG: "1" }, "FLAG")).toThrow();
    expect(positiveInteger({}, "N", 2)).toBe(2);
    expect(positiveInteger({ N: "3" }, "N", 2)).toBe(3);
    for (const value of ["0", "-1", "1.2", "Infinity", "9007199254740992", ""]) {
      expect(() => positiveInteger({ N: value }, "N", 2)).toThrow();
    }
  });

  it("requires secure endpoints and rejects secrets embedded in URLs", () => {
    expect(storageEndpoint("https://account.blob.core.windows.net", "ENDPOINT").protocol)
      .toBe("https:");
    for (const value of [
      "invalid", "ftp://example.test", "http://example.test",
      "https://user:password@example.test", "https://example.test?sig=secret",
      "https://example.test#secret", "http://127.0.0.1:10000",
    ]) {
      expect(() => storageEndpoint(value, "ENDPOINT")).toThrow();
    }
    const secret = "not-for-error-output";
    expect(() => storageEndpoint(`https://${secret}@example.test`, "ENDPOINT"))
      .toThrow(/^ENDPOINT requires/);
  });

  it("limits insecure emulator exceptions to loopback", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(storageEndpoint(`http://${host}:10000`, "ENDPOINT", true).protocol).toBe("http:");
    }
    for (const host of ["192.168.0.1", "0.0.0.0", "localhost.example.test", "example.test"]) {
      expect(() => storageEndpoint(`http://${host}:10000`, "ENDPOINT", true)).toThrow();
    }
  });
});

describe("runtime secret sources", () => {
  it("retrieves AWS secret strings with runtime identity and releases the client", async () => {
    const env = { IPFS_AUTH_AWS_SECRET_ID: "synthetic-header", AWS_REGION: "us-east-1" };
    aws.send.mockResolvedValueOnce({ SecretString: "Bearer synthetic-from-aws" });
    expect(await loadRuntimeSecret(env, "IPFS_AUTH")).toBe("Bearer synthetic-from-aws");
    expect(aws.send).toHaveBeenCalledWith(
      expect.objectContaining({ input: { SecretId: "synthetic-header" } }),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(aws.destroy).toHaveBeenCalled();
    aws.send.mockResolvedValueOnce({ SecretBinary: new Uint8Array([1, 2]) });
    await expect(loadRuntimeSecret(env, "IPFS_AUTH")).rejects.toThrow("nonempty");
    aws.send.mockRejectedValueOnce(new Error("synthetic AWS access denied"));
    await expect(loadRuntimeSecret(env, "IPFS_AUTH")).rejects.toThrow("access denied");
    await expect(loadRuntimeSecret({
      ...env, IPFS_AUTH_FILE: "some-file",
    }, "IPFS_AUTH")).rejects.toThrow("Choose one");
    await expect(loadRuntimeSecret({ IPFS_AUTH_AWS_SECRET_ID: "synthetic" }, "IPFS_AUTH"))
      .rejects.toThrow("AWS_REGION");
  });

  it("retrieves a named Key Vault secret at runtime and propagates access failures", async () => {
    const env = {
      IPFS_AUTH_KEYVAULT_SECRET: "synthetic-token",
      AZURE_KEY_VAULT_URL: "https://synthetic.vault.azure.net",
    };
    vault.getSecret.mockResolvedValueOnce({ value: "Bearer synthetic-from-vault" });
    expect(await loadRuntimeSecret(env, "IPFS_AUTH")).toBe("Bearer synthetic-from-vault");
    expect(vault.getSecret).toHaveBeenCalledWith("synthetic-token");
    vault.getSecret.mockResolvedValueOnce({});
    await expect(loadRuntimeSecret(env, "IPFS_AUTH")).rejects.toThrow("nonempty");
    vault.getSecret.mockRejectedValueOnce(new Error("synthetic access denied"));
    await expect(loadRuntimeSecret(env, "IPFS_AUTH")).rejects.toThrow("access denied");
  });

  it("permits an unset source but rejects inline and ambiguous sources", async () => {
    expect(await loadRuntimeSecret({}, "IPFS_AUTH")).toBeUndefined();
    await expect(loadRuntimeSecret({ IPFS_AUTH: "secret" }, "IPFS_AUTH"))
      .rejects.toThrow("not an inline secret");
    await expect(loadRuntimeSecret({
      IPFS_AUTH_FILE: "some-file", IPFS_AUTH_KEYVAULT_SECRET: "some-name",
    }, "IPFS_AUTH")).rejects.toThrow("Choose one");
  });

  it("loads a mounted secret file without requiring cloud credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gphr-secret-test-"));
    directories.push(directory);
    const file = join(directory, "synthetic-token");
    await writeFile(file, "Bearer synthetic-only\n");
    expect(await loadRuntimeSecret({ IPFS_AUTH_FILE: file }, "IPFS_AUTH"))
      .toBe("Bearer synthetic-only");
    await writeFile(file, "first\nsecond");
    await expect(loadRuntimeSecret({ IPFS_AUTH_FILE: file }, "IPFS_AUTH"))
      .rejects.toThrow("single-line");
    await writeFile(file, "");
    await expect(loadRuntimeSecret({ IPFS_AUTH_FILE: file }, "IPFS_AUTH")).rejects.toThrow();
    await writeFile(file, "x".repeat(16_385));
    await expect(loadRuntimeSecret({ IPFS_AUTH_FILE: file }, "IPFS_AUTH")).rejects.toThrow();
  });

  it("fails closed on missing files or malformed vault config", async () => {
    await expect(loadRuntimeSecret({ IPFS_AUTH_FILE: "does-not-exist" }, "IPFS_AUTH"))
      .rejects.toThrow();
    await expect(loadRuntimeSecret({ IPFS_AUTH_KEYVAULT_SECRET: "token" }, "IPFS_AUTH"))
      .rejects.toThrow("AZURE_KEY_VAULT_URL");
    await expect(loadRuntimeSecret({
      IPFS_AUTH_KEYVAULT_SECRET: "bad/name", AZURE_KEY_VAULT_URL: "https://example.vault.azure.net",
    }, "IPFS_AUTH")).rejects.toThrow("invalid");
    await expect(loadRuntimeSecret({
      IPFS_AUTH_KEYVAULT_SECRET: "token", AZURE_KEY_VAULT_URL: "http://example.vault.azure.net",
    }, "IPFS_AUTH")).rejects.toThrow("HTTPS");
    await expect(loadRuntimeSecret({
      IPFS_AUTH_KEYVAULT_SECRET: "token", AZURE_KEY_VAULT_URL: "https://untrusted.example.test",
    }, "IPFS_AUTH")).rejects.toThrow("Azure vault root");
  });
});
