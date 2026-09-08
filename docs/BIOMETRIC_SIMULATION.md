# Biometric Simulation and Google Health SDK Fit

## What the browser simulation does

The local UI creates a random 256-bit value with the browser Web Crypto API and
stores it in browser local storage under a user-supplied demonstration label.
Pressing "Simulate fingerprint capture" represents a successful capture,
liveness check, match, and protected token release by an external biometric
system.

The label is never sent to the API. The random token is used as the input to
the existing patient-factor derivation logic and is not persisted in the
server-side object store.

This simulation tests application flow only. It does not model fingerprint
noise, false acceptance, false rejection, template aging, sensor quality,
injury, spoof detection, or multi-finger recovery.

## Can Google health SDKs provide the patient fingerprint?

No. Google Open Health Stack and the Android FHIR SDK provide components for
FHIR-native Android applications, including structured data capture, local FHIR
storage, workflows, and synchronization. They are useful for a future
offline-first clinical application, but they do not capture fingerprints or
produce patient biometric identifiers.

Android `BiometricPrompt` can ask the device operating system to authenticate
one of the biometrics already enrolled on that Android device. It returns an
authentication result and can authorize use of a key held by Android Keystore.
It deliberately does not expose the fingerprint image or template.

That makes `BiometricPrompt` appropriate for protecting a clinician or clinic
device credential. It is not sufficient for identifying arbitrary patients on
a shared field tablet: enrolling every patient into the tablet's operating
system would mix device-owner authentication with patient identification and
would not provide the required portable patient token.

## Recommended future Android split

1. Use Android FHIR SDK for offline FHIR forms, local workflow, and controlled
   synchronization.
2. Use Android Keystore plus `BiometricPrompt` to unlock the clinician/device
   signing credential.
3. Use a separate field biometric SDK and supported external or integrated
   scanner for patient capture, liveness, matching, and protected template/token
   generation.
4. Pass only a high-entropy pseudonymous token into the record-key protocol.
   Never pass raw images or templates to the FHIR engine, cloud analytics, or
   general application logs.

## Primary documentation

- Android FHIR SDK:
  `https://developers.google.com/open-health-stack/android-fhir`
- FHIR Engine Library:
  `https://developers.google.com/open-health-stack/android-fhir/fhir-engine`
- Android biometric authentication:
  `https://developer.android.com/identity/sign-in/biometric-auth`
- AndroidX BiometricPrompt:
  `https://developer.android.com/reference/androidx/biometric/BiometricPrompt`
