import { Readable } from "node:stream";
import {
  ContainerClient,
  type HttpOperationResponse,
  type IHttpClient,
  type WebResource,
} from "@azure/storage-blob";
import { describe, expect, it } from "vitest";
import {
  AzureBlobStore,
  ConcurrentUpdateError,
  ObjectAlreadyExistsError,
  ObjectNotFoundError,
} from "../src/index.js";

const key = "a".repeat(43);
const ciphertext = { algorithm: "AES-256-GCM", ciphertext: "synthetic-ciphertext", nonce: "opaque" };

class AzureTransport implements IHttpClient {
  readonly requests: WebResource[] = [];
  text: string | undefined;
  etag = '"revision-1"';
  omitEtag = false;
  omitLength = false;
  error: { status: number; code: string } | undefined;
  networkError: Error | undefined;
  writeError: { status: number; code: string } | undefined;
  loseWriteResponse = false;
  #revision = 1;

  async sendRequest(request: WebResource): Promise<HttpOperationResponse> {
    this.requests.push(request);
    if (this.networkError) throw this.networkError;
    const headers = request.headers.clone();
    headers.set("x-ms-request-id", "synthetic-request");
    const failure = (status: number, code: string): HttpOperationResponse => {
      headers.set("content-type", "application/xml");
      headers.set("x-ms-error-code", code);
      const body = `<Error><Code>${code}</Code><Message>Storage request failed.</Message></Error>`;
      return { request, status, headers, bodyAsText: body, readableStreamBody: Readable.from([body]) };
    };
    if (this.error) return failure(this.error.status, this.error.code);
    if (request.method === "GET") {
      if (this.text === undefined) return failure(404, "BlobNotFound");
      headers.set("content-type", "application/json");
      if (!this.omitEtag) headers.set("etag", this.etag);
      if (!this.omitLength) headers.set("content-length", `${Buffer.byteLength(this.text)}`);
      return { request, status: 200, headers, readableStreamBody: Readable.from([Buffer.from(this.text)]) };
    }
    if (request.method !== "PUT") throw new Error("Unexpected storage operation.");
    if (this.writeError) return failure(this.writeError.status, this.writeError.code);
    if (request.headers.get("if-none-match") === "*" && this.text !== undefined) {
      return failure(412, "ConditionNotMet");
    }
    const ifMatch = request.headers.get("if-match");
    if (ifMatch && (ifMatch !== this.etag || this.text === undefined)) {
      return failure(412, "ConditionNotMet");
    }
    if (typeof request.body !== "string") throw new Error("Unexpected request body.");
    this.text = request.body;
    this.etag = `"revision-${++this.#revision}"`;
    if (this.loseWriteResponse) throw new Error("Connection reset.");
    headers.set("etag", this.etag);
    headers.set("content-length", "0");
    return { request, status: 201, headers };
  }
}

function fixture(transport = new AzureTransport()) {
  const container = new ContainerClient("https://synthetic.blob.core.windows.net/objects", undefined, {
    httpClient: transport,
    retryOptions: { maxTries: 1 },
  });
  return { transport, store: new AzureBlobStore(container) };
}

describe("AzureBlobStore", () => {
  it("creates immutable ciphertext wrappers and performs conditional versioned updates", async () => {
    const { transport, store } = fixture();
    await store.create(key, ciphertext);
    expect(JSON.parse(transport.text ?? "")).toEqual({ version: 1, value: ciphertext });
    expect(transport.requests[0]?.headers.get("if-none-match")).toBe("*");
    await expect(store.create(key, { ciphertext: "replacement" })).rejects.toBeInstanceOf(ObjectAlreadyExistsError);
    expect(await store.read(key)).toEqual({ version: 1, value: ciphertext });
    const oldEtag = transport.etag;
    await expect(store.compareAndSwap(key, 1, { ciphertext: "next" })).resolves.toBe(2);
    expect(transport.requests.at(-1)?.headers.get("if-match")).toBe(oldEtag);
    expect(await store.read(key)).toEqual({ version: 2, value: { ciphertext: "next" } });
    const puts = transport.requests.filter((request) => request.method === "PUT").length;
    await expect(store.compareAndSwap(key, 1, null)).rejects.toBeInstanceOf(ConcurrentUpdateError);
    expect(transport.requests.filter((request) => request.method === "PUT")).toHaveLength(puts);
  });

  it("allows only one winner across independent clients racing on one ETag", async () => {
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
    expect(transport.requests.filter((request) => request.headers.get("if-match"))).toHaveLength(2);
    expect((await store.read(key))?.version).toBe(2);
  });

  it("recognizes only a missing blob, not missing containers or permission failures", async () => {
    const { transport, store } = fixture();
    await expect(store.read(key)).resolves.toBeUndefined();
    await expect(store.compareAndSwap(key, 1, null)).rejects.toBeInstanceOf(ObjectNotFoundError);
    for (const code of ["ContainerNotFound", "AuthorizationFailure", "UnknownFailure"]) {
      transport.error = { status: code === "AuthorizationFailure" ? 403 : 404, code };
      await expect(store.read(key)).rejects.toMatchObject({ details: { errorCode: code } });
      await expect(store.create(key, null)).rejects.toMatchObject({ details: { errorCode: code } });
    }
    transport.error = undefined;
    transport.networkError = new Error("Synthetic network failure.");
    await expect(store.read(key)).rejects.toBe(transport.networkError);
  });

  it("does not hide an ambiguous committed write behind a retry or read-back", async () => {
    const { transport, store } = fixture();
    transport.loseWriteResponse = true;
    await expect(store.create(key, ciphertext)).rejects.toThrow("Connection reset.");
    expect(transport.requests).toHaveLength(1);
    expect(transport.text).toBeDefined();
  });

  it("does not hide a committed CAS with a lost response", async () => {
    const { transport, store } = fixture();
    await store.create(key, ciphertext);
    transport.loseWriteResponse = true;
    await expect(store.compareAndSwap(key, 1, { ciphertext: "next" })).rejects.toThrow("Connection reset.");
    expect(transport.requests).toHaveLength(3);
    expect(JSON.parse(transport.text ?? "").version).toBe(2);
  });

  it("maps a failed CAS condition but propagates unrelated write failures", async () => {
    const { transport, store } = fixture();
    await store.create(key, ciphertext);
    transport.writeError = { status: 412, code: "ConditionNotMet" };
    await expect(store.compareAndSwap(key, 1, null)).rejects.toBeInstanceOf(ConcurrentUpdateError);
    transport.writeError = { status: 403, code: "AuthorizationFailure" };
    await expect(store.compareAndSwap(key, 1, null)).rejects.toMatchObject({
      details: { errorCode: "AuthorizationFailure" },
    });
  });

  it.each([
    "not-json",
    "null",
    "[]",
    '{"version":1}',
    '{"value":null}',
    '{"version":0,"value":null}',
    '{"version":-1,"value":null}',
    '{"version":1.5,"value":null}',
    '{"version":"1","value":null}',
    '{"version":9007199254740992,"value":null}',
  ])("fails closed on malformed stored wrappers: %s", async (text) => {
    const { transport, store } = fixture();
    transport.text = text;
    await expect(store.read(key)).rejects.toThrow("Invalid stored object.");
    await expect(store.compareAndSwap(key, 1, null)).rejects.toThrow();
    expect(transport.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("requires an ETag on reads and refuses unbounded streamed bodies", async () => {
    const { transport, store } = fixture();
    transport.text = '{"version":1,"value":null}';
    transport.omitEtag = true;
    await expect(store.read(key)).rejects.toThrow(/etag/i);
    await expect(store.compareAndSwap(key, 1, null)).rejects.toThrow(/etag/i);
    transport.omitEtag = false;
    transport.text = "x".repeat(4 * 1024 * 1024 + 1);
    await expect(store.read(key)).rejects.toThrow("size");
    transport.omitLength = true;
    await expect(store.read(key)).rejects.toThrow(/length|limits/);
  });

  it("rejects unsafe keys, versions, and unsupported JSON before any network request", async () => {
    const { transport, store } = fixture();
    for (const invalidKey of ["short", "../" + key, key + "/", "x".repeat(129), "é".repeat(32)]) {
      await expect(store.read(invalidKey)).rejects.toThrow("key");
      await expect(store.create(invalidKey, null)).rejects.toThrow("key");
      await expect(store.compareAndSwap(invalidKey, 1, null)).rejects.toThrow("key");
    }
    for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(store.compareAndSwap(key, version, null)).rejects.toThrow("version");
    }
    const circular: { self?: object } = {};
    circular.self = circular;
    const withGetter = Object.defineProperty({}, "value", { enumerable: true, get() { throw new Error("secret"); } });
    for (const value of [undefined, { missing: undefined }, [undefined], [,], NaN, Infinity, -0,
      1n, () => null, Symbol("synthetic"), new Date(0), new Map(), circular, withGetter,
      new Proxy({}, {}), "x".repeat(4 * 1024 * 1024 + 1)]) {
      await expect(store.create(key, value)).rejects.toThrow("Invalid or oversized storage object.");
      await expect(store.compareAndSwap(key, 1, value)).rejects.toThrow("Invalid or oversized storage object.");
    }
    expect(transport.requests).toHaveLength(0);
  });

  it("preserves all supported JSON values without altering ciphertext", async () => {
    const { store } = fixture();
    const value = { ciphertext: "opaque+/==_-", unicode: "é", values: [null, true, false, 0, 1.25, {}, []] };
    await store.create(key, value);
    expect(await store.read(key)).toEqual({ version: 1, value });
  });
});
