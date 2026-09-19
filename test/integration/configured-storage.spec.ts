import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AccessDeniedError,
  IntegrityError,
  PatientRecordService,
  RecordNotFoundError,
  createClinicianCredential,
  createConfiguredBlobStore,
  type BlobStore,
} from "../../src/index.js";
import { blobStoreContract } from "../helpers/blob-store-contract.js";

if (process.env.STORAGE_INTEGRATION !== "true") {
  throw new Error("Integration tests require STORAGE_INTEGRATION=true and a dedicated synthetic-data store.");
}
if (!["azure", "s3", "ipfs"].includes(process.env.STORAGE_BACKEND ?? "")) {
  throw new Error("Integration tests require an explicit azure, s3, or ipfs backend, never a fallback.");
}

// Do not print SDK errors: their request metadata can contain authorization data.
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error("Integration storage request failed; check connectivity, configuration, and identity permissions.");
  }
}

// Contract assertions need the exported error types, so suppress SDK transport
// details only; the adapters already translate expected contract failures.
function redacted(store: BlobStore): BlobStore {
  async function call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Error &&
          ["ObjectNotFoundError", "ObjectAlreadyExistsError", "ConcurrentUpdateError"].includes(error.name)) {
        throw error;
      }
      throw new Error("Integration provider operation failed (transport details withheld).");
    }
  }
  return {
    read: <T>(key: string) => call(() => store.read<T>(key)),
    create: (key, value) => call(() => store.create(key, value)),
    compareAndSwap: (key, version, value) => call(() => store.compareAndSwap(key, version, value)),
  };
}

const connect = async () => redacted(await safe(() => createConfiguredBlobStore()));
blobStoreContract("configured external provider", async () => ({
  first: await connect(), second: await connect(),
}));

describe("configured provider encrypted workflow", () => {
  it("enrolls, appends, reconnects and refuses wrong factors", async () => {
    const store = await connect();
    const records = new PatientRecordService(store);
    const clinician = createClinicianCredential();
    const biometricToken = randomBytes(32).toString("base64url");
    const access = { clinician, biometricToken };
    await records.enroll(access);
    const first = await records.append({
      ...access,
      resource: { resourceType: "Condition", id: "synthetic-integration", code: { text: "SYNTHETIC-ONLY-MARKER" } },
    });
    const second = await records.append({
      ...access,
      resource: { resourceType: "Observation", id: "synthetic-followup", status: "final", code: { text: "SYNTHETIC-ONLY-MARKER" } },
    });
    const reopened = new PatientRecordService(await connect());
    const timeline = await reopened.assemble(access);
    expect(timeline).toHaveLength(2);
    expect(timeline[1]?.event.parents).toEqual([first.eventId]);
    expect(timeline[1]?.event.eventId).toBe(second.eventId);
    for (const id of [first.fragmentId, first.eventId, second.fragmentId, second.eventId]) {
      const raw = JSON.stringify(await store.read(id));
      expect(raw).not.toContain("SYNTHETIC-ONLY-MARKER");
      expect(raw).not.toContain(biometricToken);
      expect(raw).not.toContain(clinician.privateKeyPem);
    }
    await expect(reopened.assemble({ ...access, clinician: createClinicianCredential() }))
      .rejects.toBeInstanceOf(AccessDeniedError);
    await expect(reopened.assemble({ ...access, biometricToken: randomBytes(32).toString("base64url") }))
      .rejects.toBeInstanceOf(RecordNotFoundError);

    const stored = await store.read(first.eventId);
    expect(stored).toBeDefined();
    await store.compareAndSwap(first.eventId, stored!.version, { kind: "tampered" });
    await expect(reopened.assemble(access)).rejects.toBeInstanceOf(IntegrityError);
  });
});
