import { Readable } from "node:stream";
import { types } from "node:util";
import type { StoredObject } from "./blob-store.js";

export const MAX_STORED_OBJECT_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;

export function assertBlobKey(key: string): void {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(key)) {
    throw new Error("Invalid storage object key.");
  }
}

export function assertExpectedVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Invalid storage object version.");
  }
}

export function nextVersion(version: number): number {
  assertExpectedVersion(version);
  if (version === Number.MAX_SAFE_INTEGER) {
    throw new Error("Storage object version limit reached.");
  }
  return version + 1;
}

function assertJsonValue(value: unknown): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  let stringBytes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new Error("Storage object exceeds limits.");
    }
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string") {
      stringBytes += Buffer.byteLength(item);
      if (stringBytes > MAX_STORED_OBJECT_BYTES) {
        throw new Error("Storage object exceeds limits.");
      }
      return;
    }
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) return;
    if (typeof item !== "object" || item === null || types.isProxy(item) || ancestors.has(item)) {
      throw new Error("Unsupported storage object value.");
    }
    const array = Array.isArray(item);
    if (array && Object.getPrototypeOf(item) !== Array.prototype) {
      throw new Error("Unsupported storage object value.");
    }
    if (!array && Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null) {
      throw new Error("Unsupported storage object value.");
    }
    ancestors.add(item);
    const keys = Reflect.ownKeys(item);
    if (keys.length > MAX_NODES) throw new Error("Storage object exceeds limits.");
    if (array && (item.length > MAX_NODES || keys.length !== item.length + 1)) {
      throw new Error("Unsupported storage object value.");
    }
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" ||
          (array && !/^(0|[1-9]\d*)$/.test(key))) {
        throw new Error("Unsupported storage object value.");
      }
      stringBytes += Buffer.byteLength(key);
      if (stringBytes > MAX_STORED_OBJECT_BYTES) {
        throw new Error("Storage object exceeds limits.");
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new Error("Unsupported storage object value.");
      }
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
}

function assertWrapper(value: unknown): asserts value is StoredObject {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !Object.hasOwn(value, "version") || !Object.hasOwn(value, "value") ||
      !("version" in value) || typeof value.version !== "number") {
    throw new Error("Invalid stored object.");
  }
  assertExpectedVersion(value.version);
}

export function encodeStoredObject(stored: StoredObject): string {
  try {
    assertJsonValue(stored);
    assertWrapper(stored);
    const text = JSON.stringify(stored);
    if (Buffer.byteLength(text) > MAX_STORED_OBJECT_BYTES) {
      throw new Error("Storage object exceeds limits.");
    }
    return text;
  } catch {
    // JSON exceptions can contain caller-controlled data.
    throw new Error("Invalid or oversized storage object.");
  }
}

export function decodeStoredObject<T>(text: string): StoredObject<T> {
  if (Buffer.byteLength(text) > MAX_STORED_OBJECT_BYTES) {
    throw new Error("Storage object exceeds limits.");
  }
  try {
    const value: unknown = JSON.parse(text);
    assertWrapper(value);
    assertJsonValue(value);
    return value as StoredObject<T>;
  } catch {
    throw new Error("Invalid stored object.");
  }
}

export function requireEtag(etag: string | undefined): string {
  if (!etag || etag.trim() === "" || etag.trim() === "*" || etag.length > 1024 ||
      /[\r\n]/.test(etag)) {
    throw new Error("Invalid storage object ETag.");
  }
  return etag;
}

export function disposeBody(body: unknown): void {
  if (body instanceof Readable) body.destroy();
}

export async function readBoundedBody(body: unknown, length?: number): Promise<string> {
  if (!(body instanceof Readable)) throw new Error("Invalid storage response body.");
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0 ||
      length > MAX_STORED_OBJECT_BYTES)) {
    body.destroy();
    throw new Error("Invalid storage response size.");
  }
  const timer = setTimeout(() => body.destroy(new Error("Storage response timed out.")), 30_000);
  timer.unref();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array) && typeof chunk !== "string") {
        throw new Error("Invalid storage response body.");
      }
      size += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (size > MAX_STORED_OBJECT_BYTES || chunks.length >= MAX_NODES) {
        throw new Error("Storage object exceeds limits.");
      }
      chunks.push(Buffer.from(chunk));
    }
    if (length !== undefined && size !== length) {
      throw new Error("Incomplete storage response.");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
  } finally {
    clearTimeout(timer);
    body.destroy();
  }
}
