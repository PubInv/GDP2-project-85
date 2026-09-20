import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryBlobStore, SUPPORTED_FHIR_RESOURCE_TYPES } from "../src/index.js";
import { createHealthRecordServer } from "../src/web/server.js";

interface SwaggerRequest {
  url: string;
  credentials?: string;
}

interface SwaggerOptions {
  url: string;
  validatorUrl: null;
  queryConfigEnabled: boolean;
  persistAuthorization: boolean;
  supportedSubmitMethods: string[];
  requestInterceptor(request: SwaggerRequest): SwaggerRequest;
}

describe("local Swagger workbench", () => {
  let server: ReturnType<typeof createHealthRecordServer>;
  let origin: string;
  const windows: Window[] = [];

  beforeEach(async () => {
    server = createHealthRecordServer({
      store: new InMemoryBlobStore(),
      webRoot: resolve("web"),
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local TCP server.");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const window of windows.splice(0)) await window.happyDOM.close();
    await new Promise<void>((done, reject) => {
      server.close((error) => error ? reject(error) : done());
    });
  });

  it("serves both docs URLs with self-hosted assets and scoped browser policy", async () => {
    for (const path of ["/docs", "/docs/"]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      const policy = response.headers.get("content-security-policy");
      expect(policy).toContain("script-src 'self';");
      expect(policy).toContain("connect-src 'self';");
      expect(policy).toContain("style-src 'self' 'unsafe-inline';");
      expect(policy).not.toContain("unsafe-eval");
      const html = await response.text();
      expect(html).toContain("Synthetic data only");
      expect(html).toContain("/docs/swagger-ui-bundle.js");
      expect(html).not.toMatch(/<(?:script|link|iframe)[^>]+(?:src|href)="https?:/);
    }
    const main = await fetch(origin);
    expect(main.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    for (const [path, type] of [
      ["/docs/swagger-ui-bundle.js", "text/javascript"],
      ["/docs/swagger-ui.css", "text/css"],
      ["/docs/swagger-initializer.js", "text/javascript"],
      ["/docs/docs.css", "text/css"],
    ]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(type);
      expect((await response.text()).length).toBeGreaterThan(0);
    }
  });

  it("does not expose arbitrary package files or accept documentation writes", async () => {
    for (const path of ["/docs/package.json", "/docs/oauth2-redirect.html", "/docs/swagger-ui.js"]) {
      expect((await fetch(`${origin}${path}`)).status).toBe(404);
    }
    const response = await fetch(`${origin}/docs`, { method: "POST", body: "{}" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("serves a same-origin OpenAPI document with complete operations and local references", async () => {
    const response = await fetch(`${origin}/openapi.json`);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const spec = await response.json();
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.servers).toEqual([{ url: "/", description: expect.any(String) }]);
    expect(new URL(spec.servers[0].url, `${origin}/openapi.json`).origin).toBe(origin);
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/api/clinicians", "/api/enroll", "/api/records", "/api/status", "/api/timeline",
    ]);
    const operations = Object.values(spec.paths).flatMap((path) => Object.values(path as object));
    expect(operations).toHaveLength(5);
    expect(spec.components.schemas.ResourceType.enum).toEqual([...SUPPORTED_FHIR_RESOURCE_TYPES]);
    expect(spec.components.schemas.ClinicianCredential.required).toEqual([
      "credentialId", "publicKeyPem", "privateKeyPem",
    ]);
    expect(spec.components.schemas.AccessRequest.properties.biometricToken.minLength).toBe(16);
    expect(spec.paths["/api/clinicians"].post.requestBody).toBeUndefined();

    function checkReferences(value: unknown): void {
      if (!value || typeof value !== "object") return;
      if ("$ref" in value) {
        expect(typeof value.$ref).toBe("string");
        const ref = String(value.$ref);
        expect(ref).toMatch(/^#\/components\//);
        let target: unknown = spec;
        for (const part of ref.slice(2).split("/")) {
          expect(target).toHaveProperty(part);
          if (!target || typeof target !== "object" || !(part in target)) {
            throw new Error("Unresolved local OpenAPI reference.");
          }
          target = Reflect.get(target, part);
        }
      }
      for (const child of Object.values(value)) checkReferences(child);
    }
    checkReferences(spec);
    const serialized = JSON.stringify(spec);
    expect(serialized).not.toMatch(/BEGIN (?:RSA )?PRIVATE KEY/);
    expect(spec.components.securitySchemes).toBeUndefined();
  });

  it("disables external validation/config overrides and intercepts off-origin calls", async () => {
    const window = new Window({ url: `${origin}/docs?url=https://example.test/spec.json` });
    windows.push(window);
    const bundle = Object.assign(vi.fn<(options: SwaggerOptions) => void>(), { presets: { apis: {} } });
    Object.assign(window, { SwaggerUIBundle: bundle });
    window.eval(await readFile(resolve("web/api-docs/swagger-initializer.js"), "utf8"));
    const options = bundle.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    expect(options).toMatchObject({
      url: "/openapi.json", validatorUrl: null, queryConfigEnabled: false,
      persistAuthorization: false, supportedSubmitMethods: ["get", "post"],
    });
    expect(options!.requestInterceptor({ url: `${origin}/api/status` }).credentials).toBe("same-origin");
    for (const url of [
      "https://example.test/api/enroll", "//example.test/api/timeline",
      "http://127.0.0.1:1/api/status", "data:text/plain,not-an-api",
      `${origin.replace("://", "://username@")}/api/status`,
    ]) {
      expect(() => options!.requestInterceptor({ url })).toThrow("own local server");
    }
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("renders the real Swagger bundle and executes status through Try it out", async () => {
    const window = new Window({ url: `${origin}/docs` });
    windows.push(window);
    window.document.body.innerHTML = '<div id="swagger-ui"></div>';
    const requested: string[] = [];
    window.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : "url" in input ? input.url : input.href,
        origin,
      );
      expect(url.origin).toBe(origin);
      requested.push(url.pathname);
      const response = await fetch(url, {
        method: init?.method ?? "GET",
        headers: { "Content-Type": "application/json", Origin: origin },
      });
      return new window.Response(await response.text(), {
        status: response.status,
        // Happy DOM preserves header casing; native fetch iterates lowercase names.
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
      });
    };
    const bundle = createRequire(import.meta.url).resolve("swagger-ui-dist/swagger-ui-bundle.js");
    window.eval(await readFile(bundle, "utf8"));
    window.eval(await readFile(resolve("web/api-docs/swagger-initializer.js"), "utf8"));
    await vi.waitFor(() => {
      expect(window.document.querySelectorAll(".opblock")).toHaveLength(5);
    }, { timeout: 10_000 });
    const status = window.document.querySelector("#operations-Status-getLocalStatus");
    expect(status).not.toBeNull();
    status!.querySelector("button.opblock-summary-control")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(status!.querySelector(".try-out__btn")).not.toBeNull());
    status!.querySelector(".try-out__btn")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(status!.querySelector("button.execute")).not.toBeNull());
    status!.querySelector("button.execute")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(requested).toEqual(["/openapi.json", "/api/status"]));
    await vi.waitFor(() => expect(status!.querySelector(".live-responses-table")?.textContent)
      .toContain("synthetic-browser-token"));
    expect(window.localStorage.length).toBe(0);
  }, 15_000);

  it("runs the documented examples against the local API without cloud accounts", async () => {
    const spec = await (await fetch(`${origin}/openapi.json`)).json();
    const post = (path: string, body?: unknown) => fetch(new URL(path, origin), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const clinicianResponse = await post("/api/clinicians");
    expect(clinicianResponse.status).toBe(201);
    const clinician = await clinicianResponse.json();
    const access = {
      ...spec.components.requestBodies.Access.content["application/json"].example,
      biometricToken: randomBytes(32).toString("base64url"),
      clinician,
    };
    const enrolled = await post("/api/enroll", access);
    expect(enrolled.status).toBe(201);
    expect(await enrolled.json()).toEqual({ enrolled: true });
    expect((await post("/api/enroll", access)).status).toBe(409);
    const appended = await post("/api/records", {
      ...spec.paths["/api/records"].post.requestBody.content["application/json"].example,
      ...access,
    });
    expect(appended.status).toBe(201);
    const identifiers = await appended.json();
    expect(Object.keys(identifiers).sort()).toEqual(["eventId", "fragmentId"]);
    const timeline = await post("/api/timeline", access);
    expect(timeline.status).toBe(200);
    const result = await timeline.json();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].event.eventId).toBe(identifiers.eventId);
    expect(result.entries[0].resource.id).toBe("synthetic-swagger-condition");
    expect((await post("/api/enroll", {})).status).toBe(400);
    expect((await post("/api/records", { ...access, resource: { resourceType: "Patient" } })).status).toBe(400);
    expect((await post("/api/timeline", { ...access, biometricToken: randomBytes(32).toString("hex") })).status).toBe(404);
    const other = await (await post("/api/clinicians")).json();
    expect((await post("/api/timeline", { ...access, clinician: other })).status).toBe(403);
    const rejected = await fetch(`${origin}/api/clinicians`, {
      method: "POST", headers: { Origin: "https://example.test" },
    });
    expect(rejected.status).toBe(403);
  });
});
