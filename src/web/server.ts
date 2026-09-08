import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AccessDeniedError,
  FileBlobStore,
  IntegrityError,
  InvalidFhirResourceError,
  PatientRecordService,
  RecordAlreadyExistsError,
  RecordNotFoundError,
  createClinicianCredential,
  type BlobStore,
  type ClinicianCredential,
  type FhirResource,
} from "../index.js";

const MAX_REQUEST_BYTES = 512 * 1024;
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";

interface WebServerOptions {
  store?: BlobStore;
  webRoot?: string;
}

interface AccessRequest {
  biometricToken: string;
  clinician: ClinicianCredential;
}

interface AppendApiRequest extends AccessRequest {
  resource: FhirResource;
}

export function createHealthRecordServer(options: WebServerOptions = {}) {
  const webRoot =
    options.webRoot ?? resolve(fileURLToPath(new URL("../../web", import.meta.url)));
  const store =
    options.store ?? new FileBlobStore(resolve(process.cwd(), ".data", "web"));
  const records = new PatientRecordService(store);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        await handleApiRequest(request, response, url.pathname, records);
        return;
      }
      await serveStaticFile(response, webRoot, url.pathname);
    } catch (error) {
      sendError(response, error);
    }
  });
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  records: PatientRecordService,
): Promise<void> {
  assertLocalOrigin(request);

  if (request.method === "GET" && path === "/api/status") {
    sendJson(response, 200, {
      status: "ok",
      mode: "local-poc",
      biometricMode: "synthetic-browser-token",
    });
    return;
  }

  function assertLocalOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin;
    if (origin === undefined) {
      return;
    }

    const hostname = new URL(origin).hostname;
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
      throw new RequestError(403, "Cross-origin requests are not allowed.");
    }
  }

  if (request.method === "POST" && path === "/api/clinicians") {
    sendJson(response, 201, createClinicianCredential());
    return;
  }

  if (request.method === "POST" && path === "/api/enroll") {
    const body = await readJson<AccessRequest>(request);
    assertAccessRequest(body);
    await records.enroll(body);
    sendJson(response, 201, { enrolled: true });
    return;
  }

  if (request.method === "POST" && path === "/api/records") {
    const body = await readJson<AppendApiRequest>(request);
    assertAccessRequest(body);
    if (!("resource" in body)) {
      throw new InvalidFhirResourceError("FHIR resource is required.");
    }
    const result = await records.append(body);
    sendJson(response, 201, result);
    return;
  }

  if (request.method === "POST" && path === "/api/timeline") {
    const body = await readJson<AccessRequest>(request);
    assertAccessRequest(body);
    sendJson(response, 200, {
      entries: await records.assemble(body),
    });
    return;
  }

  sendJson(response, 404, { error: "API endpoint not found." });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new RequestError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new RequestError(400, "Request body must contain valid JSON.");
  }
}

function assertAccessRequest(value: unknown): asserts value is AccessRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as AccessRequest).biometricToken !== "string" ||
    typeof (value as AccessRequest).clinician !== "object" ||
    (value as AccessRequest).clinician === null
  ) {
    throw new RequestError(
      400,
      "A synthetic biometric token and clinician credential are required.",
    );
  }
}

async function serveStaticFile(
  response: ServerResponse,
  webRoot: string,
  requestPath: string,
): Promise<void> {
  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const normalizedPath = normalize(relativePath);
  const absolutePath = resolve(webRoot, normalizedPath);
  const safeRoot = `${resolve(webRoot)}${sep}`;

  if (absolutePath !== resolve(webRoot) && !absolutePath.startsWith(safeRoot)) {
    sendJson(response, 404, { error: "File not found." });
    return;
  }

  try {
    const file = await stat(absolutePath);
    if (!file.isFile()) {
      sendJson(response, 404, { error: "File not found." });
      return;
    }
  } catch {
    sendJson(response, 404, { error: "File not found." });
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": contentTypeFor(absolutePath),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  createReadStream(absolutePath).pipe(response);
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/html; charset=utf-8";
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof RequestError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  if (error instanceof InvalidFhirResourceError) {
    sendJson(response, 400, { error: error.message });
    return;
  }
  if (error instanceof RecordAlreadyExistsError) {
    sendJson(response, 409, { error: error.message });
    return;
  }
  if (error instanceof RecordNotFoundError) {
    sendJson(response, 404, { error: error.message });
    return;
  }
  if (error instanceof AccessDeniedError) {
    sendJson(response, 403, { error: error.message });
    return;
  }
  if (error instanceof IntegrityError) {
    sendJson(response, 409, { error: error.message });
    return;
  }

  console.error("Local POC request failed:", error);
  sendJson(response, 500, { error: "Local POC request failed." });
}

class RequestError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT ?? `${DEFAULT_PORT}`, 10);
  const host = process.env.HOST ?? DEFAULT_HOST;
  const server = createHealthRecordServer();
  server.listen(port, host, () => {
    console.log(`Global Private Health Records POC: http://${host}:${port}`);
    console.log("Synthetic data only. Press Ctrl+C to stop.");
  });
}
