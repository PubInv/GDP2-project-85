import type { AesEnvelope } from "../crypto/primitives.js";
import type { FhirResource, SupportedFhirResourceType } from "./fhir.js";

export interface ClinicianCredential {
  credentialId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface ProvenanceEventPayload {
  schemaVersion: 1;
  eventId: string;
  parents: string[];
  fragmentId: string;
  resourceType: SupportedFhirResourceType;
  contentHash: string;
  recordedAt: string;
  clinicianId: string;
}

export interface ProvenanceEvent {
  payload: ProvenanceEventPayload;
  clinicianSignature: string;
  patientAuthorizationMac: string;
}

export interface PatientRecordState {
  schemaVersion: 1;
  heads: string[];
  trustedClinicians: Record<string, string>;
}

export interface UnlockCapsule {
  schemaVersion: 1;
  kind: "unlock-capsule";
  biometricSalt: string;
  wrappedPatientShare: AesEnvelope;
  clinicianShares: Record<string, string>;
  encryptedStatePointer: AesEnvelope;
}

export interface EncryptedObject {
  schemaVersion: 1;
  kind: "record-state" | "fhir-fragment" | "provenance-event";
  envelope: AesEnvelope;
}

export interface TimelineEntry {
  event: ProvenanceEventPayload;
  resource: FhirResource;
}
