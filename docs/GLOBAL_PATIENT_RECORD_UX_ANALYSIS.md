# Global Patient Record Project UX Analysis

The Global Patient Record Project uses a simple create, append, and history
workflow designed for low-resource and offline-capable environments.

This review records the September 16, 2026 website changes and their rationale.
Local operation after setup is implemented; cross-device offline
synchronization is not.

## Reference-led website update — September 16, 2026

The reference homepage at [gosqas.org](https://gosqas.org/) was inspected in a
live, isolated desktop browser, not just through its README or PDF. The initial
text-only fetch returned no content because the website is client-rendered.
The rendered homepage showed a pale-blue navigation bar and footer, a spacious
white hero with a left-aligned heading, purple view and light-blue create
buttons, alternating white/blue content bands, a three-column principles
section, and learning links near the footer.

Public frontend source was also inspected at revision `5b0c88b`, under
`packages/frontend`: `layouts/default.vue`, `pages/index.vue`, `pages/gdt.vue`,
`components/Provenance/CreateRecord.vue`, and `components/Provenance/Feed.vue`.
The source confirms separate informational and record navigation, focused
create/append forms, and timestamp-led history cards. The checked-out homepage
source and deployed news layout differ; the live homepage was used for the
visual comparison, not assumed identical to the checkout. Record-form and
history observations are source-based; no reference record was created or
opened.

This is an original implementation of those general interaction patterns, not a
copy of reference code, prose, logos, illustrations, fonts, or other assets.
The application itself keeps the Global Patient Record Project identity.

| Observed reference pattern | Adaptation in this application |
| --- | --- |
| Informational links separated from a prominent view action | Home and How it works grouped separately from Create record, Add entry, and View timeline |
| Spacious white hero with purple view and pale-blue create actions | Two direct routes for returning and new users; neither route unlocks data automatically |
| Broad alternating blue/white sections | A guided-sample band with real local status, a manual three-step journey, and a three-column privacy explanation |
| Short introductions followed by one focused task | Enrollment has clinician, patient, and enroll panels; append has a single form and adjacent instructions |
| Timestamp-led history cards | Date, record type, description, and integrity badge shown first; technical verification details use a native keyboard-operable disclosure |
| Learning links and a light footer | Project-specific limitations and How it works links, without unrelated fundraising, marketing, news, or external embeds |

The sample remains a separate, explicitly labeled shortcut: it creates two
synthetic entries and unlocks the result using both factors. The main View
timeline action only navigates to the private unlock form. There is no pasted
record-key lookup, QR lookup, public history link, or possession-only access
model. No attachment uploads, share/export links, demographic search, or
reference-specific product/asset vocabulary were added. No claims about
deployment scale, medical efficacy, compliance, or production readiness were
borrowed.

## Main navigation

- Home (existing `#dashboard` route)
- How it works
- Create record (existing `#enroll` route)
- Add Entry
- View timeline (existing `#timeline` route)

The local application keeps all patient actions within these sections and does
not expose public history links or demographic search.

## Record workflow

1. **Create a clinician credential:** generate the authorized institutional
   factor used for signing and key-share decryption.
2. **Simulate a patient factor:** create a browser-local synthetic token; this
   does not prove physical presence or informed consent.
3. **Enroll:** initialize encrypted state under an opaque locator.
4. **Append:** validate and encrypt an essential FHIR resource.
5. **History:** unlock and verify the timestamped append-only timeline.

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

The demonstration saves synthetic factors and a clinician private key in browser
local storage, which is not a production key store. Both secrets are sent to the
loopback server for record operations. Decryption and verification occur in that
service; this is **not** browser-only decryption. The normal local-file adapter
persists encrypted content in `.data/web`. FHIR checks cover supported resource
types, JSON structure, and size, not full profile conformance.

## Local UI sections

- **Home:** purpose, separate view/create routes, guided sample with local
  status, manual workflow, and privacy principles.
- **Create record:** local clinician credential plus synthetic patient factor,
  enrollment, and onward links for already-enrolled records.
- **Add entry:** essential FHIR record creation with synthetic-data and
  append-only guidance beside the form.
- **View timeline:** dual-unlock, explicit locked/verified state, timestamped
  provenance feed, collapsed verification details, and an explicit hide action.
- **How it works:** provider-neutral storage, privacy boundaries, and explicit
  implementation limits.

## Feedback-driven interaction refinements

The interface now uses one project name and shows a synthetic-data notice in
every section. Manual enrollment leads to Add entry; a saved entry leads to
Timeline with an explicit unlock action. Busy controls prevent repeat requests,
and failures remain visible rather than disappearing on a timer.

Timeline content is removed on patient-factor changes, navigation away, tab
hiding, or an explicit hide action. Responses arriving after such a change
cannot repopulate the old view. This removes rendered content, not a promise of
secure memory erasure. A generated clinician credential is retained rather
than accidentally replaced.

Keyboard navigation includes a skip link, visible focus, active-page semantics,
and focus on the destination heading. Narrow-screen timeline details stack
vertically. Verification copy distinguishes cryptographic integrity from
clinical accuracy, physical presence, and informed consent.

The refresh retains plain HTML, CSS, and JavaScript with system fonts and no
external assets or application dependencies. Navigation wraps on narrow screens
rather than placing the private-record actions in a hidden menu. The two-factor
hero illustration is made from HTML/CSS and explicitly labeled as illustrative,
not a live authorization indicator. A verified timeline status resets whenever
the decrypted view is cleared, including late-response invalidation.

## Validation of this update

- Existing Vitest suite: 31 tests passed across six files, including 18 targeted
  website/UI tests. Type checking and the production TypeScript build passed.
- Isolated Edge browser: all five sections checked at viewport widths of 1440,
  1024, 768, 375, and 320 pixels, with no horizontal overflow and destination
  heading focus preserved. Desktop and narrow-screen screenshots were reviewed.
- An isolated in-memory loopback service was used for a real-browser sample
  flow, a third appended entry, explicit re-unlock, keyboard activation of the
  verification disclosure, explicit hiding, and navigation-away clearing.
- The user's running application and persisted demo store were not used for
  mutations. No reference-site records were accessed or modified. These checks
  are a development smoke test, not a formal accessibility or security audit.
