import {
  AccessDeniedError,
  InMemoryBlobStore,
  PatientRecordService,
  createClinicianCredential,
} from "../src/index.js";

const records = new PatientRecordService(new InMemoryBlobStore());
const authorizedClinician = createClinicianCredential();
const unauthorizedClinician = createClinicianCredential();
const biometricToken =
  "synthetic-sdk-token-1cf9b153db6b4748be68c2d1520cc67a";

await records.enroll({
  biometricToken,
  clinician: authorizedClinician,
});

try {
  await records.assemble({
    biometricToken,
    clinician: unauthorizedClinician,
  });
  throw new Error("Unexpectedly unlocked the record.");
} catch (error) {
  if (!(error instanceof AccessDeniedError)) {
    throw error;
  }
  console.log(
    "Access denied as expected: the patient factor alone cannot unlock the record.",
  );
}
