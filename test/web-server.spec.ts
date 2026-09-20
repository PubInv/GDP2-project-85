import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConcurrentUpdateError, InMemoryBlobStore } from "../src/index.js";
import { createHealthRecordServer } from "../src/web/server.js";

describe("local web server", () => {
  let server: ReturnType<typeof createHealthRecordServer>;
  let origin: string;
  let store: InMemoryBlobStore;

  beforeEach(async () => {
    store = new InMemoryBlobStore();
    server = createHealthRecordServer({
      store,
      webRoot: resolve("web"),
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolveClose();
      });
    });
  });

  it("serves the local UI with restrictive browser headers", async () => {
    const response = await fetch(origin);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(html).toContain("Global Patient Record Project");
    expect(html).toContain("Create sample patient and records");
    expect(html).toContain("A private record.");
    expect(html).toContain('id="timeline-state"');
    expect(html).toContain("sent to the local server");
    expect(html).not.toMatch(/<(?:script|link|img|iframe)[^>]+(?:src|href)="https?:/);
  });

  it("serves the dependency-free stylesheet and timeline script locally", async () => {
    const [stylesheet, script] = await Promise.all([
      fetch(`${origin}/styles.css`),
      fetch(`${origin}/app.js`),
    ]);
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("content-type")).toContain("text/css");
    expect(await stylesheet.text()).toContain(".principles-band");
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("Inspect verification details");
  });

  it("supports enrollment, append, and verified timeline APIs", async () => {
    const clinicianResponse = await post("/api/clinicians", {});
    expect(clinicianResponse.status).toBe(201);
    const clinician = await clinicianResponse.json();
    const access = {
      biometricToken:
        "synthetic-browser-factor-57b66002a0a94c1cb24d854b46fb38be",
      clinician,
    };

    expect((await post("/api/enroll", access)).status).toBe(201);
    expect(
      (
        await post("/api/records", {
          ...access,
          resource: {
            resourceType: "Condition",
            id: "synthetic-web-condition",
            subject: { reference: "Patient/ephemeral" },
            clinicalStatus: { text: "active" },
            code: { text: "Synthetic browser condition" },
          },
        })
      ).status,
    ).toBe(201);

    const timelineResponse = await post("/api/timeline", access);
    expect(timelineResponse.status).toBe(200);
    const timeline = await timelineResponse.json();
    expect(timeline.entries).toHaveLength(1);
    expect(timeline.entries[0].resource).toMatchObject({
      resourceType: "Condition",
      id: "synthetic-web-condition",
    });
  });

  it("rejects an unrecognized clinician credential", async () => {
    const clinician = await (await post("/api/clinicians", {})).json();
    const otherClinician = await (await post("/api/clinicians", {})).json();
    const access = {
      biometricToken:
        "synthetic-browser-factor-e6a159a26f1e451c9997a9441c8b680c",
      clinician,
    };
    await post("/api/enroll", access);

    const response = await post("/api/timeline", {
      biometricToken: access.biometricToken,
      clinician: otherClinician,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error:
        "The patient factor and clinician credential could not unlock the record.",
    });
  });

  it("rejects API requests from non-local browser origins", async () => {
    const response = await fetch(`${origin}/api/clinicians`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.test",
      },
      body: "{}",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Cross-origin requests are not allowed.",
    });
  });

  it("does not disclose provider diagnostics to logs or HTTP clients", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(store, "read").mockRejectedValue(new Error("SYNTHETIC-DIAGNOSTIC-MARKER"));
    const clinician = await (await post("/api/clinicians", {})).json();
    const response = await post("/api/enroll", {
      clinician, biometricToken: "synthetic-provider-failure-0123456789abcdef",
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Local POC request failed." });
    expect(log).toHaveBeenCalledWith("Local POC request failed; diagnostic details withheld.");
    expect(JSON.stringify(log.mock.calls)).not.toContain("SYNTHETIC-DIAGNOSTIC-MARKER");
  });

  it("surfaces CAS conflicts without exposing opaque storage keys", async () => {
    const clinician = await (await post("/api/clinicians", {})).json();
    const access = { clinician, biometricToken: "synthetic-cas-conflict-0123456789abcdef" };
    expect((await post("/api/enroll", access)).status).toBe(201);
    vi.spyOn(store, "compareAndSwap")
      .mockRejectedValue(new ConcurrentUpdateError("opaque-key-must-not-be-disclosed"));
    const response = await post("/api/records", {
      ...access,
      resource: { resourceType: "Condition", id: "synthetic-conflict", code: { text: "Synthetic" } },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Record changed concurrently. Unlock and try again.",
    });
  });

  async function post(path: string, value: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  }
});
