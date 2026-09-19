import { describe, expect, it, vi } from "vitest";
import { IpfsClusterClient } from "../src/index.js";
import type { IpfsClusterClientOptions } from "../src/storage/ipfs-cluster-client.js";
import { MAX_DISTRIBUTED_BLOB_BYTES, rawContentCid, validateRawCid } from "../src/storage/distributed-blob-store.js";

const bytes = Uint8Array.from([1, 2, 3]);
const base = { kuboUrl: "https://kubo.invalid", clusterUrl: "https://cluster.invalid" };
const asJson = (value: unknown) => new Response(JSON.stringify(value));
type Hook = (url: URL, init: RequestInit | undefined) => Response | undefined | Promise<Response | undefined>;

async function fixture(options: Partial<IpfsClusterClientOptions> = {}, hook?: Hook) {
  const cid = await rawContentCid(bytes);
  const peers = [
    { id: "cluster-a", error: "", ipfs: { id: "ipfs-a", error: "" } },
    { id: "cluster-b", error: "", ipfs: { id: "ipfs-b", error: "" } },
  ];
  const status = { cid, peer_map: {
    "cluster-a": { status: "pinned", error: "", ipfs_peer_id: "ipfs-a" },
    "cluster-b": { status: "pinned", error: "", ipfs_peer_id: "ipfs-b" },
  } };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const overridden = await hook?.(url, init);
    if (overridden) return overridden;
    if (url.pathname.endsWith("/block/put")) return asJson({ Key: cid, Size: bytes.length });
    if (url.pathname.endsWith("/block/get")) return new Response(bytes);
    if (url.pathname === "/peers") return new Response(peers.map((peer) => JSON.stringify(peer)).join("\n"));
    if (init?.method === "POST") return asJson({ cid });
    return asJson(status);
  });
  const client = new IpfsClusterClient({ ...base, timeoutMs: 50, pollIntervalMs: 1, ...options, fetch });
  return { client, cid, fetch, status, peers };
}

describe("IpfsClusterClient", () => {
  it("uses actual raw Kubo multipart and Cluster allocation APIs", async () => {
    const { client, cid, fetch } = await fixture({
      kuboAuthorization: "Bearer kubo-test-secret",
      clusterAuthorization: "Basic cluster-test-secret",
    });
    expect(await client.put(bytes)).toBe(cid);
    expect(Uint8Array.from(await client.get(cid))).toEqual(bytes);
    const [firstUrl, firstInit] = fetch.mock.calls[0]!;
    const url = new URL(String(firstUrl));
    expect(url.pathname).toBe("/api/v0/block/put");
    expect(url.searchParams.get("cid-codec")).toBe("raw");
    expect(url.searchParams.get("mhtype")).toBe("sha2-256");
    expect(url.searchParams.get("pin")).toBe("true");
    const file = (firstInit?.body as FormData).get("file") as Blob;
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    const pinUrl = new URL(String(fetch.mock.calls[1]![0]));
    expect(pinUrl.searchParams.get("replication-min")).toBe("2");
    expect(pinUrl.searchParams.get("replication-max")).toBe("2");
    for (const [input, init] of fetch.mock.calls) {
      const request = new URL(String(input));
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toEqual({ Authorization: request.hostname === "kubo.invalid"
        ? "Bearer kubo-test-secret" : "Basic cluster-test-secret" });
      expect(String(input)).not.toContain("secret");
    }
  });

  it("accepts array and NDJSON peer responses and explicit isolated min=1", async () => {
    const { client, cid, peers } = await fixture({ minReplicas: 1, maxReplicas: 1 },
      (url) => url.pathname === "/peers" ? asJson([peers[0]]) : undefined);
    expect(await client.put(bytes)).toBe(cid);
  });

  it.each(["pinning", "pin_error", "cluster_error", "remote", "unpinned"])(
    "does not count %s as replicated", async (state) => {
      const { client, status } = await fixture();
      status.peer_map["cluster-b"].status = state;
      await expect(client.put(bytes)).rejects.toThrow("timed out");
    },
  );

  it("rejects stale pinned status when the corresponding peer is offline", async () => {
    const { client, peers } = await fixture();
    peers[1]!.error = "offline";
    await expect(client.put(bytes)).rejects.toThrow("timed out");
  });

  it("rejects stale pinned state if Kubo is unavailable", async () => {
    const { client, peers } = await fixture();
    peers[1]!.ipfs.error = "offline";
    await expect(client.put(bytes)).rejects.toThrow("timed out");
  });

  it("does not double-count distinct Cluster peers using the same Kubo", async () => {
    const { client, peers, status } = await fixture();
    peers[1]!.ipfs.id = "ipfs-a";
    status.peer_map["cluster-b"].ipfs_peer_id = "ipfs-a";
    await expect(client.put(bytes)).rejects.toThrow("timed out");
  });

  it("does not count duplicated or identity-mismatched peers", async () => {
    const { client, peers } = await fixture();
    peers.push(peers[1]!);
    await expect(client.put(bytes)).rejects.toThrow("timed out");
    peers.pop();
    peers[1]!.ipfs.id = "changed";
    await expect(client.put(bytes)).rejects.toThrow("timed out");
  });

  it.each([404, 500, 503, 302])("sanitizes HTTP %s and does not fall back", async (code) => {
    const { client, cid, fetch } = await fixture({}, () =>
      new Response("secret-password synthetic-plaintext", { status: code }));
    await expect(client.get(cid)).rejects.toThrow("Private distributed storage operation failed.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sanitizes thrown fetch errors", async () => {
    const { client, cid } = await fixture({}, () => { throw new Error("Bearer secret"); });
    const error = await client.get(cid).catch((reason: unknown) => reason);
    expect(String(error)).not.toContain("secret");
    expect(error).not.toHaveProperty("cause");
  });

  it("bounds both stalled fetch and body consumption", async () => {
    const stalled = await fixture({ timeoutMs: 10 }, () => new Promise(() => undefined));
    await expect(stalled.client.get(stalled.cid)).rejects.toThrow("timed out");
    const cancelled = vi.fn();
    const body = await fixture({ timeoutMs: 10 }, () =>
      new Response(new ReadableStream({ cancel: cancelled })));
    await expect(body.client.get(body.cid)).rejects.toThrow("timed out");
    expect(cancelled).toHaveBeenCalled();
  });

  it("rejects tampered and truncated bytes and oversized bodies", async () => {
    for (const response of [
      new Response(Uint8Array.from([3, 2, 1])),
      new Response(bytes.slice(0, 2)),
      new Response(bytes, { headers: { "content-length": "4" } }),
      new Response(bytes, { headers: { "content-length": "9999999" } }),
      new Response(new Uint8Array(MAX_DISTRIBUTED_BLOB_BYTES + 1)),
    ]) {
      const { client, cid } = await fixture({}, () => response);
      await expect(client.get(cid)).rejects.toThrow("failed");
    }
  });

  it("does not pin incorrect Kubo CID or size responses", async () => {
    for (const result of [{ Key: "invalid", Size: 3 },
      { Key: await rawContentCid(Uint8Array.from([9])), Size: 3 },
      { Key: await rawContentCid(bytes), Size: 2 }]) {
      const { client, fetch } = await fixture({}, () => asJson(result));
      await expect(client.put(bytes)).rejects.toThrow("failed");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects malformed and mismatched Cluster status", async () => {
    const { client } = await fixture({}, (url, init) =>
      url.pathname.startsWith("/pins/") && init?.method === "GET"
        ? asJson({ cid: "invalid", peer_map: {} }) : undefined);
    await expect(client.put(bytes)).rejects.toThrow("failed");
  });

  it("fails closed on pin submission errors without polling or fallback", async () => {
    const { client, fetch } = await fixture({}, (url, init) =>
      url.pathname.startsWith("/pins/") && init?.method === "POST"
        ? new Response("secret pin error", { status: 500 }) : undefined);
    await expect(client.put(bytes)).rejects.toThrow("failed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("polls until actual pinning completes", async () => {
    let polls = 0;
    const { client, cid, status } = await fixture({}, (url, init) => {
      if (url.pathname.startsWith("/pins/") && init?.method === "GET") {
        status.peer_map["cluster-b"].status = ++polls < 2 ? "pinning" : "pinned";
      }
      return undefined;
    });
    expect(await client.put(bytes)).toBe(cid);
    expect(polls).toBe(2);
  });

  it("refuses a redirected response even from an injected transport", async () => {
    const response = new Response(bytes);
    Object.defineProperty(response, "redirected", { value: true });
    const { client, cid } = await fixture({}, () => response);
    await expect(client.get(cid)).rejects.toThrow("failed");
  });

  it("rejects invalid CID before contacting a server", async () => {
    const { client, fetch } = await fixture();
    for (const cid of ["", "../private", "QmYwAPJzv5CZsnAzt8auVZRnGi2C8AzSmNQnbqqArBpuGY"]) {
      await expect(client.get(cid)).rejects.toThrow("identifier");
      expect(() => validateRawCid(cid)).toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces write and configured read size limits", async () => {
    const { client, cid, fetch } = await fixture({ maxBlobBytes: 2 });
    await expect(client.put(bytes)).rejects.toThrow("size");
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.get(cid)).rejects.toThrow("failed");
    await expect(client.put(new Uint8Array())).rejects.toThrow("size");
  });

  it.each([
    "http://kubo.invalid", "http://localhost", "https://user:secret@kubo.invalid",
    "https://kubo.invalid?secret=x", "https://kubo.invalid#secret",
    "https://kubo.invalid/path", "ftp://kubo.invalid", "not a URL",
  ])("rejects unsafe endpoint %s", (kuboUrl) => {
    expect(() => new IpfsClusterClient({ ...base, kuboUrl })).toThrow("endpoint");
  });

  it("allows only explicitly enabled loopback HTTP", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(() => new IpfsClusterClient({ ...base, kuboUrl: `http://${host}:5001`,
        allowInsecureLocal: true })).not.toThrow();
    }
    expect(() => new IpfsClusterClient({ ...base, kuboUrl: "http://10.0.0.1",
      allowInsecureLocal: true })).toThrow("endpoint");
  });

  it.each([
    { minReplicas: 0 }, { minReplicas: 3 }, { minReplicas: 2, maxReplicas: 1 },
    { timeoutMs: 0 }, { pollIntervalMs: 0 }, { maxBlobBytes: 1024 * 1024 },
    { kuboAuthorization: "secret\r\ninjected" }, { clusterAuthorization: "" },
  ])("rejects invalid configuration %j", (options) => {
    expect(() => new IpfsClusterClient({ ...base, ...options })).toThrow();
  });
});
