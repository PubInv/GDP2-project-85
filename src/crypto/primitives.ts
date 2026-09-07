import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  scryptSync,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";

import type { ClinicianCredential } from "../domain/provenance.js";

export interface AesEnvelope {
  algorithm: "A256GCM";
  iv: string;
  ciphertext: string;
  tag: string;
}

const KEY_BYTES = 32;
const BIOMETRIC_TOKEN_MINIMUM_LENGTH = 16;

export function createClinicianCredential(): ClinicianCredential {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  return {
    credentialId: clinicianCredentialId(publicKey),
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
  };
}

export function clinicianCredentialId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({
    type: "spki",
    format: "der",
  });
  return sha256(der);
}

export function assertValidClinicianCredential(
  credential: ClinicianCredential,
): void {
  if (
    clinicianCredentialId(credential.publicKeyPem) !== credential.credentialId
  ) {
    throw new Error("Clinician credential ID does not match its public key.");
  }

  const challenge = randomBytes(32);
  const signature = signPayload(challenge, credential.privateKeyPem);
  if (!verifyPayload(challenge, signature, credential.publicKeyPem)) {
    throw new Error("Clinician private key does not match its public key.");
  }
}

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function randomId(): string {
  return randomBytes(32).toString("base64url");
}

export function deriveBiometricKey(
  biometricToken: string,
  salt: Buffer,
): Buffer {
  assertBiometricToken(biometricToken);
  return scryptSync(biometricToken, salt, KEY_BYTES, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

export function deriveCapsuleLocator(biometricToken: string): string {
  assertBiometricToken(biometricToken);
  return createHmac("sha256", biometricToken)
    .update("global-private-health-records:capsule:v1")
    .digest("base64url");
}

export function deriveContextKey(key: Buffer, context: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      key,
      Buffer.from("global-private-health-records:v1", "utf8"),
      Buffer.from(context, "utf8"),
      KEY_BYTES,
    ),
  );
}

export function encryptJson(
  value: unknown,
  key: Buffer,
  associatedData: string,
): AesEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const plaintext = Buffer.from(canonicalJson(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    algorithm: "A256GCM",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptJson<T>(
  envelope: AesEnvelope,
  key: Buffer,
  associatedData: string,
): T {
  if (envelope.algorithm !== "A256GCM") {
    throw new Error("Unsupported encryption envelope.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function splitKey(key: Buffer): [Buffer, Buffer] {
  const patientShare = randomBytes(key.length);
  return [patientShare, xorBuffers(key, patientShare)];
}

export function combineKeyShares(
  patientShare: Buffer,
  clinicianShare: Buffer,
): Buffer {
  if (
    patientShare.length !== KEY_BYTES ||
    clinicianShare.length !== KEY_BYTES
  ) {
    throw new Error("Invalid key-share length.");
  }
  return xorBuffers(patientShare, clinicianShare);
}

export function encryptForClinician(
  value: Buffer,
  publicKeyPem: string,
): string {
  return publicEncrypt(
    {
      key: publicKeyPem,
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    value,
  ).toString("base64url");
}

export function decryptForClinician(
  value: string,
  privateKeyPem: string,
): Buffer {
  return privateDecrypt(
    {
      key: privateKeyPem,
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    Buffer.from(value, "base64url"),
  );
}

export function signCanonical(value: unknown, privateKeyPem: string): string {
  return signPayload(Buffer.from(canonicalJson(value), "utf8"), privateKeyPem);
}

export function verifyCanonical(
  value: unknown,
  signature: string,
  publicKeyPem: string,
): boolean {
  return verifyPayload(
    Buffer.from(canonicalJson(value), "utf8"),
    signature,
    publicKeyPem,
  );
}

export function createAuthorizationMac(value: unknown, key: Buffer): string {
  return createHmac("sha256", key)
    .update(canonicalJson(value))
    .digest("base64url");
}

export function verifyAuthorizationMac(
  value: unknown,
  expected: string,
  key: Buffer,
): boolean {
  const actual = Buffer.from(createAuthorizationMac(value, key), "base64url");
  const expectedBuffer = Buffer.from(expected, "base64url");
  return (
    actual.length === expectedBuffer.length &&
    timingSafeEqual(actual, expectedBuffer)
  );
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }

  return value;
}

function xorBuffers(left: Buffer, right: Buffer): Buffer {
  if (left.length !== right.length) {
    throw new Error("Cannot combine key shares of different lengths.");
  }

  const output = Buffer.alloc(left.length);
  for (let index = 0; index < left.length; index += 1) {
    output[index] = left[index]! ^ right[index]!;
  }
  return output;
}

function signPayload(payload: Buffer, privateKeyPem: string): string {
  return sign("sha256", payload, {
    key: privateKeyPem,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString("base64url");
}

function verifyPayload(
  payload: Buffer,
  signature: string,
  publicKeyPem: string,
): boolean {
  return verify(
    "sha256",
    payload,
    {
      key: publicKeyPem,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    },
    Buffer.from(signature, "base64url"),
  );
}

function assertBiometricToken(biometricToken: string): void {
  if (biometricToken.length < BIOMETRIC_TOKEN_MINIMUM_LENGTH) {
    throw new Error(
      `Synthetic biometric token must contain at least ${BIOMETRIC_TOKEN_MINIMUM_LENGTH} characters.`,
    );
  }
}
