# Threat Model

## Protected assets

- Essential health-record contents
- Linkage between fragments belonging to one patient
- Patient biometric material and derived SDK tokens
- Record data keys and key shares
- Clinician private keys
- Integrity and ordering of provenance events

## Adversaries

- A storage provider or attacker with a complete storage snapshot
- A hostile institution attempting demographic or bulk patient discovery
- A stolen clinician credential without patient presence
- A captured patient factor without a clinician credential
- An attacker modifying, deleting, replaying, or substituting stored objects
- An operator accidentally exposing secrets through logs or local files

## Security properties demonstrated

- Stored FHIR and provenance contents use AES-256-GCM authenticated encryption.
- Record keys are random and reconstructed only from two separately protected
  shares.
- Clinician authorization uses possession of an RSA private key and signed
  provenance events.
- Patient-side authorization uses possession of the reconstructed record key.
- Immutable object creation prevents silent overwrite of fragments and events.
- Hashes bind provenance events to exact decrypted FHIR content.
- Compare-and-swap detects concurrent state replacement.

## Known residual risks

- The POC trusts the caller-provided biometric token. It has no sensor,
  liveness, anti-spoofing, or secure-enclave integration.
- A biometric-derived locator permits access-pattern correlation.
- A weak or reproducible raw-biometric hash would permit offline guessing.
- Endpoint compromise exposes data while legitimately decrypted.
- JavaScript cannot guarantee immediate memory zeroization.
- Deletion or denial of storage availability is detectable but not preventable.
- The local file adapter does not provide cross-process transactional safety.
- Traffic analysis can reveal object sizes and timing.
- Append-only data conflicts with some correction and erasure obligations.

## Required production work

Do not advance to real-patient testing without independent cryptographic review,
a formal data-protection impact assessment, clinical safety analysis,
jurisdiction-specific biometric review, informed-consent design, incident
response, credential revocation, secure hardware integration, and an approved
record-loss recovery policy.
