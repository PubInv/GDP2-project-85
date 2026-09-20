# Global Patient Record Project

A locally runnable, provider-neutral proof of concept for patient-sovereign,
encrypted health-record provenance in humanitarian and disrupted-care settings.
The project combines a synthetic patient factor and a clinician credential to
unlock an encrypted history of FHIR resources and verify its provenance.

> [!WARNING]
> **Research software. Synthetic data only.** This is not a medical device,
> production electronic health-record system, or clinically validated biometric
> system. Do not use real patients, fingerprints, protected health information,
> or real credentials. No clinical, regulatory, or production-readiness claim is
> made.

## What is implemented

| Area | Current implementation |
| --- | --- |
| Record access | Dual unlock using a synthetic patient factor and an authorized clinician private key; no patient-name or demographic search |
| Provenance | Authenticated encryption, clinician signatures, patient-authorization MACs, content hashes, and parent-link verification |
| Browser demo | Create a sample record, enroll manually, append entries, and unlock a verified timeline |
| Local API | Five HTTP operations, a checked-in OpenAPI specification, and self-hosted Swagger UI with **Try it out** |
| Storage | Separate memory, file, Azure Blob, S3, DynamoDB, and private IPFS adapters behind `BlobStore` |
| AWS hybrid | Optional EC2/Kubo/EBS foundation, DynamoDB metadata, synchronous encrypted S3 backups, and explicit content restoration |
| Examples and tests | Synthetic workflows, shared storage contracts, provider tests, Azurite integration, and a private-IPFS Docker fixture |
| Deployment documentation | AWS/local diagrams, runtime identity and secret configuration, an AWS runbook, and recovery boundaries |

Supported resource types are **AllergyIntolerance, Condition, Immunization,
MedicationStatement, and Observation**. Validation checks the POC's supported
JSON shape and size limits; it is not full FHIR profile validation.

## Quick start: no cloud account required

Install **Node.js 22 or later** and npm. From a terminal:

```powershell
git clone https://github.com/PubInv/GDP2-project-85.git
cd GDP2-project-85
npm ci
npm start
```

For an existing checkout, run `npm ci` and `npm start` from its root.
With no backend override, the server uses local files under `.data/web`.
Docker, AWS, Azure, IPFS, and cloud credentials are not needed for this path.

| Local address | Purpose |
| --- | --- |
| `http://127.0.0.1:3000/` | Browser demonstration |
| `http://127.0.0.1:3000/docs` | Interactive Swagger UI |
| `http://127.0.0.1:3000/openapi.json` | OpenAPI 3.0 specification |
| `http://127.0.0.1:3000/api/status` | Local POC status |

The default bind address is loopback. Keep it local; the demo is not an
internet-facing deployment. Set `PORT` if necessary, then use that port in the
addresses above. Swagger targets the same origin and port as its page.

### Browser walkthrough

Choose **Create sample patient and records** for a guided demonstration. It
creates a demo clinician if needed, generates a synthetic factor, enrolls a
record, adds sample entries, and unlocks the verified timeline.

For a manual flow, choose **Create record**, create the clinician credential,
create/select a synthetic patient factor, and enroll. Use **Add entry** to append
resources, then **View timeline** and **Unlock and verify** to inspect them.
Opening a timeline alone does not unlock it. **Inspect verification details**
exposes the provenance metadata for an entry.

The main UI keeps fictional labels, synthetic factors, and the demo clinician
credential in **browser local storage**. Labels remain browser-local. Both
unlock factors are sent to the local server for record operations; decryption
is not browser-only. Losing the browser data can make existing demo records
inaccessible.

Changing the selected factor, leaving the timeline, hiding the browser tab,
or choosing **Hide decrypted timeline** clears the displayed timeline and
requires another unlock. This is not a guarantee of secure memory erasure.

### Synthetic patient factors

The browser generates a random 256-bit token; it does **not** capture, match,
or verify a fingerprint. For a new API-only demonstration, generate a factor
locally:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Generate it once per synthetic record and reuse it for enrollment, appends, and
timeline requests with the same clinician credential. A different random factor
does not unlock the old record. The API minimum is 16 characters; use the
randomly generated value rather than a short label or a hardcoded shared token.

Existing UI-created factors are stored under `gphr.poc.patient-factors` in the
local site's browser storage. This is a demo convenience, not a production
biometric or secret-storage design. Keep tokens and credentials out of commits,
screenshots, logs, and shared request exports. See
[biometric simulation](docs/BIOMETRIC_SIMULATION.md) for the boundary.

## Interactive API and Swagger

Open `/docs` after starting the server. **Try it out makes real requests** to
the local API, including writes to its selected store. The specification is
checked in as [`web/openapi.json`](web/openapi.json).

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| GET | `/api/status` | Read local POC status | `200` |
| POST | `/api/clinicians` | Generate a fresh demo clinician key pair; no body required | `201` |
| POST | `/api/enroll` | Enroll a record with both factors | `201` |
| POST | `/api/records` | Append an encrypted resource and provenance event | `201` |
| POST | `/api/timeline` | Unlock and assemble the verified timeline | `200` |

Start with `/api/clinicians`, then copy its **complete JSON response** into the
`clinician` object in the enrollment, append, and timeline examples. It contains
`credentialId`, `publicKeyPem`, and `privateKeyPem`. Preserve the JSON newline
escapes in the PEM strings and use the same `biometricToken` throughout.
`COPY_FROM_CLINICIAN_RESPONSE` placeholders are instructions, not valid keys.
There is no bearer-token authentication replacing this two-factor body.

The Swagger workbench does not persist authorization or save demo factors to
browser storage. Its assets are self-hosted, its external validator is disabled,
and off-origin requests/configuration overrides are blocked. Request bodies,
demo private keys, and decrypted responses are still visible in the browser.
Never use real data or share HAR exports.

The request-body limit is **512 KiB**; a serialized FHIR resource is limited to
**256 KiB**. Common outcomes include `400` for malformed JSON or unsupported
resources, `403` for rejected access, `404` for an unknown record, `409` for
duplicate enrollment/integrity/concurrent-update conflicts, and `413` for an
oversized request. Some existing malformed-credential and short-factor failures
remain generic `500` responses. See the
[complete local API walkthrough](docs/LOCAL_API.md).

## Architecture and verification

```text
Synthetic patient factor          Clinician private key
             |                              |
             +--------- dual unlock --------+
                              |
                    ephemeral record data key
                              |
                  PatientRecordService
                encryption and verification
                              |
                          BlobStore
                    /                  \
       encrypted mutable state     immutable encrypted
       and unlock capsule          FHIR/provenance objects
```

An opaque factor-derived locator identifies an unlock capsule. The capsule
contains encrypted key-share material and an encrypted pointer to the record
state. Appends create randomly addressed encrypted fragments and provenance
events, then update the current heads using compare-and-swap (CAS).

Timeline assembly checks parent links, clinician signatures, patient-
authorization MACs, and content hashes before returning resources. Verification
establishes the history's integrity under this trust model, not the clinical
truth of an entry or physical patient presence. Storage providers can still
observe opaque keys, sizes, revisions, timing, and access patterns.

See [architecture](docs/ARCHITECTURE.md),
[threat model](docs/THREAT_MODEL.md), and
[runtime sequence flows](docs/SEQUENCE_FLOWS.md).
The [storage topology diagrams](docs/STORAGE_TOPOLOGY_DIAGRAMS.md) cover the
proposed AWS topology, write/restore ordering, default local application, and
optional private-IPFS fixture.

## Pluggable storage

The service depends on `BlobStore`, not a cloud SDK. Provider-specific
implementation and configuration live in `src/storage/adapters/{provider}/`;
the generic factory/registry lives in `src/storage/config/`.

| `STORAGE_BACKEND` | Implementation | Role and boundary |
| --- | --- | --- |
| `file` | `FileBlobStore` | Default local persistence in `.data/web`; single-process only |
| `memory` | `InMemoryBlobStore` | Ephemeral tests/demos; data disappears with the process |
| `azure` | `AzureBlobStore` | Conditional blob creates and ETag-backed updates; runtime Azure identity |
| `s3` | `S3BlobStore` | Conditional object writes; runtime AWS identity; optional SSE-KMS |
| `dynamodb` | `DynamoDbBlobStore` | Strong reads and conditional writes; single-region metadata table with string partition key `key` and no sort key |
| `ipfs` | `DistributedBlobStore` | Immutable private Kubo/Cluster content plus a separate atomic key-to-CID index; optional synchronous backup |

DynamoDB payloads are limited to **350 KiB** and are intended primarily for
small metadata pointers, not large content backups. IPFS raw content blocks
must be smaller than 1 MiB.

**Selecting another backend does not migrate existing records or automatically
mirror them between clouds.** Use dedicated namespaces for direct storage and
IPFS index data. Custom typed provider factories can be registered without
changing the record service; dependency cycles and unknown providers fail
closed. See the [provider extension guide](src/storage/README.md).

### Configuration and runtime secrets

Copy [`.env.example`](.env.example) to an ignored `.env.local`, select a backend,
and fill in its **nonsecret** settings. The application does **not** load env
files automatically. Load one explicitly when starting the server:

```powershell
node --env-file=.env.local --import tsx src/web/server.ts
```

Azure uses `DefaultAzureCredential`; AWS uses its SDK credential chain.
Prefer reviewed workload/managed identities or local short-lived operator
sessions. IPFS API authorization can come from restricted mounted files,
Azure Key Vault, or AWS Secrets Manager. Use only one source per header.
No static cloud keys, SAS tokens, connection strings, private keys, or actual
authorization values belong in GitHub or tracked configuration.

Remote endpoints require authenticated, reviewed network access and TLS;
explicit emulator mode permits only loopback HTTP exceptions. Provision
resources, IAM/RBAC, private networking and secret access separately.
Normal provider construction does not create cloud resources.
The [storage quickstart](docs/STORAGE_QUICKSTART.md) lists the exact settings.

## AWS hybrid and Azure deployment status

The optional AWS composition is:

```text
Application-encrypted content
    -> private Kubo/IPFS Cluster on EC2 -> encrypted EBS
    -> immutable backup in private S3 with SSE-KMS
    -> DynamoDB key-to-CID pointer published last with atomic CAS
```

Configure `STORAGE_BACKEND=ipfs`, `IPFS_METADATA_BACKEND=dynamodb`, and
`IPFS_BACKUP_BACKEND=s3`. An upload must meet the observed replica policy and
complete its backup before publishing the metadata pointer. A failed backup
does not become a successful write. KMS protects **infrastructure encryption**;
it does not replace patient/clinician factors or receive the reconstructed
application record key.

[`infra/aws/storage-foundation.json`](infra/aws/storage-foundation.json)
provides a reviewable CloudFormation foundation for private/versioned S3,
encrypted/PITR DynamoDB, scoped IAM, and optional private EC2/encrypted EBS.
**`CreateNode=false` is the default; the template can add at most one node.**
It is not a turnkey IPFS installer. An approved prebuilt AMI, private HTTPS
proxies, runtime secrets, networking and additional peers are operator
prerequisites. The remote application requires at least two observed replicas;
one EC2/EBS node remains one failure domain.

Start with the [AWS runbook](docs/AWS_HYBRID_STORAGE.md) and
[nonsecret AWS configuration example](examples/config/aws-hybrid.env.example).
No AWS deployment or live account IAM/KMS validation is implied by the code,
offline infrastructure checks, or emulator results.

**Azure deployment topology: To be decided.** The Azure Blob adapter and
Azurite integration are implemented; that does not select an Azure hosting,
networking, replication or disaster-recovery architecture.

### Explicit recovery

IPFS reads do not silently fall back to S3. With a configured backup, an
operator can restore an opaque object's content:

```powershell
node --env-file=.env.local --import tsx examples/restore-content.ts OPAQUE_OBJECT_KEY
```

Restoration validates the backup CID, republishes/pins the encrypted bytes, and
confirms replication without changing the metadata pointer. Restore a lost
metadata index separately first. Content backups cannot recreate lost patient
factors, restore an absent index, or prove freshness against snapshot rollback.
Failed publication may leave unreachable encrypted blocks/backups; there is no
automatic deletion or garbage-collection policy.

## Commands and development

| Command | Purpose |
| --- | --- |
| `npm start` | Start the local UI, API, Swagger UI and spec |
| `npm run dev` | Restart the server on source changes |
| `npm test` | Run account-free default tests; external integrations are excluded |
| `npm run test:coverage` | Run the default suite with coverage |
| `npm run typecheck` | Type-check without emitting JavaScript |
| `npm run build` | Compile library/server TypeScript into `dist` |
| `npm run example` | Run a synthetic file-backed workflow in `.data/example`; requires a fresh example store |
| `npm run example:access-denied` | Demonstrate denied access without the matching factors |
| `npm run example:storage` | Exercise the selected backend with a synthetic workflow |
| `npm run test:integration:azure` | Start temporary loopback Azurite and exercise the real Azure SDK |
| `npm run test:integration:ipfs` | Run the isolated private-IPFS fixture on a native Linux Docker host |
| `npm run test:integration` | Run the explicit opt-in external-provider suite |
| `npm run storage:restore -- OBJECT_KEY` | Restore verified encrypted IPFS content using settings already in the process environment |

For code changes, run `npm test`, `npm run typecheck`, and `npm run build`.
See [AGENTS.md](AGENTS.md) for contributor boundaries. Build output is not a
deployment bundle or a cloud provisioning step; `npm start` runs the source
entry point with `tsx`.

### Integration tests and CI

Default tests cover cryptography, FHIR validation, record workflows, provider
contracts/concurrency, backup recovery, runtime configuration, infrastructure
invariants, the UI, and Swagger execution. They need no cloud account.

**Azurite:** `npm run test:integration:azure` starts a temporary loopback
emulator with generated throwaway credentials and telemetry disabled. Docker
and an Azure account are not required.

**Private IPFS:** the optional fixture creates three Kubo and three Cluster
containers on an internal Docker bridge, with loopback-only API relays and
temporary file metadata/backups. It exercises content restoration and reads
the same replicated bytes after stopping the ingress Kubo/Cluster node.
It requires native Linux Docker on the same host; Docker Desktop and remote
Docker daemons are unsupported. All replicas still share one host.

**External providers:** opt in with `STORAGE_INTEGRATION=true`, an explicit
backend and a dedicated synthetic-data store. Tests/examples can leave
encrypted synthetic objects behind. The configured example discards its demo
factors on exit, so those records cannot subsequently be unlocked. Follow the
[quickstart](docs/STORAGE_QUICKSTART.md) for environment-file loading and
operator-managed test-data cleanup.

The basic `npm run example` uses a fixed synthetic factor and refuses duplicate
enrollment on a later run. Use a fresh disposable example store/checkout rather
than treating it as a reusable patient record.

[Storage CI](.github/workflows/storage-ci.yml) runs account-free tests, build,
type-checking, Azurite and the Linux private-IPFS fixture. The separate
[manual cloud smoke workflow](.github/workflows/storage-cloud-smoke.yml) runs
only from `main`, using a reviewed `storage-integration` environment and OIDC.
Configure required reviewers, branch restrictions, a dedicated federated role,
and private runner connectivity before enabling it. Its
`synthetic-integration/` prefix and GitHub role are separate from the AWS
foundation's `records/` prefix and EC2-only role. No long-lived cloud credential
is stored in the workflow.

## Minimal TypeScript usage

From a TypeScript module in the repository root:

```ts
import { randomBytes } from "node:crypto";
import {
  InMemoryBlobStore,
  PatientRecordService,
  createClinicianCredential,
} from "./src/index.js";

const records = new PatientRecordService(new InMemoryBlobStore());
const clinician = createClinicianCredential();
const biometricToken = randomBytes(32).toString("hex");
const access = { biometricToken, clinician };

await records.enroll(access);
await records.append({
  ...access,
  resource: {
    resourceType: "Condition",
    id: "synthetic-readme-condition",
    code: { text: "SYNTHETIC EXAMPLE ONLY" },
  },
});
const timeline = await records.assemble(access);
// Use only within this synthetic demonstration; do not log decrypted resources.
```

Import public APIs from `src/index.ts`, not provider internals. To use
configuration-based storage, replace the in-memory store with the result of
`await createConfiguredBlobStore(process.env)`, imported from that same entry
point. The record service and cryptographic protocol remain unchanged.

## Project layout

```text
src/
  crypto/                 Encryption, key splitting, signatures and hashing
  domain/                 FHIR/provenance types and validation
  service/                Enrollment, append, unlock and verified assembly
  storage/
    core/                 BlobStore contract and serialization validation
    config/               Provider registry, settings and runtime secrets
    adapters/             memory, file, azure, s3, dynamodb, ipfs
  web/                    Local HTTP API and static/documentation serving
web/
  api-docs/               Local Swagger page, initializer and styles
  openapi.json            Canonical API specification
  index.html              Dependency-free main demo UI
examples/                 Synthetic workflows and nonsecret configuration
scripts/                  Account-free integration harnesses
test/
  storage/                Provider and configuration tests
  infrastructure/         Offline AWS template invariant checks
  integration/            Opt-in configured-provider tests
  fixtures/ipfs/          Private Docker fixture and operating boundaries
infra/aws/                Review-only foundation and approved-AMI samples
docs/                     Architecture, diagrams, setup and runbooks
.github/workflows/        Account-free CI and protected cloud smoke workflow
```

## Limitations and next-stage design

- Synthetic factors do not establish fingerprint identity, liveness, physical
  patient presence or consent. Real biometric capture/matching is not
  implemented; raw images, templates and fingerprint hashes must not become
  record-protocol inputs.
- Browser-local demo credentials and server-side unlock are not a production
  key-management design. Key recovery, device trust, credential revocation and
  multi-finger recovery remain separate work.
- The file store is single-process. Private IPFS replicates content but does
  not supply the application's atomic metadata CAS or automatic ingress
  failover. Cloud account, index, secret service and key-service dependencies
  remain.
- An observed replica count is not a promise of long-term retention. Independent
  operators, repair, funding, monitoring and disaster-recovery exercises are
  still required.
- Encryption/provenance checks do not prove clinical correctness or independently
  prevent rollback of an entire valid storage snapshot. CIDs and access-pattern
  metadata can still be correlated.
- Offline branch synchronization/merge, cross-clinic governance, consent
  withdrawal, retention and erasure policies are not complete.
- FHIR validation is intentionally narrow. Clinical, privacy, security and
  regulatory reviews remain necessary before any use beyond synthetic research.

## Documentation map

| Document | Start here for |
| --- | --- |
| [Local API guide](docs/LOCAL_API.md) | Swagger Try it out and the complete synthetic request flow |
| [Storage quickstart](docs/STORAGE_QUICKSTART.md) | Backend configuration, identities and end-to-end commands |
| [Storage topology diagrams](docs/STORAGE_TOPOLOGY_DIAGRAMS.md) | AWS, local, Docker, write and restore diagrams; Azure TBD |
| [Provider extension guide](src/storage/README.md) | Segregated adapters and custom provider registration |
| [Storage design](docs/STORAGE_DESIGN.md) | CAS semantics, failure models and metadata disclosure |
| [Private distributed storage](docs/DISTRIBUTED_STORAGE.md) | Kubo/Cluster protocol, replication and backup behavior |
| [AWS hybrid runbook](docs/AWS_HYBRID_STORAGE.md) | Reviewed infrastructure, manual setup and recovery |
| [Architecture](docs/ARCHITECTURE.md) | Record encryption, unlock and provenance model |
| [Threat model](docs/THREAT_MODEL.md) | Security assumptions and remaining threats |
| [Sequence flows](docs/SEQUENCE_FLOWS.md) | Service/UI runtime interactions |
| [Biometric simulation](docs/BIOMETRIC_SIMULATION.md) | What the synthetic factor does and does not model |
| [Provenance design notes](docs/PROVENANCE_DESIGN_NOTES.md) | Background for the tracking model |
| [Architectural background](docs/README.md) | Design influences and potential shared concepts |
| [Technical presentation](docs/presentation/technical-presentation.pptx) | Presentation-level project background |

The code, specification and implementation guides are the reference for current
behavior; presentation/background material is not a deployment guarantee.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
