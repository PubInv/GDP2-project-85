import { once } from "node:events";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { createApiRelay, isPrivateIPv4 } from "./api-relay.js";

describe("private fixture API relay (no Docker required)", () => {
  it("restricts container addresses to private IPv4", () => {
    for (const address of ["10.0.0.1", "172.16.0.2", "172.31.255.254", "192.168.1.1"]) {
      expect(isPrivateIPv4(address)).toBe(true);
    }
    for (const address of ["172.15.0.1", "172.32.0.1", "8.8.8.8", "0.0.0.0", "::1", "example.test"]) {
      expect(isPrivateIPv4(address)).toBe(false);
    }
  });

  it("rejects public relay destinations and invalid ports", async () => {
    for (const address of ["8.8.8.8", "0.0.0.0", "::1", "example.test"]) {
      await expect(createApiRelay(address, 5001)).rejects.toThrow("private endpoint");
    }
    for (const port of [0, 65_536, 1.5, NaN]) {
      await expect(createApiRelay("127.0.0.1", port)).rejects.toThrow("private endpoint");
    }
  });

  it("relays complete binary HTTP bodies using only a loopback listener", async () => {
    const upstream = createServer((request, response) => {
      response.setHeader("content-type", "application/octet-stream");
      request.pipe(response);
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Test server failed.");
    const relay = await createApiRelay("127.0.0.1", address.port);
    try {
      expect(new URL(relay.endpoint).hostname).toBe("127.0.0.1");
      const bytes = new Uint8Array(262_144).map((_, index) => index % 256);
      const response = await fetch(`${relay.endpoint}/api/v0/block/put`, {
        method: "POST", body: bytes, signal: AbortSignal.timeout(5_000),
      });
      expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
      const client = createConnection({ host: "127.0.0.1", port: Number(new URL(relay.endpoint).port) });
      await once(client, "connect");
      const disconnected = once(client, "close");
      await relay.close();
      await disconnected;
      await relay.close();
      await expect(fetch(relay.endpoint, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
    } finally {
      await relay.close();
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
    }
  });
});
