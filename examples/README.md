# Examples

All examples use synthetic tokens and synthetic FHIR data.

## End-to-end encrypted timeline

```powershell
npm run example
```

`basic-flow.ts` uses the local file store to enroll a record, append two FHIR
resources, and assemble a verified timeline. It writes only encrypted objects
under `.data/example`. Remove that directory before running the example again.

## Dual-unlock rejection

```powershell
npm run example:access-denied
```

`access-denied.ts` demonstrates that a valid patient factor paired with an
unrecognized clinician credential is rejected.

## Configurable storage example

`npm run example:storage` uses the selected `STORAGE_BACKEND` and only synthetic
data. It enrolls, appends two entries, reconnects, verifies lineage, and checks
wrong-clinician denial without printing secret factors or record contents.
See [storage setup](../docs/STORAGE_QUICKSTART.md) for Azure, AWS, private IPFS,
emulator testing, and runtime identities. No cloud accounts are needed for
the default file-backed example or the Azure emulator suite.
