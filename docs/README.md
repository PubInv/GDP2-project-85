# Global Patient Record Project: Relationship to GOSQAS

## Audience and purpose

This document is written for the lead architect and project owner of GOSQAS.
Its purpose is to explain:

1. how GOSQAS and Global Distributed Tracking (GDT) inspired the Global Patient
   Record Project;
2. which architectural and interaction patterns have been reused;
3. which GOSQAS source components informed the implementation;
4. where the patient-record trust model must deliberately diverge; and
5. where future technical collaboration or shared components may be practical.

The short version is that the Global Patient Record Project is not intended to
compete with or rebrand GOSQAS. It is an application of the same core
provenance insight to a substantially different privacy domain:

> A history becomes more trustworthy when each new statement is appended,
> attributable, linked to prior history, and independently verifiable.

GOSQAS applies that principle to physical objects, manufacturing, custody,
quality assurance, and logistics. The Global Patient Record Project applies it
to encrypted FHIR clinical fragments that should remain unreadable unless an
authorized clinician and the patient are both present.

## Executive architectural summary

GOSQAS demonstrated that a usable provenance system can be built around:

- opaque record keys rather than conventional user accounts;
- encrypted blob-backed histories;
- append-only record creation;
- separate attachments;
- parent and child relationships;
- QR- and key-oriented field workflows;
- simple create, append, share, and view interactions;
- operation in low-resource and intermittently connected environments.

The Global Patient Record Project preserves the provenance model but changes
the security contract. A GOSQAS key is designed to make a record easy to share
with the people handling an object. A patient health record must not become
readable merely because a locator was shared or exposed.

The patient-record implementation therefore adds:

- two-party unlock using a patient factor and clinician credential;
- random record data keys split into separately protected shares;
- authenticated encryption for every persisted object;
- clinician digital signatures;
- a patient-side authorization MAC;
- encrypted FHIR resources rather than generic record descriptions;
- verification of the full provenance graph before rendering;
- no public record URL, demographic directory, or patient search index.

## What was studied in GOSQAS

The following GOSQAS implementation areas were used to understand the product
model and provenance lifecycle.

| GOSQAS area | Relevant source | Architectural lesson |
| --- | --- | --- |
| Record lookup | `packages/frontend/components/TrackAsset.vue` | A single opaque locator can make field retrieval simple without requiring an account workflow. |
| Record creation | `packages/frontend/components/Forms/CreateDevice.vue` | Creation should be short, understandable, and produce the identifier needed for all later activity. |
| Record append | `packages/frontend/components/Provenance/CreateRecord.vue` | New evidence should be appended instead of rewriting historical statements. |
| History presentation | `packages/frontend/pages/history/[deviceKey].vue` and `components/Provenance/Feed.vue` | Users need a chronological, human-readable view while preserving the original event history. |
| Provenance API | `packages/backend/src/functions/httpTrigger.ts`, especially `getProvenance()` and `postProvenance()` | Blob-per-entry persistence is a practical basis for an append-oriented record. |
| Opaque identity | `calculateDeviceID()` and `packages/backend/src/utils/keyFuncs.ts` | Storage identifiers can be derived or generated without exposing a descriptive database key. |
| Encryption boundary | `encrypt()`, `decrypt()`, and `decryptBlob()` in `httpTrigger.ts` | The storage provider should hold ciphertext rather than meaningful record contents. |
| Relationships | `packages/frontend/utils/descendantList.ts` | Explicit identifiers allow histories and relationships to be traversed without relational joins. |
| Integration testing | `packages/backend/test/IntegrationTests` | Create, update, read, attachment, and propagation behaviors should be tested as complete workflows. |
| Offline direction | PWA configuration and offline-edit flows under `packages/frontend` | Field systems must tolerate intermittent connectivity and defer synchronization safely. |

## What is reused today

It is important to distinguish **architectural reuse** from **source-code
reuse**.

### Architectural and product-pattern reuse

The current Global Patient Record Project directly reuses these ideas:

| Reused GOSQAS pattern | Patient-record implementation |
| --- | --- |
| Opaque record key | A biometric-token-derived capsule locator identifies encrypted unlock material without a demographic lookup. |
| Encrypted blob history | Record state, FHIR fragments, and provenance events are stored as encrypted objects under opaque random IDs. |
| Append-only provenance | Every clinical addition creates a new immutable fragment and event. Prior events are not edited. |
| Separate record and attachment concepts | Clinical content is stored separately from the provenance event that describes and authenticates it. |
| Parent/child linkage | Each event references its parent event IDs, producing a directed acyclic provenance graph. |
| Reconstruction on read | The service walks backward from the current heads and assembles the timeline. |
| Simple create/append/view UX | The local UI uses Enroll, Add Entry, and Timeline flows corresponding to create, update, and history. |
| Local and offline orientation | A local file-backed object store and localhost UI allow the POC to operate without cloud services. |
| Workflow-level testing | Tests cover enrollment, append, retrieval, tampering, access denial, storage, and browser interaction. |

### Source-code reuse

The current implementation does **not** import, vendor, or copy GOSQAS source
modules. There is no runtime dependency on the GOSQAS repositories.

This was intentional for the first proof of concept because:

- the patient security model required different cryptographic primitives and
  authorization rules;
- the project needed a provider-neutral storage contract instead of an
  Azure-specific service dependency;
- FHIR resources required a domain model separate from generic provenance
  descriptions and attachments;
- direct AGPL source reuse would require an explicit licensing and distribution
  decision for this repository;
- GOSQAS names and visual marks require separate trademark consideration.

Accordingly, "reuse" currently means reuse of proven architecture, interaction
patterns, and engineering lessons—not copied source code. Any future direct
code sharing should be made explicit in dependency metadata, attribution,
license notices, and architectural decision records.

## Detailed concept mapping

### Record key to patient capsule locator

GOSQAS uses a compact record key as the capability needed to locate and decrypt
a history. The patient project retains the usability advantage of an opaque
locator, but does not treat the locator as sufficient authorization.

The patient locator is derived from a protected, high-entropy token produced by
the biometric boundary. It locates an unlock capsule containing:

- a salted, encrypted patient key share;
- one or more clinician-encrypted key shares;
- an encrypted pointer to the current record state.

The locator therefore answers only **where is the encrypted unlock material?**
It does not answer **who is the patient?** or independently permit record
decryption.

Implementation:

- `src/crypto/primitives.ts`: `deriveCapsuleLocator()`,
  `deriveBiometricKey()`, `splitKey()`, and `combineKeyShares()`
- `src/service/patient-record-service.ts`: `enroll()` and `unlock()`

### Provenance blob to signed clinical event

GOSQAS appends encrypted provenance records. The patient project stores two
immutable objects for each append:

1. an encrypted FHIR fragment; and
2. an encrypted provenance event referring to the fragment.

The provenance payload contains:

- event ID;
- parent event IDs;
- fragment ID;
- FHIR resource type;
- canonical content hash;
- timestamp;
- clinician credential ID.

The clinician signs this payload. The record key also produces an authorization
MAC, demonstrating that the patient side of the dual unlock participated in
the operation.

Implementation:

- `src/domain/provenance.ts`
- `src/service/patient-record-service.ts`: `append()`
- `src/crypto/primitives.ts`: `signCanonical()` and
  `createAuthorizationMac()`

### Attachments to FHIR fragments

GOSQAS separates provenance descriptions from attachments. This distinction is
valuable for clinical records because the provenance statement and clinical
payload have different responsibilities.

In the patient project:

- the provenance event explains who appended what type of resource, when, and
  after which prior events;
- the FHIR fragment holds the clinical content;
- the event binds to the exact fragment plaintext using a SHA-256 hash;
- both are encrypted independently under context-derived keys.

This separation supports future attachment types such as diagnostic images,
documents, or signed consent artifacts without placing all content in a single
monolithic record.

### Descendant graph to provenance DAG

GOSQAS uses explicit record keys to model groups, children, and descendants.
The patient project uses the same graph-oriented insight at the event level.

Each provenance event contains `parents`. The current encrypted state contains
one or more `heads`. Reading a record means traversing from the heads through
all parents, detecting:

- missing events;
- cycles;
- duplicate references;
- invalid signatures;
- invalid patient authorization;
- fragment substitution;
- unsupported or malformed FHIR content.

Multiple heads are reserved for future offline branching and deterministic
merge behavior.

### Blob storage to provider-neutral object storage

GOSQAS demonstrates that blob storage is a good fit for append-oriented
provenance. The patient project retains this model through a small interface:

```ts
interface BlobStore {
  read<T>(key: string): Promise<StoredObject<T> | undefined>;
  create(key: string, value: unknown): Promise<void>;
  compareAndSwap(
    key: string,
    expectedVersion: number,
    value: unknown,
  ): Promise<number>;
}
```

The POC supplies:

- `InMemoryBlobStore` for isolated tests;
- `FileBlobStore` for the local demonstration.

An Azure Blob Storage adapter could be added without changing the cryptographic
or clinical service. A future shared storage package is one of the clearest
areas for collaboration, provided its contract preserves immutable creation and
optimistic concurrency.

## Intentional differences from GOSQAS

These differences are not criticisms of GOSQAS. They follow from the different
consequences of disclosing an object history versus disclosing a patient's
medical history.

| Concern | GOSQAS objective | Global Patient Record Project objective |
| --- | --- | --- |
| Sharing | Make trustworthy history easy to share with handlers, buyers, testers, and recipients. | Prevent clinical history from being read unless the patient and an authorized clinician participate. |
| Identity | Avoid user-account friction; possession of the record key is central. | Separate record location, patient authorization, and clinician authorization. |
| Discoverability | QR codes and shareable record links are valuable product features. | Public links and demographic search are prohibited. |
| Cryptographic integrity | Encrypted append history protects record contents. | Authenticated encryption, signatures, MACs, and hash binding are all required. |
| Data format | Flexible provenance descriptions, tags, and attachments. | Constrained FHIR resources suitable for clinical interoperability. |
| History correction | Append another record describing the new state or action. | Append-only correction remains possible, but clinical amendment, consent, and erasure semantics require formal policy. |
| Group relationships | Containers, children, recall, and propagation model physical supply relationships. | Parent event links model chronology and concurrent offline branches, not patient grouping. |
| Access monitoring | Public or shared access is expected. | Even telemetry and access-pattern metadata must be minimized. |

## How the patient project can help GOSQAS

The patient project explores several capabilities that may be reusable in the
broader GOSQAS ecosystem:

### 1. Authenticated encryption envelope

`src/crypto/primitives.ts` provides an AES-256-GCM envelope with associated
data. This gives confidentiality and modification detection together. A
versioned, shared encryption-envelope package could support future GOSQAS
records while retaining backward compatibility with existing histories.

### 2. Signed provenance events

The clinician-signature pattern can generalize to manufacturers, inspectors,
testing laboratories, maintenance providers, and distributors. GOSQAS could
optionally support signed actors without making account-based authentication
mandatory for every existing workflow.

### 3. Provider-neutral storage contract

The `BlobStore` interface separates provenance logic from Azure. A shared
contract could allow:

- Azure Blob Storage;
- local file or edge storage;
- S3-compatible object stores;
- replicated humanitarian deployments;
- test-only in-memory storage.

### 4. Explicit graph verification

The patient timeline assembler validates the entire reachable event graph
before presenting it. Similar verification could strengthen GOSQAS group and
descendant histories, particularly where offline branches or signed records are
introduced.

### 5. Dual-authorization patterns

Some GOSQAS operations may benefit from requiring two independent parties—for
example, manufacturer plus inspector, sender plus receiver, or maintenance
technician plus facility representative. The split-key approach is one
candidate, although its usability and recovery implications require careful
evaluation.

### 6. FHIR interoperability as a domain adapter

The project demonstrates how a generic provenance substrate can support a
strict domain format without embedding that domain into the storage layer.
This pattern could also support quality-system schemas, calibration records, or
regulated-device evidence packages.

## Potential shared architecture

A long-term collaboration could separate common provenance infrastructure from
domain-specific policy:

```text
┌───────────────────────────────────────────────────────────┐
│ Domain applications                                       │
│ GOSQAS asset workflows | Patient FHIR | Other provenance  │
└───────────────────────────┬───────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────┐
│ Shared provenance kernel                                  │
│ immutable objects | event graph | signatures | envelopes │
└───────────────────────────┬───────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────┐
│ Storage adapters                                          │
│ Azure | local edge | S3-compatible | replicated storage   │
└───────────────────────────────────────────────────────────┘
```

The common kernel should not prescribe:

- whether a record is public, shared by capability, or dual-authorized;
- the domain payload schema;
- whether identities are anonymous, pseudonymous, institutional, or
  patient-controlled;
- the user-interface branding.

Those should remain policies selected by each application.

## Current implementation status

The Global Patient Record Project currently includes:

- local enrollment using a simulated high-entropy patient factor;
- generated RSA clinician credentials;
- dual-share reconstruction of a random record key;
- encrypted record state, FHIR fragments, and provenance events;
- append and verified timeline assembly;
- in-memory and local-file object stores;
- a localhost browser demonstration;
- negative tests for wrong credentials, tampering, unsupported FHIR,
  cleartext leakage, stale writes, and cross-origin requests.

It does not yet include:

- real fingerprint hardware or a patient biometric SDK;
- multi-finger recovery;
- credential enrollment, rotation, or revocation;
- production distributed storage;
- cross-clinic governance;
- offline branch synchronization;
- formal FHIR profile validation;
- regulatory, clinical-safety, or ethics approval.

## Recommended joint review questions

For an architectural review with the GOSQAS team, the most useful questions are:

1. Should immutable-object creation and record-history reconstruction become a
   shared provenance library?
2. Can a versioned authenticated-encryption envelope be introduced without
   breaking existing GOSQAS keys?
3. Should signatures be optional metadata in GOSQAS and mandatory policy in
   the patient application?
4. Can the GOSQAS offline queue model be generalized to support multiple
   concurrent event heads and deterministic merges?
5. Which storage metadata is acceptable to expose in each domain?
6. How should provenance correction, revocation, and legal erasure be modeled
   without rewriting prior evidence?
7. Would an explicit domain-adapter interface allow FHIR and asset schemas to
   share a common event kernel?

## Related documents

- [Architecture](ARCHITECTURE.md)
- [Sequence flows](SEQUENCE_FLOWS.md)
- [Threat model](THREAT_MODEL.md)
- [Biometric simulation](BIOMETRIC_SIMULATION.md)
- [Global Patient Record UX analysis](GLOBAL_PATIENT_RECORD_UX_ANALYSIS.md)
- [Provenance design notes](PROVENANCE_DESIGN_NOTES.md)
- Original concept documents in this directory

## Terminology note

GOSQAS and Global Distributed Tracking are referenced here solely to explain
architectural influence and potential technical collaboration. Their names,
marks, and visual identity remain those of their respective owners. The Global
Patient Record Project uses its own identity and does not represent itself as a
GOSQAS product.
