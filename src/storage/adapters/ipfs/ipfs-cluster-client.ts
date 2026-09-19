import { setTimeout as delay } from "node:timers/promises";
import {
  MAX_DISTRIBUTED_BLOB_BYTES,
  rawContentCid,
  validateRawCid,
  type DistributedContentStore,
} from "./distributed-blob-store.js";

export interface IpfsClusterClientOptions {
  kuboUrl: string;
  clusterUrl: string;
  kuboAuthorization?: string;
  clusterAuthorization?: string;
  allowInsecureLocal?: boolean;
  minReplicas?: number;
  maxReplicas?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxBlobBytes?: number;
  fetch?: typeof globalThis.fetch;
}

function endpoint(value: string, allowInsecureLocal: boolean): URL {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
        /[?#]/.test(value) || url.pathname !== "/" ||
        (url.protocol !== "https:" &&
         !(allowInsecureLocal && local && url.protocol === "http:"))) throw new Error();
    return url;
  } catch {
    throw new Error("Invalid private storage endpoint.");
  }
}

function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error("Invalid private storage configuration.");
  }
  return value;
}

function authorization(value: string | undefined): string | undefined {
  if (value !== undefined &&
      (typeof value !== "string" || value.length === 0 ||
       value.length > 8192 || /[^\x20-\x7e]/.test(value))) {
    throw new Error("Invalid private storage authorization.");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid private storage response.");
  }
  return value as Record<string, unknown>;
}

function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Invalid private storage response.");
  }
}

function peerList(bytes: Uint8Array): unknown[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  try {
    if (text.startsWith("[")) return JSON.parse(text) as unknown[];
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  } catch {
    throw new Error("Invalid private storage response.");
  }
}

/** Private Kubo RPC + Cluster REST only; never uses a gateway or fallback. */
export class IpfsClusterClient implements DistributedContentStore {
  readonly #kubo: URL;
  readonly #cluster: URL;
  readonly #kuboAuth: string | undefined;
  readonly #clusterAuth: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #min: number;
  readonly #max: number;
  readonly #timeout: number;
  readonly #poll: number;
  readonly #maxBytes: number;

  public constructor(options: IpfsClusterClientOptions) {
    this.#kubo = endpoint(options.kuboUrl, options.allowInsecureLocal === true);
    this.#cluster = endpoint(options.clusterUrl, options.allowInsecureLocal === true);
    this.#kuboAuth = authorization(options.kuboAuthorization);
    this.#clusterAuth = authorization(options.clusterAuthorization);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#min = integer(options.minReplicas ?? 2, 1, 1000);
    this.#max = integer(options.maxReplicas ?? 2, this.#min, 1000);
    this.#timeout = integer(options.timeoutMs ?? 30_000, 1, 600_000);
    this.#poll = integer(options.pollIntervalMs ?? 250, 1, 60_000);
    this.#maxBytes = integer(options.maxBlobBytes ?? MAX_DISTRIBUTED_BLOB_BYTES,
      1, MAX_DISTRIBUTED_BLOB_BYTES);
  }

  public async put(input: Uint8Array): Promise<string> {
    if (!(input instanceof Uint8Array) || input.byteLength > this.#maxBytes) {
      throw new Error("Invalid distributed content size.");
    }
    const bytes = Uint8Array.from(input);
    const cid = await rawContentCid(bytes);
    return this.bounded(async (signal) => {
      const form = new FormData();
      form.append("file", new Blob([bytes]), "block");
      const result = record(json(await this.request(false,
        "/api/v0/block/put?cid-codec=raw&mhtype=sha2-256&mhlen=32&pin=true&allow-big-block=false",
        "POST", signal, form)));
      if (validateRawCid(result.Key) !== cid || result.Size !== bytes.byteLength) {
        throw new Error("Distributed content integrity check failed.");
      }
      await this.request(true,
        `/pins/${cid}?replication-min=${this.#min}&replication-max=${this.#max}`,
        "POST", signal);
      while (true) {
        const status = record(json(await this.request(true, `/pins/${cid}?local=false`,
          "GET", signal)));
        if (status.cid !== cid) throw new Error("Invalid private storage response.");
        const peers = peerList(await this.request(true, "/peers", "GET", signal));
        if (this.replicaCount(status, peers) >= this.#min) return cid;
        await delay(this.#poll, undefined, { signal });
      }
    });
  }

  public async get(value: string): Promise<Uint8Array> {
    const cid = validateRawCid(value);
    return this.bounded(async (signal) => {
      const bytes = await this.request(false, `/api/v0/block/get?arg=${cid}`,
        "POST", signal, undefined, this.#maxBytes);
      if (await rawContentCid(bytes) !== cid) {
        throw new Error("Distributed content integrity check failed.");
      }
      return bytes;
    });
  }

  private replicaCount(status: Record<string, unknown>, peers: unknown[]): number {
    const live = new Map<string, string>();
    const duplicates = new Set<string>();
    const seen = new Set<string>();
    for (const value of peers) {
      const peer = record(value);
      if (typeof peer.id !== "string" || !peer.id) continue;
      if (seen.has(peer.id)) duplicates.add(peer.id);
      seen.add(peer.id);
      if (peer.error !== "" && peer.error !== undefined) continue;
      const ipfs = record(peer.ipfs);
      if ((ipfs.error === "" || ipfs.error === undefined) &&
          typeof ipfs.id === "string" && ipfs.id) live.set(peer.id, ipfs.id);
    }
    const distinctIpfs = new Set<string>();
    for (const [id, value] of Object.entries(record(status.peer_map))) {
      const pin = record(value);
      const ipfsId = live.get(id);
      if (!duplicates.has(id) && ipfsId && pin.status === "pinned" &&
          (pin.error === "" || pin.error === undefined) &&
          pin.ipfs_peer_id === ipfsId) distinctIpfs.add(ipfsId);
    }
    return distinctIpfs.size;
  }

  private async bounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    let aborted: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new Error("Deadline exceeded."));
        controller.signal.addEventListener("abort", aborted, { once: true });
      });
      return await Promise.race([operation(controller.signal), deadline]);
    } catch {
      // Never include upstream bodies, URLs, nested causes, or authentication.
      throw new Error(controller.signal.aborted
        ? "Private distributed storage operation timed out."
        : "Private distributed storage operation failed.");
    } finally {
      clearTimeout(timer);
      if (aborted) controller.signal.removeEventListener("abort", aborted);
    }
  }

  private async request(
    cluster: boolean,
    path: string,
    method: string,
    signal: AbortSignal,
    body?: FormData,
    maximum = 1024 * 1024,
  ): Promise<Uint8Array> {
    signal.throwIfAborted();
    const auth = cluster ? this.#clusterAuth : this.#kuboAuth;
    const response = await this.#fetch(new URL(path, cluster ? this.#cluster : this.#kubo), {
      method, signal, redirect: "error", cache: "no-store",
      headers: auth === undefined ? {} : { Authorization: auth },
      ...(body === undefined ? {} : { body }),
    });
    const reader = response.body?.getReader();
    const cancel = (): void => { void reader?.cancel().catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      if (!response.ok || response.redirected || !reader) throw new Error();
      const length = response.headers.get("content-length");
      const expected = length === null ? undefined : Number(length);
      if (expected !== undefined &&
          (!/^\d+$/.test(length!) || !Number.isSafeInteger(expected) || expected > maximum)) {
        throw new Error();
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) {
          signal.throwIfAborted();
          break;
        }
        size += value.byteLength;
        if (size > maximum) throw new Error();
        chunks.push(value);
      }
      if (expected !== undefined && size !== expected) throw new Error();
      return Buffer.concat(chunks, size);
    } finally {
      signal.removeEventListener("abort", cancel);
      void reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  }
}
