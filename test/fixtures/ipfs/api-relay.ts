import { once } from "node:events";
import { createConnection, createServer, isIPv4, type Socket } from "node:net";

export interface ApiRelay {
  endpoint: string;
  close(): Promise<void>;
}

export function isPrivateIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 10 || (first === 172 && second! >= 16 && second! <= 31)
    || (first === 192 && second === 168);
}

// Docker does not publish ports on an internal-only network. Its native Linux
// host can reach the bridge directly, without giving containers an egress route.
export async function createApiRelay(address: string, port: number): Promise<ApiRelay> {
  if ((!isPrivateIPv4(address) && address !== "127.0.0.1")
    || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Fixture relay requires a private endpoint.");
  }
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = createConnection({ host: address, port });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
      socket.setTimeout(30_000, () => socket.destroy());
    }
    client.once("close", () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const binding = server.address();
  if (!binding || typeof binding === "string" || binding.address !== "127.0.0.1") {
    server.close();
    throw new Error("Fixture relay did not bind loopback.");
  }
  let closing: Promise<void> | undefined;
  return {
    endpoint: `http://127.0.0.1:${binding.port}`,
    close() {
      closing ??= new Promise<void>((done, reject) => {
        server.close((error) => error ? reject(new Error("Fixture relay cleanup failed.")) : done());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
