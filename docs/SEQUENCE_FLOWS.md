# Global Patient Record Project Sequence Flows

This document describes the proof-of-concept runtime interactions. The
diagrams use Mermaid syntax and render directly in GitHub.

## Participants and trust boundaries

| Participant | Trust assumption |
| --- | --- |
| Patient | Provides physical presence through a future biometric capture flow. |
| Biometric SDK | Trusted to perform capture, liveness, matching, and protected token generation. Simulated in the current browser demo. |
| Clinician | Holds an authorized signing/decryption credential. |
| Edge application | Trusted while unlocked; must avoid persistent cleartext, logs, crash dumps, and swap leakage. |
| Patient record service | Orchestrates cryptography, validation, provenance, and storage. |
| Object store | Untrusted for confidentiality and integrity; trusted only to return bytes and provide basic availability. |

## 1. Patient-factor simulation in the local demo

The browser demo does not process a fingerprint. It generates a random
high-entropy token to stand in for the protected output of a biometric SDK.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as Local Browser UI
    participant Crypto as Web Crypto API
    participant BrowserStore as Browser Local Storage

    User->>UI: Enter browser-only patient label
    User->>UI: Select "Simulate fingerprint capture"
    UI->>Crypto: Generate 256 random bits
    Crypto-->>UI: Synthetic patient-factor token
    UI->>BrowserStore: Store label, random token, and local ID
    UI->>UI: Select new factor in all patient-factor dropdowns
    UI-->>User: Show active simulated patient factor

    Note over UI,BrowserStore: The patient label is never sent to the server.
    Note over User,Crypto: No fingerprint image or template is captured.
```

## 2. Clinician credential creation

The POC generates a local RSA key pair. Production credential issuance would
require institutional enrollment, secure hardware, rotation, and revocation.

```mermaid
sequenceDiagram
    autonumber
    actor Clinician
    participant UI as Local Browser UI
    participant API as Local HTTP API
    participant Crypto as Cryptographic Service
    participant BrowserStore as Browser Local Storage

    Clinician->>UI: Create local clinician credential
    UI->>API: POST /api/clinicians
    API->>Crypto: Generate RSA-2048 key pair
    Crypto->>Crypto: Hash public key into credential ID
    Crypto-->>API: Credential ID, public key, private key
    API-->>UI: Demonstration credential
    UI->>BrowserStore: Store credential locally
    UI-->>Clinician: Display shortened credential ID

    Note over UI,BrowserStore: Browser storage is acceptable only for the demo.
```

## 3. Patient enrollment

Enrollment creates a random record data key, splits it into patient and
clinician shares, and stores only encrypted state.

```mermaid
sequenceDiagram
    autonumber
    actor Patient
    actor Clinician
    participant Bio as Biometric SDK
    participant Edge as Edge Application
    participant Service as Patient Record Service
    participant Crypto as Cryptographic Service
    participant Store as Untrusted Object Store

    Patient->>Bio: Present enrolled finger
    Bio->>Bio: Capture, liveness, match, template protection
    Bio-->>Edge: Stable high-entropy patient token
    Clinician->>Edge: Unlock clinician credential
    Edge->>Service: Enroll(patient token, clinician credential)
    Service->>Crypto: Verify clinician key pair
    Service->>Crypto: Derive opaque capsule locator
    Service->>Store: Check locator does not already exist
    Store-->>Service: Not found
    Service->>Crypto: Generate random 256-bit record data key
    Service->>Crypto: Split data key into patient and clinician shares
    Service->>Crypto: Derive salted biometric wrapping key
    Service->>Crypto: Encrypt patient share
    Service->>Crypto: Encrypt clinician share to clinician public key
    Service->>Crypto: Encrypt initial record state
    Service->>Store: Create encrypted record-state object at random ID
    Service->>Store: Create unlock capsule at opaque locator
    Store-->>Service: Objects created
    Service-->>Edge: Enrollment complete
    Edge-->>Clinician: Confirm encrypted record creation

    Note over Service,Store: The store receives no patient name, raw biometric, FHIR content, or record key.
```

## 4. Append an encrypted FHIR entry

Every append requires both factors, creates immutable objects, and advances the
encrypted record head using compare-and-swap.

```mermaid
sequenceDiagram
    autonumber
    actor Patient
    actor Clinician
    participant Bio as Biometric SDK
    participant Edge as Edge Application
    participant Service as Patient Record Service
    participant Crypto as Cryptographic Service
    participant Store as Untrusted Object Store

    Patient->>Bio: Present finger
    Bio-->>Edge: Protected patient token
    Clinician->>Edge: Authorize with clinician credential
    Clinician->>Edge: Enter clinical information
    Edge->>Service: Append(patient token, clinician credential, FHIR resource)
    Service->>Service: Validate supported FHIR resource

    rect rgb(235, 246, 251)
        Note over Service,Store: Dual unlock
        Service->>Crypto: Derive capsule locator
        Service->>Store: Read unlock capsule
        Store-->>Service: Encrypted capsule
        Service->>Crypto: Decrypt patient share using biometric-derived key
        Service->>Crypto: Decrypt clinician share using clinician private key
        Service->>Crypto: Combine shares into record data key
        Service->>Crypto: Decrypt state pointer and record state
        Service->>Service: Confirm clinician is authorized
    end

    Service->>Crypto: Canonicalize and hash FHIR resource
    Service->>Crypto: Encrypt FHIR fragment with context-derived key
    Service->>Crypto: Build event with current head as parent
    Service->>Crypto: Sign event with clinician private key
    Service->>Crypto: MAC event with record data key
    Service->>Crypto: Encrypt provenance event
    Service->>Store: Create immutable FHIR fragment
    Service->>Store: Create immutable provenance event
    Service->>Store: Compare-and-swap encrypted state to new head

    alt State version is current
        Store-->>Service: New state version
        Service-->>Edge: Event ID and fragment ID
        Edge-->>Clinician: Entry appended
    else Another append changed the state
        Store-->>Service: Concurrent update error
        Service-->>Edge: Reject and require retry or future merge
        Edge-->>Clinician: Entry was not attached to the active timeline
    end
```

## 5. Unlock and verify a patient timeline

The system does not return a partially verified timeline. Every reachable event
and fragment must pass integrity checks before the result is presented.

```mermaid
sequenceDiagram
    autonumber
    actor Patient
    actor Clinician
    participant Bio as Biometric SDK
    participant Edge as Edge Application
    participant Service as Patient Record Service
    participant Crypto as Cryptographic Service
    participant Store as Untrusted Object Store

    Patient->>Bio: Present finger
    Bio-->>Edge: Protected patient token
    Clinician->>Edge: Authorize with clinician credential
    Edge->>Service: Assemble(patient token, clinician credential)
    Service->>Crypto: Perform dual unlock
    Service->>Store: Read encrypted current state
    Store-->>Service: State with event heads

    loop For every head and parent event
        Service->>Store: Read encrypted provenance event
        Store-->>Service: Event ciphertext
        Service->>Crypto: Decrypt event
        Service->>Service: Reject duplicate or cyclic event
        Service->>Crypto: Verify clinician signature
        Service->>Crypto: Verify patient authorization MAC
        Service->>Store: Read encrypted FHIR fragment
        Store-->>Service: Fragment ciphertext
        Service->>Crypto: Decrypt fragment
        Service->>Service: Validate FHIR resource
        Service->>Crypto: Recalculate canonical content hash
        Service->>Service: Compare hash and resource type to event
    end

    Service->>Service: Order verified parent-before-child timeline
    Service-->>Edge: Verified FHIR timeline
    Edge-->>Clinician: Render ephemeral clinical summary

    Note over Edge,Clinician: Production clients must avoid writing decrypted resources to persistent storage.
```

## 6. Access denied with only one valid factor

The record is not unlocked if either side is missing or incorrect.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Edge as Edge Application
    participant Service as Patient Record Service
    participant Store as Untrusted Object Store
    participant Crypto as Cryptographic Service

    User->>Edge: Supply valid patient factor and wrong clinician credential
    Edge->>Service: Assemble request
    Service->>Store: Read capsule at derived locator
    Store-->>Service: Encrypted capsule
    Service->>Service: No clinician share for supplied credential ID
    Service-->>Edge: Access denied
    Edge-->>User: No clinical information displayed

    Note over Service,Crypto: A clinician credential without the correct patient factor fails before the capsule can be located or decrypted.
```

## 7. Tampered storage object

AES-GCM authentication and event-level verification make modification
detectable.

```mermaid
sequenceDiagram
    autonumber
    actor Attacker
    participant Store as Untrusted Object Store
    participant Service as Patient Record Service
    participant Crypto as Cryptographic Service
    participant Edge as Edge Application

    Attacker->>Store: Modify event or FHIR ciphertext
    Edge->>Service: Request timeline assembly
    Service->>Store: Read modified object
    Store-->>Service: Modified ciphertext
    Service->>Crypto: AES-GCM decrypt and authenticate
    Crypto-->>Service: Authentication failure
    Service-->>Edge: Integrity error
    Edge->>Edge: Render no partial clinical timeline
```

## 8. Future offline branch and merge

This is a proposed flow, not implemented in the current POC.

```mermaid
sequenceDiagram
    autonumber
    participant ClinicA as Offline Clinic A
    participant ClinicB as Offline Clinic B
    participant Store as Distributed Object Store
    participant Merge as Merge and Verification Service

    ClinicA->>ClinicA: Append event A from common parent P
    ClinicB->>ClinicB: Append event B from common parent P
    ClinicA->>Store: Sync encrypted fragment A and event A
    ClinicB->>Store: Sync encrypted fragment B and event B
    Store-->>Merge: State has heads A and B
    Merge->>Merge: Verify both branches independently
    Merge->>Merge: Apply deterministic ordering and conflict policy
    Merge->>Store: Append merge event M with parents A and B
    Store-->>ClinicA: Updated head M
    Store-->>ClinicB: Updated head M

    Note over ClinicA,Merge: Clinical conflicts must be surfaced; merge must not silently choose one medical assertion.
```

## 9. Potential GOSQAS interoperability boundary

This proposed boundary allows the projects to share provenance infrastructure
without forcing identical access policies.

```mermaid
sequenceDiagram
    autonumber
    participant Domain as Domain Application
    participant Policy as Domain Policy Adapter
    participant Kernel as Shared Provenance Kernel
    participant Storage as Storage Adapter

    Domain->>Policy: Submit domain payload and actor context
    Policy->>Policy: Apply domain validation and authorization
    Policy->>Kernel: Create immutable signed event and content object
    Kernel->>Storage: Persist opaque encrypted objects
    Storage-->>Kernel: Object IDs and versions
    Kernel-->>Policy: Verifiable provenance result
    Policy-->>Domain: Domain-specific record or timeline

    Note over Policy,Kernel: GOSQAS can retain capability-sharing policy while the patient project requires dual authorization.
```

## Implementation references

- Enrollment, append, unlock, and assembly:
  `src/service/patient-record-service.ts`
- Cryptographic primitives: `src/crypto/primitives.ts`
- Provenance types: `src/domain/provenance.ts`
- Storage abstraction: `src/storage/blob-store.ts`
- Local API: `src/web/server.ts`
- Browser biometric simulation and workflow: `web/app.js`
- Security assumptions: `docs/THREAT_MODEL.md`
- GOSQAS relationship and reuse analysis: `docs/README.md`
