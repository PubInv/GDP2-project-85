import { describe, expect, it } from "vitest";

import {
  createClinicianCredential,
  deriveCapsuleLocator,
} from "../src/index.js";
import {
  combineKeyShares,
  createAuthorizationMac,
  decryptForClinician,
  decryptJson,
  deriveBiometricKey,
  encryptForClinician,
  encryptJson,
  randomKey,
  signCanonical,
  splitKey,
  verifyAuthorizationMac,
  verifyCanonical,
} from "../src/crypto/primitives.js";

describe("cryptographic primitives", () => {
  it("requires both key shares to reconstruct the record key", () => {
    const key = randomKey();
    const [patientShare, clinicianShare] = splitKey(key);

    expect(combineKeyShares(patientShare, clinicianShare)).toEqual(key);
    expect(combineKeyShares(patientShare, randomKey())).not.toEqual(key);
  });

  it("encrypts and authenticates JSON with associated data", () => {
    const key = randomKey();
    const envelope = encryptJson({ resourceType: "Condition" }, key, "object-1");

    expect(
      decryptJson(envelope, key, "object-1"),
    ).toEqual({ resourceType: "Condition" });
    expect(() => decryptJson(envelope, key, "object-2")).toThrow();
  });

  it("wraps a clinician share and verifies signatures", () => {
    const clinician = createClinicianCredential();
    const share = randomKey();
    const encrypted = encryptForClinician(share, clinician.publicKeyPem);
    const payload = { eventId: "event-1" };
    const signature = signCanonical(payload, clinician.privateKeyPem);

    expect(decryptForClinician(encrypted, clinician.privateKeyPem)).toEqual(
      share,
    );
    expect(
      verifyCanonical(payload, signature, clinician.publicKeyPem),
    ).toBe(true);
    expect(
      verifyCanonical({ eventId: "event-2" }, signature, clinician.publicKeyPem),
    ).toBe(false);
  });

  it("derives stable opaque locators and patient authorization MACs", () => {
    const token = "synthetic-high-entropy-token-0001";
    const otherToken = "synthetic-high-entropy-token-0002";
    const payload = { eventId: "event-1" };
    const key = deriveBiometricKey(token, Buffer.alloc(16, 1));
    const mac = createAuthorizationMac(payload, key);

    expect(deriveCapsuleLocator(token)).toBe(deriveCapsuleLocator(token));
    expect(deriveCapsuleLocator(token)).not.toBe(
      deriveCapsuleLocator(otherToken),
    );
    expect(verifyAuthorizationMac(payload, mac, key)).toBe(true);
    expect(
      verifyAuthorizationMac({ eventId: "event-2" }, mac, key),
    ).toBe(false);
  });
});
