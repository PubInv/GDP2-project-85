import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  HTMLFormElement,
  HTMLInputElement,
  HTMLSelectElement,
  Response,
  Window,
} from "happy-dom";
import { describe, expect, it } from "vitest";

describe("local web patient-factor controls", () => {
  it("populates and synchronizes every patient-factor dropdown", async () => {
    const window = new Window({
      url: "http://127.0.0.1:3000/#enroll",
    });
    const html = await readFile(resolve("web/index.html"), "utf8");
    const script = await readFile(resolve("web/app.js"), "utf8");
    window.document.write(html);
    window.fetch = async () =>
      new Response(
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

function requiredElement<T>(
  window: Window,
  selector: string,
  constructor: new (...args: never[]) => T,
): T {
  const element = window.document.querySelector(selector);
  expect(element).toBeInstanceOf(constructor);
  return element as T;
}
