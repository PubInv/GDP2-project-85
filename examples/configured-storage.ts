import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  AccessDeniedError,
  PatientRecordService,
  StorageConfigurationError,
  createClinicianCredential,
  createConfiguredBlobStore,
} from "../src/index.js";

async function main(): Promise<void> {
  const store = await createConfiguredBlobStore();
  const records = new PatientRecordService(store);
  const clinician = createClinicianCredential();
  const biometricToken = randomBytes(32).toString("base64url");
  const request = { clinician, biometricToken };
  await records.enroll(request);
  const first = await records.append({
    ...request,
    resource: {
      resourceType: "Condition",
      id: "synthetic-storage-example",
      code: { text: "SYNTHETIC STORAGE EXAMPLE ONLY" },
    },
  });
  await records.append({
    ...request,
    resource: {
      resourceType: "Observation",
      id: "synthetic-storage-followup",
      status: "final",
      code: { text: "SYNTHETIC FOLLOWUP ONLY" },
    },
  });

  // Reconnect through another adapter; factors remain in this process only.
  const reconnected = new PatientRecordService(
    process.env.STORAGE_BACKEND === "memory" ? store : await createConfiguredBlobStore(),
  );
  const timeline = await reconnected.assemble(request);
  assert.equal(timeline.length, 2);
  assert.deepEqual(timeline[1]?.event.parents, [first.eventId]);
  await assert.rejects(
    reconnected.assemble({ biometricToken, clinician: createClinicianCredential() }),
    AccessDeniedError,
  );
  console.log("Synthetic storage example completed: enrollment, append, reconnect, timeline, and access denial.");
  console.log("No factors or resource contents were logged. Encrypted test objects remain in the selected store.");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof StorageConfigurationError
    ? error.message
    : "Storage example failed. Check the backend configuration, identity permissions, and service availability.");
  process.exitCode = 1;
}
