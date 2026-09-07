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
