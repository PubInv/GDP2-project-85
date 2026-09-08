# Global Patient Record Project UX Analysis

The Global Patient Record Project uses a simple create, append, and history
workflow designed for low-resource and offline-capable environments.

## Main navigation

- Dashboard
- Enroll
- Add Entry
- Timeline
- How It Works

The local application keeps all patient actions within these sections and does
not expose public history links or demographic search.

## Record workflow

1. **Create a clinician credential:** generate the authorized institutional
   factor used for signing and key-share decryption.
2. **Simulate patient presence:** create a browser-local synthetic factor.
3. **Enroll:** initialize encrypted state under an opaque locator.
4. **Append:** validate and encrypt an essential FHIR resource.
5. **History:** unlock and verify the timestamped append-only timeline.

## Patterns retained in the health UI

| Tracking interaction | Global Patient Record Project interaction |
| --- | --- |
| Create opaque record key | Simulate patient factor and enroll |
| Create record initializer | Create encrypted patient state |
| Append description/attachment | Append encrypted FHIR resource |
| View by key or QR | Unlock using patient factor and clinician key |
| Timestamped history feed | Verified clinical provenance timeline |
| Group parent/child links | Provenance event parent links |
| Offline PWA-oriented workflow | Localhost UI and local encrypted store |

## Health-record requirements

Possession of a record key alone is not sufficient for health information. The
Global Patient Record Project UI:

- has no public history URL;
- does not accept patient names or demographic lookup;
- requires both factors for enrollment, append, and viewing;
- does not display or export an unlock token;
- stores all FHIR resources and event details as authenticated ciphertext;
- distinguishes a browser-only demonstration label from the token sent to the
  local API;
- verifies provenance before rendering the history.

## Local UI sections

- **Dashboard:** product purpose, workflow, local status, and sample flow.
- **Enroll:** local clinician credential plus synthetic biometric factor.
- **Add entry:** essential FHIR record creation.
- **Timeline:** dual-unlock and verified provenance feed.
- **How it works:** architecture comparison and Google SDK boundaries.
