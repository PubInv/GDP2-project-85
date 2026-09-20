# Local API workbench

Run from the project root:

```sh
npm ci
npm start
```

Open **http://127.0.0.1:3000/docs** for Swagger UI, or
**http://127.0.0.1:3000/openapi.json** for the OpenAPI 3.0 document.
`web/openapi.json` is the checked-in specification.
`/docs` and `/docs/` both work.

The spec uses `servers: [{ "url": "/" }]`, so **Try it out calls the same
local server and port that served the page**. If you set `PORT=3001`, open
`http://127.0.0.1:3001/docs`; no spec edit is needed. Keep the default loopback
host. No cloud account, external Swagger site, CORS change or storage PR is
required. This PR is independent of the pluggable-storage work.

## Try the complete flow

1. Expand **GET /api/status**, choose **Try it out**, then **Execute**.
   Expect `200` with `"mode": "local-poc"`.
2. Execute **POST /api/clinicians** with no body. Copy the complete JSON
   response containing `credentialId`, `publicKeyPem` and `privateKeyPem`.
   This is a newly generated **demo** key pair, not a real clinical credential.
3. For **POST /api/enroll**, choose **Try it out**. Replace the entire
   `clinician` object in the example with that response. Keep the escaped
   `\n` characters in its PEM strings. Choose a new synthetic `biometricToken`
   of at least 16 characters, then execute. Expect `201`.
4. For **POST /api/records**, paste the **same** clinician object and factor
   into the example; leave the synthetic Condition or select another supported
   resource type. Execute to append an encrypted entry. Expect `201`.
5. For **POST /api/timeline**, use the same two factors. Execute to see a `200`
   response containing the verified, decrypted synthetic timeline.

The `COPY_FROM_CLINICIAN_RESPONSE` strings are instructions, **not valid keys**.
Use a different factor for another new record. Re-enrolling an existing factor
returns `409`; an unknown factor returns `404` on timeline lookup; another
generated clinician cannot unlock that record (`403`).

Supported resources are AllergyIntolerance, Condition, Immunization,
MedicationStatement and Observation. Validation is the existing POC JSON
validation, **not full FHIR profile validation**. Maximum resource size is
256 KiB; maximum request body is 512 KiB. The spec also documents the existing
generic `500` behavior for malformed credentials, too-short factors and
unmapped service errors; adding docs does not change API error handling.

## Data and browser boundaries

**Synthetic data only. This is research software, not production or clinical
software.** Never enter real patient information, biometrics or credentials.
The default local store writes encrypted demo objects into `.data/web`.
Try it out is a real API call, not a simulation, and enrollment/append persist
data. Use a disposable local checkout/store for demonstrations.

Private demo PEMs, factors and decrypted timeline responses are visible in
the workbench and browser developer tools. Do not share screenshots, copied
requests, console output or HAR exports. Reload when finished; neither reload
nor closing a tab guarantees secure memory erasure. Losing the generated
credential/factor makes the demo record inaccessible.

Swagger assets are served from the pinned local npm package, not a CDN.
External validation, query-string configuration overrides and authorization
persistence are disabled. The initializer refuses off-origin API calls and
the page's CSP restricts network connections to this server. Inline **styles**
are permitted only on the documentation HTML for Swagger's components; the
main UI policy and script restrictions stay unchanged. Installation analytics
are opted out through `scarfSettings.enabled=false` in `package.json`.

Swagger UI is a browser dependency for `/docs` only; the existing main UI
remains dependency-free. Do not upload this spec or requests to a public
Swagger editor to test local data.

## Maintenance

Update the spec and tests together when routes or schemas change:

```sh
npm test -- test/swagger.spec.ts test/web-server.spec.ts
npm run typecheck
npm run build
```

The suite renders the installed Swagger bundle, executes the status operation,
checks same-origin configuration and local references, and runs the documented
enroll/append/timeline examples against a temporary in-memory server.
