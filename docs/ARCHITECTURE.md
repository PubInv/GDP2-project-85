# POC Architecture

## Scope

This proof of concept tests whether append-only provenance can be applied to
encrypted FHIR fragments without a demographic patient registry. It does not
implement fingerprint capture, clinical workflows, distributed consensus, or
regulatory compliance.

## Trust boundaries

1. **Biometric SDK boundary:** an external edge SDK performs capture, liveness,
   matching, and template protection. This POC receives only a stable,
   high-entropy synthetic token.
2. **Clinician credential boundary:** clinicians hold RSA private keys. Public
   keys are authorized inside encrypted record state.
3. **Edge application:** combines the two factors, decrypts only in memory,
   validates provenance, and clears references after the operation.
4. **Object storage:** stores opaque capsules, encrypted state, fragments, and
   events. It is not trusted with confidentiality or integrity.

## Dual unlock

Enrollment creates a random 256-bit record data key and splits it into two
XOR shares:

- the patient share is encrypted with a key derived from the biometric token;
- the clinician share is encrypted to the clinician RSA public key.

Unlocking requires both successful decryptions. Combining either share with an
incorrect counterpart produces an unusable key, detected when encrypted record
state fails authentication.

The biometric token also derives an opaque capsule locator. This makes lookup
possible without demographics, but repeated access to the same locator can be
correlated by the storage provider. A production design needs private
information retrieval, rotating locators, or a patient-held locator to reduce
that leakage.

## Storage objects

| Object | Address | Mutability | Visible contents |
| --- | --- | --- | --- |
| Unlock capsule | Biometric-derived opaque locator | Immutable in M0 | Salt, encrypted shares, encrypted state pointer |
| Record state | Random 256-bit ID | Compare-and-swap | Authenticated ciphertext |
| FHIR fragment | Random 256-bit ID | Immutable | Authenticated ciphertext |
| Provenance event | Random 256-bit ID | Immutable | Authenticated ciphertext |

Decrypted state contains current provenance heads and authorized clinician
public keys. Decrypted events contain parent event IDs, a fragment ID, resource
type, content hash, timestamp, clinician ID, clinician signature, and
patient-authorization MAC.

## Append flow

1. Derive the opaque capsule locator from the biometric token.
2. Decrypt both key shares and reconstruct the record data key.
3. Decrypt record state and verify that the clinician public key is authorized.
4. Validate the FHIR resource.
5. Encrypt the resource under a per-fragment key and create it immutably.
6. Sign the event payload with the clinician private key.
7. MAC the event payload with the record key to prove patient-side key access.
8. Encrypt and create the event immutably.
9. Replace the state heads using compare-and-swap.

A failed compare-and-swap leaves unreachable encrypted blobs, which reveal no
record contents but require later garbage-collection design.

## Assembly flow

The assembler walks backward from every state head. Before returning resources,
it rejects cycles, missing parents, decryption failures, unknown clinicians,
invalid signatures, invalid patient MACs, fragment hash mismatches, malformed
FHIR, and duplicate event identifiers.

## Global Patient Record Project provenance model

The project combines opaque-key access, blob-backed provenance records,
append-only APIs, encrypted FHIR fragments, and parent-event lineage. It avoids
centralized patient lookup and generic possession-only authorization. Signed
events form a provenance DAG that can be verified before clinical information
is displayed.

## Future milestones

- Real biometric SDK adapter with template protection and liveness evidence
- Multi-finger enrollment and recovery policy
- Multiple authorized clinicians with revocation
- Offline branch creation and deterministic merge
- Distributed object-store adapter
- FHIR profile validation and consent resources
- Metadata-hiding access protocol
- Independent cryptographic, clinical-safety, legal, and ethics reviews
