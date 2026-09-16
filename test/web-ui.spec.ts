import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  HTMLButtonElement,
  HTMLFormElement,
  HTMLInputElement,
  HTMLSelectElement,
  Window,
} from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";

describe("local web patient-factor controls", () => {
  it("populates and synchronizes every patient-factor dropdown", async () => {
    const window = new Window({
      url: "http://127.0.0.1:3000/#enroll",
    });
    const html = await readFile(resolve("web/index.html"), "utf8");
    const script = await readFile(resolve("web/app.js"), "utf8");
    window.document.write(html);
    window.fetch = async () =>
      new window.Response(
        JSON.stringify({
          status: "ok",
          mode: "local-poc",
          biometricMode: "synthetic-browser-token",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    window.eval(script);
    await window.happyDOM.waitUntilComplete();

    const selects = [
      requiredElement(window, "#enroll-factor", HTMLSelectElement),
      requiredElement(window, "#append-factor", HTMLSelectElement),
      requiredElement(window, "#timeline-factor", HTMLSelectElement),
    ];
    expect(selects.every((select) => select.disabled)).toBe(true);

    const input = requiredElement(window, "#factor-label", HTMLInputElement);
    input.value = "Synthetic patient A";
    const factorForm = requiredElement(window, "#factor-form", HTMLFormElement);
    factorForm.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );

    expect(selects.every((select) => !select.disabled)).toBe(true);
    expect(selects.map((select) => select.options.length)).toEqual([1, 1, 1]);
    expect(selects.map((select) => select.selectedOptions[0]?.text)).toEqual([
      "Synthetic patient A",
      "Synthetic patient A",
      "Synthetic patient A",
    ]);

    input.value = "Synthetic patient B";
    factorForm.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );

    expect(selects.map((select) => select.options.length)).toEqual([2, 2, 2]);
    expect(selects.map((select) => select.selectedOptions[0]?.text)).toEqual([
      "Synthetic patient B",
      "Synthetic patient B",
      "Synthetic patient B",
    ]);

    const enrollSelect = selects[0];
    const firstOption = enrollSelect?.options[0];
    expect(enrollSelect).toBeDefined();
    expect(firstOption).toBeDefined();
    enrollSelect!.value = firstOption!.value;
    enrollSelect!.dispatchEvent(
      new window.Event("change", { bubbles: true }),
    );
    expect(selects.map((select) => select.selectedOptions[0]?.text)).toEqual([
      "Synthetic patient A",
      "Synthetic patient A",
      "Synthetic patient A",
    ]);

    await window.happyDOM.close();
  });
});

describe("guided local research demo", () => {
  const windows: Window[] = [];
  const clinician = { credentialId: "synthetic-clinician" };
  const factors = [
    { id: "synthetic-a", label: "Synthetic A", token: "synthetic-token-a", createdAt: "2026-01-01T00:00:00Z" },
    { id: "synthetic-b", label: "Synthetic B", token: "synthetic-token-b", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const entry = {
    event: { recordedAt: "2026-01-01T00:00:00Z", eventId: "synthetic-event", parents: [] },
    resource: { resourceType: "Condition", id: "synthetic-record", code: { text: "Synthetic timeline content" } },
  };
  type ApiResult = { data: unknown; status?: number };
  type Responder = (path: string, body: Record<string, unknown>) => Promise<ApiResult>;

  afterEach(async () => {
    await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
  });

  async function openDemo(options: {
    section?: string;
    seeded?: boolean;
    responder?: Responder;
  } = {}) {
    const window = new Window({
      url: `http://127.0.0.1:3000/#${options.section ?? "timeline"}`,
    });
    windows.push(window);
    window.document.write(await readFile(resolve("web/index.html"), "utf8"));
    if (options.seeded !== false) {
      window.localStorage.setItem("gphr.poc.clinician", JSON.stringify(clinician));
      window.localStorage.setItem("gphr.poc.patient-factors", JSON.stringify(factors));
    }
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    window.fetch = async (url, init) => {
      const path = String(url);
      const body: Record<string, unknown> =
        typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const result: ApiResult = path === "/api/status"
        ? { data: { status: "ok" } }
        : await (async () => {
          requests.push({ path, body });
          return options.responder
            ? options.responder(path, body)
            : { data: { entries: [entry] } };
        })();
      return new window.Response(JSON.stringify(result.data), {
        status: result.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    window.eval(await readFile(resolve("web/app.js"), "utf8"));
    await window.happyDOM.waitUntilComplete();
    return { window, requests };
  }

  function submit(window: Window, selector: string) {
    requiredElement(window, selector, HTMLFormElement).dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  }

  function click(window: Window, selector: string) {
    requiredElement(window, selector, HTMLButtonElement).click();
  }

  it("uses the project identity, a skip link, current navigation, and heading focus", async () => {
    const { window } = await openDemo({ section: "unknown" });
    expect(window.document.title).toContain("Global Patient Record Project");
    expect(window.document.querySelector(".skip-link")?.getAttribute("href")).toBe("#main-content");
    expect(window.document.querySelector(".page.active")?.id).toBe("dashboard");
    click(window, "nav [data-section-link='about']");
    expect(window.document.activeElement).toBe(window.document.querySelector("#about h1"));
    expect(window.document.querySelector("[aria-current='page']")?.textContent).toBe("How it works");
    window.document.querySelector(".skip-link")?.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(window.document.activeElement).toBe(window.document.querySelector("#main-content"));
    expect(window.location.hash).toBe("#about");
    window.location.hash = "#enroll";
    await window.happyDOM.waitUntilComplete();
    expect(window.document.querySelector(".page.active")?.id).toBe("enroll");
  });

  it("separates learn, create, and private-view actions without opening a record on navigation", async () => {
    const { window, requests } = await openDemo({ section: "dashboard", seeded: false });
    expect(window.document.querySelector(".nav-learn")?.textContent).toContain("How it works");
    expect(window.document.querySelector(".nav-records")?.textContent).toContain("View timeline");
    expect(window.document.querySelector(".demo-band #sample-flow")).not.toBeNull();
    expect(window.document.querySelector(".hero #sample-flow")).toBeNull();
    click(window, ".hero [data-section-link='timeline']");
    expect(window.location.hash).toBe("#timeline");
    expect(window.document.querySelector("#timeline-state")?.textContent).toContain("Locked");
    expect(requests).toHaveLength(0);
    click(window, "nav [data-section-link='dashboard']");
    click(window, ".hero [data-section-link='enroll']");
    expect(window.document.activeElement).toBe(window.document.querySelector("#enroll h1"));
    expect(requests).toHaveLength(0);
    window.document.querySelector("footer [data-section-link='about']")?.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(window.location.hash).toBe("#about");
    expect(window.document.querySelector(".demo-notice")?.textContent).toContain("sent to the local server");
  });

  it("shows readable entry summaries with collapsed verification details and no public links", async () => {
    const { window } = await openDemo();
    submit(window, "#timeline-form");
    await window.happyDOM.waitUntilComplete();
    const card = window.document.querySelector(".timeline-entry");
    expect(card?.querySelector("time")?.getAttribute("datetime")).toBe(entry.event.recordedAt);
    expect(card?.querySelector("h2")?.textContent).toBe("1. Condition");
    expect(card?.querySelector(".verification-badge")?.textContent).toBe("Integrity verified");
    const details = card?.querySelector("details");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Inspect verification details");
    expect(details?.textContent).toContain("Signature, MAC, hash, and lineage valid");
    expect(card?.querySelector("a")).toBeNull();
    expect(window.document.querySelector("#timeline-state")?.textContent).toBe(
      "Verified · 1 entry · Integrity checks passed",
    );
    click(window, "#hide-timeline");
    expect(window.document.querySelector("#timeline-state")?.textContent).toBe(
      "Locked · No decrypted entries displayed",
    );
    expect(window.document.querySelector(".timeline-entry")).toBeNull();
  });

  it("distinguishes a verified empty record from a locked timeline", async () => {
    const { window } = await openDemo({ responder: async () => ({ data: { entries: [] } }) });
    submit(window, "#timeline-form");
    await window.happyDOM.waitUntilComplete();
    expect(window.document.querySelector("#timeline-state")?.textContent).toContain("Verified · 0 entries");
    expect(window.document.querySelector("#timeline-results")?.textContent).toContain("no entries yet");
    click(window, "nav [data-section-link='append']");
    expect(window.document.querySelector("#timeline-state")?.textContent).toContain("Locked");
  });

  it("renders entry descriptions as text, never as HTML or navigation", async () => {
    const description = "<a href='https://example.test'>Synthetic markup</a>";
    const { window } = await openDemo({
      responder: async () => ({
        data: { entries: [{ ...entry, resource: { ...entry.resource, code: { text: description } } }] },
      }),
    });
    submit(window, "#timeline-form");
    await window.happyDOM.waitUntilComplete();
    expect(window.document.querySelector(".timeline-entry > p")?.textContent).toBe(description);
    expect(window.document.querySelector(".timeline-entry a")).toBeNull();
  });

  it("clears decrypted content when the patient factor changes or the view is left", async () => {
    const { window, requests } = await openDemo();
    submit(window, "#timeline-form");
    await window.happyDOM.waitUntilComplete();
    expect(window.document.querySelector("#message")?.textContent).toBe("Verified 1 timeline entry.");
    expect(window.document.querySelector("#timeline-results")?.textContent).toContain("Synthetic timeline content");
    expect(requests[0]?.body).toEqual({ biometricToken: factors[0]!.token, clinician });
    const select = requiredElement(window, "#timeline-factor", HTMLSelectElement);
    select.value = factors[1]!.id;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(window.document.querySelector("#timeline-results")?.textContent).not.toContain("Synthetic timeline content");
    expect(window.document.querySelector("#timeline-state")?.textContent).toContain("Locked");
    submit(window, "#timeline-form");
    await window.happyDOM.waitUntilComplete();
    click(window, "nav [data-section-link='about']");
    expect(window.document.querySelector("#timeline-results")?.textContent).not.toContain("Synthetic timeline content");
    expect(window.document.querySelector("#timeline-state")?.textContent).toContain("Locked");
  });

  it("does not restore an in-flight timeline after the user hides it", async () => {
    let finish: (result: ApiResult) => void = () => { throw new Error("No pending request"); };
    const { window } = await openDemo({
      responder: () => new Promise((resolveResponse) => { finish = resolveResponse; }),
    });
    submit(window, "#timeline-form");
    expect(requiredElement(window, "#timeline-form button", HTMLButtonElement).disabled).toBe(true);
    expect(window.document.querySelector("#timeline-form")?.getAttribute("aria-busy")).toBe("true");
    click(window, "#hide-timeline");
    finish({ data: { entries: [entry] } });
    await window.happyDOM.waitUntilComplete();
    expect(window.document.querySelector("#timeline-results")?.textContent).toContain("Timeline hidden");
    expect(window.document.querySelector("#timeline-results")?.textContent).not.toContain("Synthetic timeline content");
    expect(window.document.querySelector("#timeline-state")?.textContent).toContain("Locked");
    expect(requiredElement(window, "#timeline-form button", HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the timeline when the browser tab is hidden", async () => {
    const { window } = await openDemo();
    submit(window, "#timeline-form");
    await window.happyDOM.waitUntilComplete();
    expect(window.document.querySelector("#timeline-results")?.textContent).toContain("Synthetic timeline content");
    Object.defineProperty(window.document, "hidden", { configurable: true, value: true });
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    expect(window.document.querySelector("#timeline-results")?.textContent).toContain("left this tab");
    expect(window.document.querySelector("#timeline-results")?.textContent).not.toContain("Synthetic timeline content");
  });

  it("preserves an existing clinician credential instead of accidentally replacing it", async () => {
    const { window, requests } = await openDemo({ section: "enroll" });
    expect(requiredElement(window, "#create-clinician", HTMLButtonElement).disabled).toBe(true);
    submit(window, "#clinician-form");
    await window.happyDOM.waitUntilComplete();
    expect(requests).toHaveLength(0);
    expect(JSON.parse(window.localStorage.getItem("gphr.poc.clinician")!)).toEqual(clinician);
    expect(window.document.querySelector("#message")?.textContent).toContain("retained");
  });

  it("does not overwrite a failed sample verification with a success message", async () => {
    const { window, requests } = await openDemo({
      seeded: false,
      section: "dashboard",
      responder: async (path) => path === "/api/clinicians"
        ? { data: clinician }
        : path === "/api/timeline"
          ? { status: 403, data: { error: "Synthetic verification failure" } }
          : { data: {} },
    });
    click(window, "#sample-flow");
    click(window, "#sample-flow");
    await window.happyDOM.waitUntilComplete();
    expect(window.document.querySelector("#message")?.textContent).toBe("Synthetic verification failure");
    expect(requests.filter((request) => request.path === "/api/enroll")).toHaveLength(1);
    expect(requests.filter((request) => request.path === "/api/records")).toHaveLength(2);
    expect(window.document.querySelector("#message")?.textContent).toBe("Synthetic verification failure");
    expect(window.document.querySelector("#message")?.getAttribute("role")).toBe("alert");
    expect(window.document.activeElement).toBe(window.document.querySelector("#message"));
    expect(window.document.querySelector("#timeline-results")?.textContent).toContain("could not be verified");
    expect(requiredElement(window, "#sample-flow", HTMLButtonElement).disabled).toBe(false);
  });

  it("guides enrollment to append and append to verification without sending browser labels", async () => {
    const { window, requests } = await openDemo({ section: "enroll" });
    submit(window, "#enroll-form");
    await window.happyDOM.waitUntilComplete();
    expect(window.document.querySelector("#message")?.textContent).toBe("Record enrolled. Next, add a synthetic entry.");
    expect(window.location.hash).toBe("#append");
    expect(requests[0]?.body).toEqual({ biometricToken: factors[0]!.token, clinician });
    requiredElement(window, "#clinical-code", HTMLInputElement).value = "Synthetic condition";
    requiredElement(window, "#clinical-status", HTMLInputElement).value = "active";
    submit(window, "#append-form");
    await window.happyDOM.waitUntilComplete();
    expect(window.location.hash).toBe("#timeline");
    expect(window.document.querySelector("#message")?.textContent).toContain("Unlock and verify");
    expect(JSON.stringify(requests)).not.toContain("Synthetic A");
    expect(window.localStorage.getItem("gphr.poc.patient-factors")).not.toContain("Synthetic condition");
  });

  it("rejects whitespace-only entries before making an API request", async () => {
    const { window, requests } = await openDemo({ section: "append" });
    requiredElement(window, "#clinical-code", HTMLInputElement).value = "  ";
    requiredElement(window, "#clinical-status", HTMLInputElement).value = "active";
    submit(window, "#append-form");
    await window.happyDOM.waitUntilComplete();
    expect(requests).toHaveLength(0);
    expect(window.document.querySelector("#message")?.textContent).toContain("neither can be blank");
  });
});

function requiredElement<T>(
  window: Window,
  selector: string,
  constructor: new (...args: never[]) => T,
): T {
  const element = window.document.querySelector(selector);
  expect(element).toBeInstanceOf(constructor);
  return element as T;
}
