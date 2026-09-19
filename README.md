# Global Patient Record Project

An offline-oriented, locally runnable proof of concept for patient-sovereign, encrypted health-record
provenance in humanitarian and disrupted-care settings.

This project applies an append-only tracking model to encrypted HL7 FHIR
resources. It uses opaque identifiers, immutable provenance entries, content
integrity checks, and explicit lineage while keeping the implementation focused
on the Global Patient Record Project.

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
limitations. [docs/PROVENANCE_DESIGN_NOTES.md](docs/PROVENANCE_DESIGN_NOTES.md)
records the provenance patterns used by the Global Patient Record Project.
The [documentation index](docs/README.md) explains the project's relationship
to GOSQAS, and [sequence flows](docs/SEQUENCE_FLOWS.md) document the runtime
interactions.

## Requirements

- Node.js 22 or later
- npm 10 or later

## Get started

```powershell
cd C:\p\pubinv\GDP2-project-85
npm install
npm test
npm start
```

Open `http://127.0.0.1:3000` in a browser. On **Home**, use **View timeline**
for an existing record or **Create a record** for manual enrollment. Opening
the timeline does not unlock it.

The separate **Create sample patient and records** action in the blue guided-demo
section creates a local clinician credential if needed, simulates a patient
factor, enrolls it, appends an `AllergyIntolerance` and a `Condition`, and
unlocks the verified timeline using both factors.

For a manual walkthrough, choose **Create record**, create a local clinician
credential, create a synthetic patient factor with a fictional browser-only
label, and enroll its record. Enrollment takes you to **Add entry**; saving an
entry takes you to **View timeline**, where **Unlock and verify** reads the
updated history. Entries show the date and description first; expand **Inspect
verification details** for provenance checks and identifiers.

The UI retains an existing clinician credential rather than replacing it
accidentally. Losing browser data can make previously enrolled records
inaccessible. Changing the selected patient factor, leaving the timeline,
hiding the browser tab, or choosing **Hide decrypted timeline** removes the
displayed history and requires another explicit unlock. This clears the view;
it is not a guarantee of secure memory erasure.

The UI is intentionally served only on the loopback interface by default.
Encrypted objects are persisted under `.data\web`; browser-only patient labels,
synthetic factor tokens, and the demonstration clinician credential are stored
in browser local storage. Both demo secrets are sent to the local server for
record operations; decryption and verification are not browser-only.

Refresh the page to see HTML, CSS, or JavaScript changes while `npm start` is
running. The [UX analysis](docs/GLOBAL_PATIENT_RECORD_UX_ANALYSIS.md) documents
the reference-inspired layout and the patient-specific privacy boundaries.

## Commands

For Azure, AWS S3, private IPFS, account-free integration tests, and secret-free
configuration, see the short [storage quickstart](docs/STORAGE_QUICKSTART.md).
The [draft storage design](docs/STORAGE_DESIGN.md) describes concurrency,
metadata exposure, and remaining distributed-coordination limits.

| Command | Purpose |
| --- | --- |
| `npm test` | Run account-free tests; external-provider integration is opt-in |
| `npm run test:coverage` | Run tests with coverage |
| `npm run typecheck` | Type-check without emitting JavaScript |
| `npm run build` | Compile TypeScript into `dist` |
| `npm start` | Run the local web UI at `http://127.0.0.1:3000` |
| `npm run dev` | Run the local UI with server restart on source changes |
| `npm run example` | Run the synthetic end-to-end example |
| `npm run example:access-denied` | Demonstrate that one factor alone cannot unlock a record |
| `npm run example:storage` | Run a synthetic flow against the configured backend |
| `npm run test:integration:azure` | Run real-SDK tests against temporary loopback Azurite |
| `npm run test:integration:ipfs` | Run the private IPFS Docker fixture (Docker engine required) |
| `npm run test:integration` | Explicit opt-in external-provider contract and encrypted-flow tests |

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
  storage/      Provider-neutral contract, adapters, and runtime configuration
  web/          Local HTTP API and static-file server
web/            Browser UI for enrollment, append, and timeline verification
examples/       Synthetic end-to-end flows
test/           Unit and integration tests
docs/           Architecture, threat model, and original project documents
```

## Tracking model adaptation

The Global Patient Record Project uses stable opaque keys, append operations,
blob-backed records, encrypted fragments, and parent relationships. Its trust
model is designed specifically for patient-controlled health information:

| Tracking concept | Global Patient Record Project adaptation |
| --- | --- |
| Opaque tracking key | Biometric-derived capsule locator |
| Provenance record | Encrypted, signed FHIR append event |
| Record attachments | Encrypted FHIR resource fragments |
| Parent/descendant tracking | Previous-event links forming a provenance DAG |
| Blob storage | Provider-neutral encrypted object store |
| API authorization | Dual patient-factor and clinician-key unlock |

## Current limitations

- The POC accepts synthetic biometric tokens; it does not process fingerprints.
- Browser local storage is used for demonstration credentials and simulated
  factors; it is not an acceptable production key store.
- A stored synthetic factor does not establish physical patient presence or
  informed consent. Provenance verification establishes integrity, not the
  clinical truth of an entry.
- The local file store is single-process and is not a distributed storage
  implementation.
- Device trust, credential revocation, multi-clinic governance, offline merge,
  multi-finger recovery, and consent withdrawal need further design.
- The biometric-derived locator is pseudonymous, not perfectly unlinkable.
- Append-only storage may conflict with erasure and biometric regulations.
- FHIR validation is intentionally narrow and is not a replacement for an
  official profile validator.

## Project overview and presentation

The [six-slide technical presentation](docs/presentation/technical-presentation.pptx)
covers the current architecture, provenance concepts, use cases, and
production-readiness work. Speaking notes are kept separately from the deck.
The [UX analysis](docs/GLOBAL_PATIENT_RECORD_UX_ANALYSIS.md) explains the selected
website improvements and the reference patterns behind them.

## License

GPL-3.0. See [LICENSE](LICENSE).
