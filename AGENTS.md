# Contributor and Agent Guide

## Mission

Build a privacy-preserving, patient-sovereign FHIR provenance POC for
humanitarian settings. This repository is research software and must never
claim clinical, regulatory, biometric, or production readiness.

## Non-negotiable invariants

1. Never store raw biometrics, biometric templates, biometric SDK tokens,
   derived record keys, or decrypted FHIR resources.
2. Never add demographic or patient-name lookup.
3. Require both a patient factor and an authorized clinician private key before
   decrypting record state.
4. Store FHIR fragments and provenance entries as authenticated ciphertext
   under random object identifiers.
5. Verify every parent link, clinician signature, patient-authorization MAC,
   and content hash during assembly.
6. Keep Google Cloud Healthcare API and analytics integrations outside the PHI
   path; synthetic or irreversibly aggregated data only.
7. Treat logs, errors, crash dumps, temporary files, and test snapshots as
   potential disclosure channels.

## Development workflow

- Use Node.js 22+ and TypeScript strict mode.
- Import public APIs through `src/index.ts`.
- Add or update tests for every behavior change.
- Run `npm test`, `npm run typecheck`, and `npm run build` before submitting.
- Use synthetic FHIR fixtures only. Do not commit realistic names, identifiers,
  dates of birth, contact details, or biometric material.
- Keep storage provider-neutral. Cloud adapters implement `BlobStore`; service
  code must not depend directly on a cloud SDK.

## Architecture boundaries

- `src/crypto`: cryptographic primitives only; no storage or FHIR policy.
- `src/domain`: serializable domain types and validation.
- `src/storage`: opaque object persistence and compare-and-swap behavior.
- `src/service`: orchestration, authorization, provenance, and verification.

Do not weaken a boundary to make a test pass. Explicitly document any new
metadata visible to the storage provider.

## Reference implementation

`C:\p\pubinv\asset-provenance-tracking` is a conceptual reference for provenance
lineage, immutable records, and blob-backed storage. Do not copy its code,
GOSQAS branding, Azure-specific deployment, or asset-oriented schema into this
repository.
