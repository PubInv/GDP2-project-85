import {
  FileBlobStore,
  PatientRecordService,
  RecordAlreadyExistsError,
  createClinicianCredential,
} from "../src/index.js";

const store = new FileBlobStore(".data/example");
const records = new PatientRecordService(store);
const clinician = createClinicianCredential();
const biometricToken =
  "synthetic-sdk-token-7f7dddf9b8b4440f9bbfe2a6f1694996";

try {
  await records.enroll({ biometricToken, clinician });
} catch (error) {
  if (error instanceof RecordAlreadyExistsError) {
    throw new Error(
      "Example data already exists. Delete .data/example and run again.",
    );
  }
  throw error;
}

await records.append({
  biometricToken,
  clinician,
  resource: {
    resourceType: "AllergyIntolerance",
    id: "synthetic-allergy-1",
    patient: { reference: "Patient/ephemeral" },
    clinicalStatus: { text: "active" },
    code: { text: "Synthetic penicillin allergy" },
  },
});

await records.append({
  biometricToken,
  clinician,
  resource: {
    resourceType: "Condition",
    id: "synthetic-condition-1",
    subject: { reference: "Patient/ephemeral" },
    clinicalStatus: { text: "active" },
    code: { text: "Synthetic asthma example" },
  },
});

const timeline = await records.assemble({ biometricToken, clinician });

console.log(
  JSON.stringify(
    timeline.map(({ event, resource }) => ({
      eventId: event.eventId,
      parents: event.parents,
      recordedAt: event.recordedAt,
      resourceType: resource.resourceType,
      resourceId: resource.id,
    })),
    undefined,
    2,
  ),
);
