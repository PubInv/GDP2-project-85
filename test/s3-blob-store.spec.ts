import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  ConcurrentUpdateError,
  ObjectAlreadyExistsError,
  ObjectNotFoundError,
  S3BlobStore,
} from "../src/index.js";

const key = "s".repeat(43);
const ciphertext = { algorithm: "AES-256-GCM", ciphertext: "synthetic-ciphertext", nonce: "opaque" };

interface Request {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

class S3Transport {
  readonly requests: Request[] = [];
  text: string | undefined;
  etag = '"revision-1"';
  omitEtag = false;
  omitLength = false;
  error: { status: number; code: string } | undefined;
  networkError: Error | undefined;
  writeError: { status: number; code: string } | undefined;
  loseWriteResponse = false;
  #revision = 1;

  async handle(request: Request) {
    this.requests.push(request);
    if (this.networkError) throw this.networkError;
    const failure = (statusCode: number, code: string) => ({
      response: {
        statusCode,
        headers: { "content-type": "application/xml" },
        body: Readable.from([`<Error><Code>${code}</Code><Message>Storage request failed.</Message></Error>`]),
      },
    });
    if (this.error) return failure(this.error.status, this.error.code);
    if (request.method === "GET") {
      if (this.text === undefined) return failure(404, "NoSuchKey");
      return {
        response: {
          statusCode: 200,
          headers: {
            "content-type": "application/json",
            ...(this.omitEtag ? {} : { etag: this.etag }),
            ...(this.omitLength ? {} : { "content-length": `${Buffer.byteLength(this.text)}` }),
          },
          body: Readable.from([this.text]),
        },
      };
    }
    if (request.method !== "PUT") throw new Error("Unexpected storage operation.");
    if (this.writeError) return failure(this.writeError.status, this.writeError.code);
    if (request.headers["if-none-match"] === "*" && this.text !== undefined) {
      return failure(412, "PreconditionFailed");
    }
    if (request.headers["if-match"] &&
        (request.headers["if-match"] !== this.etag || this.text === undefined)) {
      return failure(412, "PreconditionFailed");
    }
    if (typeof request.body !== "string") throw new Error("Unexpected request body.");
    this.text = request.body;
    this.etag = `"revision-${++this.#revision}"`;
    if (this.loseWriteResponse) throw new Error("Connection reset.");
    return { response: { statusCode: 200, headers: { etag: this.etag }, body: Readable.from([]) } };
  }
}

function fixture(transport = new S3Transport(), options: { prefix?: string; kmsKeyId?: string } = {}) {
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "synthetic-access-key", secretAccessKey: "synthetic-secret-key" },
    maxAttempts: 1,
    requestHandler: transport,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return { transport, client, store: new S3BlobStore(client, "synthetic-bucket", options) };
}

describe("S3BlobStore", () => {
  it("creates immutable ciphertext and uses the GET ETag for conditional updates", async () => {
    const { transport, store } = fixture();
    await store.create(key, ciphertext);
    expect(transport.requests[0]?.headers["if-none-match"]).toBe("*");
    expect(JSON.parse(transport.text ?? "")).toEqual({ version: 1, value: ciphertext });
    await expect(store.create(key, { ciphertext: "replacement" })).rejects.toBeInstanceOf(ObjectAlreadyExistsError);
    expect(await store.read(key)).toEqual({ version: 1, value: ciphertext });
    const etag = transport.etag;
    await expect(store.compareAndSwap(key, 1, { ciphertext: "next" })).resolves.toBe(2);
    expect(transport.requests.at(-1)?.headers["if-match"]).toBe(etag);
    expect(await store.read(key)).toEqual({ version: 2, value: { ciphertext: "next" } });
    const puts = transport.requests.filter((request) => request.method === "PUT").length;
    await expect(store.compareAndSwap(key, 1, null)).rejects.toBeInstanceOf(ConcurrentUpdateError);
    expect(transport.requests.filter((request) => request.method === "PUT")).toHaveLength(puts);
  });

  it("has exactly one winner when independent clients race on a version", async () => {
    const { transport, store } = fixture();
    const second = fixture(transport).store;
    await store.create(key, ciphertext);
    const results = await Promise.allSettled([
      store.compareAndSwap(key, 1, { ciphertext: "first" }),
      second.compareAndSwap(key, 1, { ciphertext: "second" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(ConcurrentUpdateError),
    });
    expect(transport.requests.filter((request) => request.headers["if-match"])).toHaveLength(2);
    expect((await store.read(key))?.version).toBe(2);
  });

  it("distinguishes missing objects from bucket, authorization, and network errors", async () => {
    const { transport, store } = fixture();
    await expect(store.read(key)).resolves.toBeUndefined();
    await expect(store.compareAndSwap(key, 1, null)).rejects.toBeInstanceOf(ObjectNotFoundError);
    for (const code of ["NoSuchBucket", "AccessDenied", "NotFound"]) {
      transport.error = { status: code === "AccessDenied" ? 403 : 404, code };
      await expect(store.read(key)).rejects.toMatchObject({ name: code });
      await expect(store.create(key, null)).rejects.toMatchObject({ name: code });
    }
    transport.error = undefined;
    transport.networkError = new Error("Synthetic network failure.");
    await expect(store.read(key)).rejects.toBe(transport.networkError);
  });

  it("does not report a 409 conditional race as an immutable-object duplicate", async () => {
    const { transport, store } = fixture();
    transport.writeError = { status: 409, code: "ConditionalRequestConflict" };
    await expect(store.create(key, ciphertext)).rejects.toBeInstanceOf(ConcurrentUpdateError);
    transport.writeError = undefined;
    await store.create(key, ciphertext);
    for (const error of [
      { status: 409, code: "ConditionalRequestConflict" },
      { status: 412, code: "PreconditionFailed" },
    ]) {
      transport.writeError = error;
      await expect(store.compareAndSwap(key, 1, null)).rejects.toBeInstanceOf(ConcurrentUpdateError);
    }
    transport.writeError = { status: 403, code: "AccessDenied" };
    await expect(store.compareAndSwap(key, 1, null)).rejects.toMatchObject({ name: "AccessDenied" });
  });

  it("propagates an ambiguous write outcome without a retry or read-back", async () => {
    const { transport, store } = fixture();
    transport.loseWriteResponse = true;
    await expect(store.create(key, ciphertext)).rejects.toThrow("Connection reset.");
    expect(transport.requests).toHaveLength(1);
    expect(transport.text).toBeDefined();
  });

  it("rejects rather than reconciling an ambiguous committed CAS", async () => {
    const { transport, store } = fixture();
    await store.create(key, ciphertext);
    transport.loseWriteResponse = true;
    await expect(store.compareAndSwap(key, 1, { ciphertext: "next" })).rejects.toThrow("Connection reset.");
    expect(transport.requests).toHaveLength(3);
    expect(JSON.parse(transport.text ?? "").version).toBe(2);
  });

  it("applies a bounded prefix and explicit SSE-KMS options to every write", async () => {
    const { transport, store } = fixture(new S3Transport(), { prefix: "opaque/objects", kmsKeyId: "alias/synthetic-key" });
    await store.create(key, ciphertext);
    await store.compareAndSwap(key, 1, { ciphertext: "next" });
    for (const request of transport.requests) {
      expect(request.path).toBe(`/opaque/objects/${key}`);
      if (request.method === "PUT") {
        expect(request.headers["x-amz-server-side-encryption"]).toBe("aws:kms");
        expect(request.headers["x-amz-server-side-encryption-aws-kms-key-id"]).toBe("alias/synthetic-key");
      }
    }
  });

  it("accepts the integration prefix without adding a second trailing slash", async () => {
    const { transport, store } = fixture(new S3Transport(), { prefix: "synthetic-integration/" });
    await store.create(key, ciphertext);
    expect(await store.read(key)).toEqual({ version: 1, value: ciphertext });
    expect(transport.requests.every((request) => request.path === `/synthetic-integration/${key}`)).toBe(true);
  });

  it.each([
    "not-json", "null", "[]", '{"version":1}', '{"value":null}',
    '{"version":0,"value":null}', '{"version":1.5,"value":null}',
    '{"version":"1","value":null}', '{"version":9007199254740992,"value":null}',
  ])("rejects malformed serialized wrappers: %s", async (text) => {
    const { transport, store } = fixture();
    transport.text = text;
    await expect(store.read(key)).rejects.toThrow("Invalid stored object.");
    await expect(store.compareAndSwap(key, 1, null)).rejects.toThrow();
    expect(transport.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("fails closed on absent ETags and oversized bodies even without content length", async () => {
    const { transport, store } = fixture();
    transport.text = '{"version":1,"value":null}';
    transport.omitEtag = true;
    await expect(store.read(key)).rejects.toThrow("ETag");
    await expect(store.compareAndSwap(key, 1, null)).rejects.toThrow("ETag");
    transport.omitEtag = false;
    transport.text = "x".repeat(4 * 1024 * 1024 + 1);
    await expect(store.read(key)).rejects.toThrow("size");
    transport.omitLength = true;
    await expect(store.read(key)).rejects.toThrow("limits");
  });

  it("validates keys, versions, prefixes and JSON before requests", async () => {
    const { transport, client, store } = fixture();
    for (const invalidKey of ["short", "../" + key, key + "/", "x".repeat(129)]) {
      await expect(store.read(invalidKey)).rejects.toThrow("key");
      await expect(store.create(invalidKey, null)).rejects.toThrow("key");
      await expect(store.compareAndSwap(invalidKey, 1, null)).rejects.toThrow("key");
    }
    for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(store.compareAndSwap(key, version, null)).rejects.toThrow("version");
    }
    for (const prefix of ["../", "a/../b", "/root", "a//b", "a\\b", "a%2fb", "x".repeat(513)]) {
      expect(() => new S3BlobStore(client, "synthetic-bucket", { prefix })).toThrow("prefix");
    }
    const circular: { self?: object } = {};
    circular.self = circular;
    for (const value of [undefined, { missing: undefined }, [undefined], [,], NaN, Infinity,
      1n, () => null, Symbol("synthetic"), new Date(0), new Map(), circular,
      new Proxy({}, {}), "x".repeat(4 * 1024 * 1024 + 1)]) {
      await expect(store.create(key, value)).rejects.toThrow("Invalid or oversized storage object.");
      await expect(store.compareAndSwap(key, 1, value)).rejects.toThrow("Invalid or oversized storage object.");
    }
    expect(transport.requests).toHaveLength(0);
  });
});
