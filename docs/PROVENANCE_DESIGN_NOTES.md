# Global Patient Record Project Provenance Design Notes

## Core provenance behavior

1. A stable opaque locator identifies an encrypted record history.
2. New provenance is appended as a new encrypted blob rather than replacing
   older history.
3. Attachments are stored separately from provenance metadata.
4. Parent and child identifiers make lineage traversable.
5. Read operations reconstruct a history from blob-backed records.

The Global Patient Record Project maps these patterns to an opaque
patient-factor locator, encrypted FHIR fragments, signed provenance events,
parent event links, and verified timeline assembly.

## Security requirements

- Anonymous or possession-only authorization is prohibited. A patient factor
  and clinician private key are required.
- Stored provenance uses AES-256-GCM so ciphertext modifications fail
  authentication.
- Every provenance event is cryptographically signed and includes a
  patient-side authorization MAC.
- Storage is provider-neutral through the `BlobStore` interface.
- Generic grouping and recall semantics are not used as clinical behavior.
