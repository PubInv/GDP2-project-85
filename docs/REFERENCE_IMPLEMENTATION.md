# GDT Reference Implementation Analysis

This project was designed after reviewing
`gosqasorg/asset-provenance-tracking` at commit
`5b0c88b6a190bf0bf6f034554f21fb0f1418d597` (September 6, 2026).
The repository was cloned separately at
`C:\p\pubinv\asset-provenance-tracking`; it is not vendored into this project.

## Relevant GDT structure

- `packages/backend/src/functions/httpTrigger.ts` implements Azure Functions
  for creating, appending, and reading provenance.
- `packages/backend/src/utils/keyFuncs.ts` generates and validates compact
  device keys.
- `packages/frontend/utils/descendantList.ts` traverses parent/child asset
  relationships and propagates operations to descendants.
- `packages/backend/test/IntegrationTests/Live/v1/create.test.ts`,
  `read.test.ts`, and `update.test.ts` demonstrate the record lifecycle.
- `packages/frontend/test/data/provenance.ts` demonstrates the provenance data
  shape and history.

## GDT behavior used as inspiration

1. A stable opaque device key identifies an asset history.
2. New provenance is appended as a new encrypted blob rather than replacing
   older history.
3. Attachments are stored separately from provenance metadata.
4. Parent and child identifiers make lineage traversable.
5. Read operations reconstruct a history from blob-backed records.

The health POC maps those ideas to an opaque patient-factor locator, encrypted
FHIR fragments, signed provenance events, parent event links, and verified
timeline assembly.

## Behaviors deliberately not carried forward

- GDT's HTTP functions use anonymous route authorization and rely largely on
  possession of a device key. The health POC requires a patient factor and a
  clinician private key.
- GDT uses AES-CBC for stored provenance. The health POC uses AES-256-GCM so
  ciphertext modifications fail authentication.
- GDT does not cryptographically sign provenance events. The health POC signs
  each event and adds a patient-side authorization MAC.
- GDT is coupled to Azure Functions, Azure Blob Storage, Azure Table Storage,
  and Azure Communication Services. The health POC defines a provider-neutral
  `BlobStore` interface.
- GDT fields such as `children_key`, `isPublicKey`,
  `sent_to_all_children`, and recall propagation are asset-domain behavior and
  are not reused as clinical semantics.

## Licensing and attribution boundary

The analysis informed the architecture, but no source code, branding, or schema
was copied from the GDT repository. This project remains under its existing
GPL-3.0 license.
