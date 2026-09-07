# Global Private Health Records POC

An offline-first proof of concept for patient-sovereign, encrypted health-record
provenance in humanitarian and disrupted-care settings.

This project adapts the append-only tracking model used by
`gosqasorg/asset-provenance-tracking` to encrypted HL7 FHIR resources. It does
not copy that project's Azure deployment or asset-specific data model. Instead,
it reuses the core ideas of opaque identifiers, immutable provenance entries,
content integrity checks, and explicit lineage.

> [!WARNING]
> This is research software, not a medical device or production electronic
> health-record system. It uses synthetic biometric tokens and must not be used
> with real patients, real fingerprints, or protected health information.

## What the POC proves

- A patient record can be located using an opaque value derived from a
  high-entropy biometric SDK token, without names or demographic search.
- Neither the patient factor nor the clinician credential can unlock a record
  alone.
- FHIR resources can be encrypted into randomly addressed immutable blobs.
- Every append creates a clinician-signed, patient-authorized provenance event.
- An assembled timeline can verify signatures, authorization MACs, hashes, and
  parent links before returning any resource.
- The storage layer contains no cleartext FHIR resources.

## Architecture

```text
Synthetic biometric token          Clinician RSA credential
             |                                |
             +---------- dual unlock ---------+
                              |
                    patient record data key
                              |
                +-------------+--------------+
                |                            |
       encrypted record state       immutable encrypted blobs
       - current event heads         - FHIR fragments
       - trusted clinicians          - provenance events
                |                            |
                +------ verified DAG --------+
                              |
                   ephemeral FHIR timeline
```

The encrypted record state is stored under a random identifier. A small
biometric-derived capsule contains encrypted key shares and an encrypted pointer
to that state. The object store can observe opaque object access, but it cannot
search by patient demographics or decrypt record contents.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the detailed design and its
limitations. [docs/REFERENCE_IMPLEMENTATION.md](docs/REFERENCE_IMPLEMENTATION.md)
records the analysis of the GDT repository used to guide this implementation.

## Requirements

- Node.js 22 or later
- npm 10 or later

## Get started

```powershell
cd C:\p\pubinv\GDP2-project-85
npm install
npm test
npm run example
npm run example:access-denied
```

The example enrolls a synthetic patient factor, appends an
`AllergyIntolerance` and a `Condition`, then unlocks and verifies the assembled
timeline.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run all unit and integration tests |
| `npm run test:coverage` | Run tests with coverage |
| `npm run typecheck` | Type-check without emitting JavaScript |
| `npm run build` | Compile TypeScript into `dist` |
| `npm run example` | Run the synthetic end-to-end example |
| `npm run example:access-denied` | Demonstrate that one factor alone cannot unlock a record |

## Minimal usage

```ts
import {
  InMemoryBlobStore,
  PatientRecordService,
  createClinicianCredential,
} from "./src/index.js";

const store = new InMemoryBlobStore();
const records = new PatientRecordService(store);
const clinician = createClinicianCredential();
const biometricToken = "synthetic-high-entropy-sdk-token";

await records.enroll({ biometricToken, clinician });
await records.append({
  biometricToken,
  clinician,
  resource: {
    resourceType: "AllergyIntolerance",
    id: "allergy-1",
    patient: { reference: "Patient/ephemeral" },
    code: { text: "Penicillin" },
  },
});

const timeline = await records.assemble({ biometricToken, clinician });
```

Applications should import from the package entry point rather than internal
modules. Real biometric integrations must provide a stable, protected,
high-entropy token after device-side matching and liveness checks. Raw
fingerprint images, fingerprint templates, and low-entropy hashes are not valid
inputs.

## Project layout

```text
src/
  crypto/       Encryption, key splitting, signatures, and canonical hashing
  domain/       FHIR and provenance types
  service/      Enrollment, append, unlock, and verified assembly
  storage/      Storage contract plus memory and local-file implementations
examples/       Synthetic end-to-end flows
test/           Unit and integration tests
docs/           Architecture, threat model, and original project documents
```

## Relationship to GDT

The reference GDT project tracks asset provenance using stable opaque keys,
append/update operations, blob-backed records, attachments, and parent/child
relationships. This POC keeps the provenance intent but changes the trust model:

| GDT concept | Health-record adaptation |
| --- | --- |
| Device key | Opaque biometric-derived capsule locator |
| Provenance record | Encrypted, signed FHIR append event |
| Record attachments | Encrypted FHIR resource fragments |
| Parent/descendant tracking | Previous-event links forming a provenance DAG |
| Blob storage | Provider-neutral encrypted object store |
| API authorization | Dual patient-factor and clinician-key unlock |

No code or branding from the reference repository is included.

## Current limitations

- The POC accepts synthetic biometric tokens; it does not process fingerprints.
- The local file store is single-process and is not a distributed storage
  implementation.
- Device trust, credential revocation, multi-clinic governance, offline merge,
  multi-finger recovery, and consent withdrawal need further design.
- The biometric-derived locator is pseudonymous, not perfectly unlinkable.
- Append-only storage may conflict with erasure and biometric regulations.
- FHIR validation is intentionally narrow and is not a replacement for an
  official profile validator.

## License

GPL-3.0. See [LICENSE](LICENSE).
