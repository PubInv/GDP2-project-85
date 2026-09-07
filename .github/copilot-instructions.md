# Global Private Health Records coding instructions

- Preserve the security invariants in `AGENTS.md`.
- Use synthetic data only; never introduce real or realistic PHI.
- Favor small provider-neutral interfaces over cloud-specific dependencies.
- Use authenticated encryption for all persisted health and provenance data.
- Keep biometric integration behind a token boundary. A token is assumed to be
  produced by an approved edge SDK after matching and liveness checks; never
  implement fingerprint hashing directly.
- Reject malformed or unsupported FHIR resources before encryption.
- Fail closed on missing objects, decryption errors, invalid signatures,
  invalid MACs, hash mismatches, cycles, and concurrent state changes.
- Add negative tests for authentication, tampering, and cleartext leakage.
- Do not describe this POC as clinically safe, HIPAA compliant, GDPR compliant,
  or production ready.
