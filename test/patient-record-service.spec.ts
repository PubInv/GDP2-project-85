import { describe, expect, it } from "vitest";

import type { EncryptedObject } from "../src/domain/provenance.js";
import {
  AccessDeniedError,
  InMemoryBlobStore,
  IntegrityError,
  InvalidFhirResourceError,
  PatientRecordService,
  RecordAlreadyExistsError,
  RecordNotFoundError,
  createClinicianCredential,
} from "../src/index.js";

const BIOMETRIC_TOKEN =
  "synthetic-sdk-token-a8fb72e84c434f3ba47e90d03e9aba0d";

describe("PatientRecordService", () => {
  it("enrolls, appends, and verifies an ordered FHIR provenance timeline", async () => {
    const store = new InMemoryBlobStore();
    const clinician = createClinicianCredential();
    const timestamps = [
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-02T00:00:00.000Z"),
    ];
    const records = new PatientRecordService(store, {
      now: () => timestamps.shift() ?? new Date("2026-01-03T00:00:00.000Z"),
    });

    await records.enroll({
      biometricToken: BIOMETRIC_TOKEN,
      clinician,
    });
    const first = await records.append({
      biometricToken: BIOMETRIC_TOKEN,
      clinician,
      resource: {
        resourceType: "AllergyIntolerance",
        id: "synthetic-allergy",
        code: { text: "Synthetic allergy" },
      },
    });
    const second = await records.append({
      biometricToken: BIOMETRIC_TOKEN,
      clinician,
      resource: {
        resourceType: "Condition",
        id: "synthetic-condition",
        code: { text: "Synthetic condition" },
      },
    });

    const timeline = await records.assemble({
      biometricToken: BIOMETRIC_TOKEN,
      clinician,
    });

    expect(timeline.map((entry) => entry.resource.resourceType)).toEqual([
      "AllergyIntolerance",
      "Condition",
    ]);
    expect(timeline[0]?.event.eventId).toBe(first.eventId);
    expect(timeline[1]?.event.parents).toEqual([first.eventId]);
    expect(timeline[1]?.event.eventId).toBe(second.eventId);
  });

  it("does not persist cleartext FHIR content", async () => {
    const store = new InMemoryBlobStore();
    const clinician = createClinicianCredential();
    const records = new PatientRecordService(store);

    await records.enroll({
      biometricToken: BIOMETRIC_TOKEN,
      clinician,
    });
    await records.append({
      biometricToken: BIOMETRIC_TOKEN,
      clinician,
      resource: {
        resourceType: "Condition",
        id: "synthetic-secret-condition",
        code: { text: "SYNTHETIC-CLEARTEXT-MARKER" },
      },
    });

    const persisted = JSON.stringify(store.snapshot());
    expect(persisted).not.toContain("SYNTHETIC-CLEARTEXT-MARKER");
    expect(persisted).not.toContain("synthetic-secret-condition");
  });

  it("requires the enrolled patient factor and clinician credential", async () => {
    const store = new InMemoryBlobStore();
    const clinician = createClinicianCredential();
    const otherClinician = createClinicianCredential();
    const records = new PatientRecordService(store);

    await records.enroll({
      biometricToken: BIOMETRIC_TOKEN,
      clinician,
    });

    await expect(
      records.assemble({
        biometricToken:
          "different-synthetic-token-014e97e0c17a401daaf1196e59fa9621",
        clinician,
      }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);

    await expect(
      records.assemble({
        biometricToken: BIOMETRIC_TOKEN,
        clinician: otherClinician,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("rejects duplicate enrollment and unsupported FHIR", async () => {
    const store = new InMemoryBlobStore();
    const clinician = createClinicianCredential();
    const records = new PatientRecordService(store);

    await records.enroll({
      biometricToken: BIOMETRIC_TOKEN,
      clinician,
    });
    await expect(
      records.enroll({
        biometricToken: BIOMETRIC_TOKEN,
        clinician,
      }),
    ).rejects.toBeInstanceOf(RecordAlreadyExistsError);

    await expect(
      records.append({
        biometricToken: BIOMETRIC_TOKEN,
        clinician,
        resource: {
          resourceType: "Patient",
          id: "not-supported",
        } as never,
      }),
    ).rejects.toBeInstanceOf(InvalidFhirResourceError);
  });

  it("detects modified encrypted provenance", async () => {
    const store = new InMemoryBlobStore();
    const clinician = createClinicianCredential();
    const records = new PatientRecordService(store);

    await records.enroll({
      biometricToken: BIOMETRIC_TOKEN,
      clinician,
    });
    const { eventId } = await records.append({
      biometricToken: BIOMETRIC_TOKEN,
      clinician,
      resource: {
        resourceType: "Observation",
        id: "synthetic-observation",
        status: "final",
        code: { text: "Synthetic observation" },
      },
    });

    const stored = await store.read<EncryptedObject>(eventId);
    expect(stored).toBeDefined();
    const tampered = structuredClone(stored!.value);
    const firstCharacter = tampered.envelope.ciphertext[0];
    tampered.envelope.ciphertext = `${firstCharacter === "A" ? "B" : "A"}${tampered.envelope.ciphertext.slice(1)}`;
    await store.compareAndSwap(eventId, stored!.version, tampered);

    await expect(
      records.assemble({
        biometricToken: BIOMETRIC_TOKEN,
        clinician,
      }),
    ).rejects.toBeInstanceOf(IntegrityError);
  });
});
