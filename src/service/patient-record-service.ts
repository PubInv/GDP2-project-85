import { randomBytes } from "node:crypto";

import {
  assertValidClinicianCredential,
  canonicalJson,
  clinicianCredentialId,
  combineKeyShares,
  createAuthorizationMac,
  decryptForClinician,
  decryptJson,
  deriveBiometricKey,
  deriveCapsuleLocator,
  deriveContextKey,
  encryptForClinician,
  encryptJson,
  randomId,
  randomKey,
  sha256,
  signCanonical,
  splitKey,
  verifyAuthorizationMac,
  verifyCanonical,
} from "../crypto/primitives.js";
import {
  validateFhirResource,
  type FhirResource,
} from "../domain/fhir.js";
import type {
  ClinicianCredential,
  EncryptedObject,
  PatientRecordState,
  ProvenanceEvent,
  ProvenanceEventPayload,
  TimelineEntry,
  UnlockCapsule,
} from "../domain/provenance.js";
import {
  ConcurrentUpdateError,
  ObjectAlreadyExistsError,
  type BlobStore,
  type StoredObject,
} from "../storage/blob-store.js";
import {
  AccessDeniedError,
  IntegrityError,
  RecordAlreadyExistsError,
  RecordNotFoundError,
} from "./errors.js";

interface ServiceOptions {
  now?: () => Date;
}

interface UnlockResult {
  dataKey: Buffer;
  stateId: string;
  stateObject: StoredObject<EncryptedObject>;
  state: PatientRecordState;
}

export interface EnrollRequest {
  biometricToken: string;
  clinician: ClinicianCredential;
}

export interface AppendRequest extends EnrollRequest {
  resource: FhirResource;
}

export interface AppendResult {
  eventId: string;
  fragmentId: string;
}

export class PatientRecordService {
  readonly #now: () => Date;

  public constructor(
    private readonly store: BlobStore,
    options: ServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
  }

  public async enroll(request: EnrollRequest): Promise<void> {
    assertValidClinicianCredential(request.clinician);
    const locator = deriveCapsuleLocator(request.biometricToken);
    if ((await this.store.read(locator)) !== undefined) {
      throw new RecordAlreadyExistsError();
    }

    const dataKey = randomKey();
    const [patientShare, clinicianShare] = splitKey(dataKey);
    const stateId = randomId();
    const biometricSalt = randomBytes(16);
    const biometricKey = deriveBiometricKey(
      request.biometricToken,
      biometricSalt,
    );
    const state: PatientRecordState = {
      schemaVersion: 1,
      heads: [],
      trustedClinicians: {
        [request.clinician.credentialId]: request.clinician.publicKeyPem,
      },
    };

    const encryptedState: EncryptedObject = {
      schemaVersion: 1,
      kind: "record-state",
      envelope: encryptJson(
        state,
        deriveContextKey(dataKey, `state:${stateId}`),
        `record-state:${stateId}`,
      ),
    };

    const capsule: UnlockCapsule = {
      schemaVersion: 1,
      kind: "unlock-capsule",
      biometricSalt: biometricSalt.toString("base64url"),
      wrappedPatientShare: encryptJson(
        patientShare.toString("base64url"),
        biometricKey,
        `patient-share:${locator}`,
      ),
      clinicianShares: {
        [request.clinician.credentialId]: encryptForClinician(
          clinicianShare,
          request.clinician.publicKeyPem,
        ),
      },
      encryptedStatePointer: encryptJson(
        stateId,
        deriveContextKey(dataKey, `capsule:${locator}`),
        `state-pointer:${locator}`,
      ),
    };

    await this.store.create(stateId, encryptedState);
    try {
      await this.store.create(locator, capsule);
    } catch (error) {
      if (error instanceof ObjectAlreadyExistsError) {
        throw new RecordAlreadyExistsError();
      }
      throw error;
    }
  }

  public async append(request: AppendRequest): Promise<AppendResult> {
    validateFhirResource(request.resource);
    const unlocked = await this.unlock(request);
    const fragmentId = randomId();
    const eventId = randomId();
    const resourceJson = canonicalJson(request.resource);
    const fragment: EncryptedObject = {
      schemaVersion: 1,
      kind: "fhir-fragment",
      envelope: encryptJson(
        request.resource,
        deriveContextKey(unlocked.dataKey, `fragment:${fragmentId}`),
        `fhir-fragment:${fragmentId}`,
      ),
    };

    const payload: ProvenanceEventPayload = {
      schemaVersion: 1,
      eventId,
      parents: [...unlocked.state.heads],
      fragmentId,
      resourceType: request.resource.resourceType,
      contentHash: sha256(resourceJson),
      recordedAt: this.#now().toISOString(),
      clinicianId: request.clinician.credentialId,
    };
    const event: ProvenanceEvent = {
      payload,
      clinicianSignature: signCanonical(
        payload,
        request.clinician.privateKeyPem,
      ),
      patientAuthorizationMac: createAuthorizationMac(
        payload,
        unlocked.dataKey,
      ),
    };
    const encryptedEvent: EncryptedObject = {
      schemaVersion: 1,
      kind: "provenance-event",
      envelope: encryptJson(
        event,
        deriveContextKey(unlocked.dataKey, `event:${eventId}`),
        `provenance-event:${eventId}`,
      ),
    };

    await this.store.create(fragmentId, fragment);
    await this.store.create(eventId, encryptedEvent);

    const nextState: PatientRecordState = {
      ...unlocked.state,
      heads: [eventId],
    };
    const nextEncryptedState: EncryptedObject = {
      schemaVersion: 1,
      kind: "record-state",
      envelope: encryptJson(
        nextState,
        deriveContextKey(unlocked.dataKey, `state:${unlocked.stateId}`),
        `record-state:${unlocked.stateId}`,
      ),
    };

    try {
      await this.store.compareAndSwap(
        unlocked.stateId,
        unlocked.stateObject.version,
        nextEncryptedState,
      );
    } catch (error) {
      if (error instanceof ConcurrentUpdateError) {
        throw new ConcurrentUpdateError(unlocked.stateId);
      }
      throw error;
    }

    return { eventId, fragmentId };
  }

  public async assemble(request: EnrollRequest): Promise<TimelineEntry[]> {
    const unlocked = await this.unlock(request);
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const timeline: TimelineEntry[] = [];

    const visit = async (eventId: string): Promise<void> => {
      if (visited.has(eventId)) {
        return;
      }
      if (visiting.has(eventId)) {
        throw new IntegrityError("Provenance graph contains a cycle.");
      }
      visiting.add(eventId);

      const encryptedEvent = await this.readEncryptedObject(
        eventId,
        "provenance-event",
      );
      const event = this.decryptEvent(
        encryptedEvent,
        eventId,
        unlocked.dataKey,
      );
      if (event.payload.eventId !== eventId) {
        throw new IntegrityError("Provenance event ID does not match its object.");
      }

      const publicKey = unlocked.state.trustedClinicians[event.payload.clinicianId];
      if (publicKey === undefined) {
        throw new IntegrityError("Provenance event uses an unknown clinician.");
      }
      if (
        !verifyCanonical(
          event.payload,
          event.clinicianSignature,
          publicKey,
        )
      ) {
        throw new IntegrityError("Clinician signature verification failed.");
      }
      if (
        !verifyAuthorizationMac(
          event.payload,
          event.patientAuthorizationMac,
          unlocked.dataKey,
        )
      ) {
        throw new IntegrityError("Patient authorization verification failed.");
      }

      for (const parent of event.payload.parents) {
        await visit(parent);
      }

      const encryptedFragment = await this.readEncryptedObject(
        event.payload.fragmentId,
        "fhir-fragment",
      );
      const resource = this.decryptFragment(
        encryptedFragment,
        event.payload.fragmentId,
        unlocked.dataKey,
      );
      validateFhirResource(resource);
      if (resource.resourceType !== event.payload.resourceType) {
        throw new IntegrityError(
          "FHIR resource type does not match its provenance event.",
        );
      }
      if (sha256(canonicalJson(resource)) !== event.payload.contentHash) {
        throw new IntegrityError(
          "FHIR fragment content hash verification failed.",
        );
      }

      visiting.delete(eventId);
      visited.add(eventId);
      timeline.push({ event: event.payload, resource });
    };

    for (const head of unlocked.state.heads) {
      await visit(head);
    }
    return timeline;
  }

  private async unlock(request: EnrollRequest): Promise<UnlockResult> {
    assertValidClinicianCredential(request.clinician);
    const locator = deriveCapsuleLocator(request.biometricToken);
    const storedCapsule = await this.store.read<UnlockCapsule>(locator);
    if (storedCapsule === undefined) {
      throw new RecordNotFoundError();
    }
    const capsule = storedCapsule.value;
    if (
      capsule.schemaVersion !== 1 ||
      capsule.kind !== "unlock-capsule"
    ) {
      throw new IntegrityError("Stored unlock capsule has an invalid format.");
    }

    const encryptedClinicianShare =
      capsule.clinicianShares[request.clinician.credentialId];
    if (encryptedClinicianShare === undefined) {
      throw new AccessDeniedError();
    }

    try {
      const biometricKey = deriveBiometricKey(
        request.biometricToken,
        Buffer.from(capsule.biometricSalt, "base64url"),
      );
      const patientShare = Buffer.from(
        decryptJson<string>(
          capsule.wrappedPatientShare,
          biometricKey,
          `patient-share:${locator}`,
        ),
        "base64url",
      );
      const clinicianShare = decryptForClinician(
        encryptedClinicianShare,
        request.clinician.privateKeyPem,
      );
      const dataKey = combineKeyShares(patientShare, clinicianShare);
      const stateId = decryptJson<string>(
        capsule.encryptedStatePointer,
        deriveContextKey(dataKey, `capsule:${locator}`),
        `state-pointer:${locator}`,
      );
      const stateObject = await this.readEncryptedObject(
        stateId,
        "record-state",
      );
      const state = decryptJson<PatientRecordState>(
        stateObject.value.envelope,
        deriveContextKey(dataKey, `state:${stateId}`),
        `record-state:${stateId}`,
      );

      const expectedPublicKey =
        state.trustedClinicians[request.clinician.credentialId];
      if (
        expectedPublicKey === undefined ||
        clinicianCredentialId(expectedPublicKey) !==
          request.clinician.credentialId ||
        expectedPublicKey !== request.clinician.publicKeyPem
      ) {
        throw new AccessDeniedError();
      }

      return { dataKey, stateId, stateObject, state };
    } catch (error) {
      if (error instanceof IntegrityError || error instanceof AccessDeniedError) {
        throw error;
      }
      throw new AccessDeniedError();
    }
  }

  private async readEncryptedObject(
    id: string,
    expectedKind: EncryptedObject["kind"],
  ): Promise<StoredObject<EncryptedObject>> {
    const stored = await this.store.read<EncryptedObject>(id);
    if (stored === undefined) {
      throw new IntegrityError(`Required ${expectedKind} object is missing.`);
    }
    if (
      stored.value.schemaVersion !== 1 ||
      stored.value.kind !== expectedKind
    ) {
      throw new IntegrityError(`Stored ${expectedKind} object has an invalid format.`);
    }
    return stored;
  }

  private decryptEvent(
    encrypted: StoredObject<EncryptedObject>,
    eventId: string,
    dataKey: Buffer,
  ): ProvenanceEvent {
    try {
      return decryptJson<ProvenanceEvent>(
        encrypted.value.envelope,
        deriveContextKey(dataKey, `event:${eventId}`),
        `provenance-event:${eventId}`,
      );
    } catch {
      throw new IntegrityError("Provenance event decryption failed.");
    }
  }

  private decryptFragment(
    encrypted: StoredObject<EncryptedObject>,
    fragmentId: string,
    dataKey: Buffer,
  ): FhirResource {
    try {
      return decryptJson<FhirResource>(
        encrypted.value.envelope,
        deriveContextKey(dataKey, `fragment:${fragmentId}`),
        `fhir-fragment:${fragmentId}`,
      );
    } catch {
      throw new IntegrityError("FHIR fragment decryption failed.");
    }
  }
}
