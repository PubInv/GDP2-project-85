# Synthetic FHIR R4 minimum dataset (review draft)

**Status:** review draft, 2026-10-22. Synthetic data only. This is a proposal for discussion under [issue #7](https://github.com/PubInv/GDP2-project-85/issues/7), not an approved clinical dataset, profile, use case, or architecture.

The repository currently accepts five resource types and checks that an input is a JSON object, has a supported `resourceType`, has a non-empty `id` when supplied, is JSON-serializable, and is no larger than 256 KiB. The request body limit is 512 KiB. Those checks do not validate FHIR R4 element cardinalities, value sets, terminology membership, reference resolution, profiles, or clinical meaning. See `src/domain/fhir.ts` and the README.

These examples use the FHIR R4 (4.0.1) resource shapes and standard terminology identifiers as a review starting point. They are not yet run through a full FHIR validator. Validate the selected code systems and versions, and profile constraints, before treating any example as conformant. A terminology code and display are illustrative; a real implementation must use the selected terminology release and check code/display consistency.

## Files

The five individual JSON fixtures are in `examples/fhir-r4-minimum/`:

- `allergy-intolerance.json`
- `condition.json`
- `immunization.json`
- `medication-statement.json`
- `observation.json`

All use the same fictional references: `Patient/synthetic-patient-001` and `Practitioner/synthetic-clinician-a`. The relative references are syntactically illustrative but intentionally do not bundle Patient or Practitioner resources, since those resource types are outside this POC's supported set. A future conformance test must resolve them against synthetic test resources or a controlled test endpoint. No demographic search or actual patient identity is implied. `meta.source` identifies a fictional source system; it does not identify the author.

## Compact data dictionary

| Element | Proposed meaning / constraint | Example |
|---|---|---|
| `resourceType` | One of the five resource types accepted by this POC | `Observation` |
| `id` | Synthetic FHIR logical id; no real-world identifier | `synthetic-observation-001` |
| `meta.source` | URI for fictional source system; not a facility identity or author assertion | `urn:synthetic:system:clinic-a` |
| `patient` / `subject` | Consistent relative reference to a synthetic Patient | `Patient/synthetic-patient-001` |
| `recorder`, `performer.actor`, `informationSource` | Consistent relative reference to synthetic Practitioner where the resource supports the element | `Practitioner/synthetic-clinician-a` |
| `code.coding.system`, `code`, `display` | Coding from a named standard system; verify membership and display against a pinned release | SNOMED CT, LOINC, CVX, RxNorm |
| `status` and clinical status fields | FHIR R4 codes with resource-specific value sets | `Immunization.status = completed` |
| `effectiveDateTime`, `occurrenceDateTime`, `recordedDate` | Synthetic event or assertion time; do not conflate clinical time with system ingestion time | 2026-10-21 |
| provenance sidecar (proposal below) | Author, source facility, and recording time associated with each fixture; not currently stored as a FHIR Provenance resource by the POC | `Practitioner/synthetic-clinician-a` |

The candidate code systems are SNOMED CT (`http://snomed.info/sct`), LOINC (`http://loinc.org`), CVX (`http://hl7.org/fhir/sid/cvx`), RxNorm (`http://www.nlm.nih.gov/research/umls/rxnorm`), and the relevant HL7 FHIR code systems shown in the examples. Proposed constraints for review: require a system and code for each coded clinical concept in the minimum dataset; reject an unknown code or a mismatched display in a terminology-aware test; do not treat free-text alone as coded interoperability. Pin terminology versions and jurisdictional value sets before adopting these constraints.

## Provenance proposal

FHIR clinical resources do not share one universal author/facility field. These fixtures use `meta.source` only for a fictional source system. For a future FHIR representation, a separate R4 `Provenance` resource could point to the clinical resource in `target`, use `recorded` for the provenance assertion time, identify the clinician in `agent.who`, and identify the facility in `agent.onBehalfOf`; source material could be represented with `entity` when appropriate. The POC currently supports no `Provenance` resource and does not implement this mapping.

The prototype separately creates its own signed provenance event with `recordedAt`, `clinicianId`, resource type, content hash, and parent links. It does not currently store a FHIR facility/encounter source or a clinical author reference in that event. A future crosswalk must be reviewed before claiming equivalence between the prototype event and FHIR Provenance.

## Identifier, reference, and version rules to review

1. Keep FHIR `id` values synthetic, stable within a fixture, and free of personal data. Do not put names, birth dates, contact details, or real identifiers in `identifier`.
2. Use only the shared synthetic Patient and Practitioner logical references shown above in this first fixture set. Define whether the eventual validator resolves relative references against a test Bundle, a test server, or a local reference map.
3. Reject malformed reference strings and references to unapproved resource types in the future conformance suite; test unresolved references separately from malformed references.
4. Treat an update as a new version/history event; do not silently overwrite provenance or claim that a FHIR server version identifier is already managed by this POC. The exact versioning and correction workflow needs team approval.
5. Do not add a demographic lookup or expose a real patient identifier to make reference resolution work.

## Validation matrix

“Prototype result” below describes the existing generic validator, not an R4 validator. “R4 test expectation” is a proposed conformance-test result once a versioned R4 validator, terminology support, and reference resolver are selected.

| Case | Input / mutation | Existing prototype | Proposed FHIR R4 test expectation |
|---|---|---|---|
| P1 | Each of the five checked-in fixtures as an individual resource | Accepts if JSON shape and size limits pass | Pass base R4 checks after reference resolution and terminology validation |
| P2 | Supported resource with required element removed (e.g. `Immunization.patient`) | **Accepts**; required R4 cardinality is not checked | Reject |
| P3 | Invalid resource-specific code (e.g. `Immunization.status = "active-ish"`) | **Accepts**; value sets are not checked | Reject |
| P4 | Malformed reference (e.g. `Patient/`) or unresolved `Patient/unknown` | **Accepts**; references are not parsed or resolved | Reject malformed; report unresolved distinctly |
| P5 | Coded concept has unknown system/code or incompatible display | **Accepts**; terminology is not checked | Reject or flag according to approved binding strength and terminology policy |
| P6 | `resourceType: "Provenance"` | Rejects as unsupported | Not submitted to the current POC endpoint; validate as a separate R4 resource if adopted |
| N1 | Unsupported type such as `Patient` | Rejects | Reject at the POC supported-type boundary |
| N2 | Empty `id` | Rejects | Reject |
| N3 | Non-JSON value / `undefined` in a programmatic input | Rejects | Reject before serialization |
| N4 | Serialized resource above 256 KiB | Rejects | Reject at the POC size boundary |
| N5 | Malformed request JSON or body above 512 KiB | Rejected by request parsing/size boundary | Reject before resource validation |

The POC's generic validator currently has a small automated test in `test/fhir.spec.ts` for supported types and unsupported/non-JSON input. Rows P2–P5 are specifically useful regression cases because they demonstrate gaps that must be closed by a separate FHIR validation layer; they are not tests the current validator already passes or rejects.

## Approval and follow-up needed

- Confirm whether the initial clinical scenario and target users are approved. [Issue #5](https://github.com/PubInv/GDP2-project-85/issues/5) still requires clinical stakeholder confirmation and team sign-off. This draft does not select its two-clinic proposal as the finalized workflow.
- Confirm the minimum profile: base FHIR R4 4.0.1 only, or a project-specific implementation guide and required elements.
- Confirm clinical terminology systems, pinned versions, jurisdictions, and binding strengths, especially for medication, allergy, and vaccine data.
- Approve the patient/practitioner/facility reference strategy, identifier policy, correction/version rules, and whether a FHIR Provenance resource is in scope.
- Evaluate validator and OpenMRS-compatible endpoint options as issue #7 requests. No validator or endpoint is selected here.
- Review the existing four use cases in [issue #10](https://github.com/PubInv/GDP2-project-85/issues/10); they are not reproduced here.

## Source notes

- [FHIR R4 AllergyIntolerance](https://hl7.org/fhir/R4/allergyintolerance.html), [Condition](https://hl7.org/fhir/R4/condition.html), [Immunization](https://hl7.org/fhir/R4/immunization.html), [MedicationStatement](https://hl7.org/fhir/R4/medicationstatement.html), and [Observation](https://hl7.org/fhir/R4/observation.html).
- [Project README](https://github.com/PubInv/GDP2-project-85/blob/main/README.md), [issue #7](https://github.com/PubInv/GDP2-project-85/issues/7), [issue #5](https://github.com/PubInv/GDP2-project-85/issues/5), and [issue #10](https://github.com/PubInv/GDP2-project-85/issues/10).
