# Storage setup and end-to-end check

**Synthetic data only. This remains a research POC, not a production health-record system.**
Choose one backend; the adapters do not automatically copy data between clouds.
Existing `.data/web` records are not migrated when the backend changes.
Give IPFS's key-to-CID index its own container/bucket (using the same Azure/S3
settings), not a namespace already populated by a direct-storage adapter.
Provider implementations and setup are segregated under
`src/storage/adapters/`. See the [extension guide](../src/storage/README.md)
for the folder layout and registering a custom adapter without editing the
record service or built-in factory.

## Without any cloud accounts

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run test:integration:azure
npm run example:storage
```

The Azure command starts a temporary loopback-only Azurite process, generates
throwaway credentials in memory, exercises the real Azure SDK, and cleans up.
It needs no Azure account or Docker. `example:storage` uses `.data/web` by
default; it generates fresh synthetic factors, enrolls, appends two entries,
reconnects, and checks access denial. It logs no factors or resource contents.
The factors are discarded on exit, so the remaining encrypted test records
cannot be unlocked later. Use a dedicated disposable store for this example.

On a native Linux Docker host (including the Ubuntu CI runner),
`npm run test:integration:ipfs` runs the isolated private distributed-storage
fixture. Docker Desktop and remote Docker daemons are not supported by this
fixture. It uses temporary file metadata/backups, including verified content
restore, never an inherited cloud-backup setting. See [distributed storage](DISTRIBUTED_STORAGE.md)
for architecture, network restrictions, availability, and coordination limits.

## Configure Azure or AWS later

Copy `.env.example` to **`.env.local`** (ignored), uncomment only your backend's
nonsecret settings, and replace placeholders. The app does not auto-load env files.
To load one explicitly:

```sh
node --env-file=.env.local --import tsx examples/configured-storage.ts
node --env-file=.env.local --import tsx src/web/server.ts
```

| Backend | Settings | Runtime authentication |
| --- | --- | --- |
| `file` | `STORAGE_FILE_DIRECTORY` (default `.data/web`) | Local filesystem permissions; single process only |
| `azure` | `AZURE_STORAGE_ACCOUNT_URL`, `AZURE_STORAGE_CONTAINER` | `DefaultAzureCredential`: local `az login`, workload identity, or managed identity |
| `s3` | `S3_BUCKET`, `AWS_REGION`; optional `STORAGE_PREFIX`, `S3_KMS_KEY_ID` | AWS default credential chain: local SSO profile, workload role, or web identity |
| `dynamodb` | `DYNAMODB_TABLE`, `AWS_REGION`; optional `STORAGE_PREFIX` | AWS role/SSO credential chain; intended as IPFS's atomic metadata index |
| `ipfs` | Private API URLs, index backend, replication and runtime-secret settings in `.env.example` | Authenticated HTTPS APIs; cloud identity for index; secret-file, Key Vault, or Secrets Manager API authorization |

Provision the container/bucket and permissions **before** running. The application
never creates cloud resources, changes IAM/RBAC, makes containers public, or
deletes stored records. Do not put connection strings, SAS URLs, cloud access
keys, private keys, tokens, or real patient data in repository files or GitHub
secrets. Production-like configuration rejects plaintext non-loopback endpoints
and disabled TLS certificate validation.

**Azure:** disable anonymous blob access and shared-key authorization; require
HTTPS/TLS 1.2+, use private endpoints/firewall rules, and scope blob read/write
data permissions to the test container. Use a custom data role without delete
where practical. Enable encryption, versioning/recovery, diagnostics with
payload/authorization redaction, and reviewed retention. Managed identity needs
no storage-account key. A local CLI identity must have equivalent permissions.

**AWS:** enable Block Public Access and bucket-owner-enforced ownership; deny
non-TLS requests, use private endpoints where appropriate, and scope `s3:GetObject`
and `s3:PutObject` to the selected prefix. Grant narrowly scoped `s3:ListBucket`
if required to distinguish absent keys from access denial. For SSE-KMS, set
`S3_KMS_KEY_ID` and grant only the needed `kms:GenerateDataKey`/`kms:Decrypt`
permissions with a storage-service encryption context. Enable versioning and
reviewed recovery/replication. No application delete or bucket-admin permissions
are needed. An S3-compatible provider must support atomic conditional writes;
passing these tests is required, not assumed.

Do not enable blanket immutable/WORM retention on mutable record-state blobs:
state updates require CAS. Separate retention policy design is still needed.

## Explicit external-provider integration test

Use a dedicated synthetic-data container/bucket/private cluster. Add
`STORAGE_INTEGRATION=true` to your ignored `.env.local`, then run:

```sh
node --env-file=.env.local node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts
```

This fails rather than silently skipping if opt-in/configuration is missing.
It exercises independent-client reads, conditional creates, missing objects,
version increments, stale/concurrent writes, encrypted enroll/append/reconnect,
wrong-factor denial, cleartext absence, and tamper rejection.
The test leaves randomly keyed encrypted fixtures; remove them using your
dedicated test-store retention policy, not application-level deletion.
Emulator success does **not** establish live IAM, KMS, networking, regional
failover, regulatory compliance, or ten-year durability.

## Key Vault / mounted secrets

Azure/S3 storage authentication does not need a secret vault when workload
identity is available. The IPFS API authorization headers may be retrieved by
setting `IPFS_API_AUTH_KEYVAULT_SECRET`, `IPFS_CLUSTER_AUTH_KEYVAULT_SECRET`, and
`AZURE_KEY_VAULT_URL`. Grant the workload **get only** on those secrets.
Alternatively use `IPFS_API_AUTH_FILE`/`IPFS_CLUSTER_AUTH_FILE` pointing to
read-only, access-restricted secret mounts outside the checkout. AWS Secrets
Manager can supply them directly with `IPFS_API_AUTH_AWS_SECRET_ID` and
`IPFS_CLUSTER_AUTH_AWS_SECRET_ID` plus `AWS_REGION`, using the workload role.
Grant only `secretsmanager:GetSecretValue` on those secret ARNs and the
necessary KMS decrypt permission when their secret encryption requires it.
Another secret-store integration can supply the mounted files. Never
configure more than one source for the same secret. Secret values must be complete
single-line authorization headers (for example, a Bearer or Basic value).
IPFS swarm keys, cluster secrets, and peer private identities belong in the
node operators' secret management, not application configuration or GitHub.
Restart the process after rotating API credentials; hot-reload is not implemented.

## Optional GitHub cloud smoke test after review

`storage-ci.yml` runs account-free tests on pushes/PRs. The separate manual
`storage-cloud-smoke.yml` runs **only on `main`** after merge, behind a
`storage-integration` GitHub Environment. Configure required reviewers and
main-only deployment branch rules **before** enabling it.

Set environment **variables**, not stored credentials: Azure account/container,
client ID, tenant ID, subscription ID; or AWS role ARN, region, bucket, and KMS
key ARN (names match the workflow). Configure Azure/AWS federated identity to
trust exactly this repository's `storage-integration` environment and the
correct OIDC audience. Do not use wildcard repository trust. GitHub issues a
short-lived token; the cloud exchanges it for temporary credentials. No
long-lived cloud credential is stored in GitHub. Do not grant the cloud identity
to PR/fork workflows, upload environment dumps, or enable SDK request tracing.

The workflow deliberately uses `synthetic-integration/`. Its AWS federated role
needs object permissions and an S3 KMS encryption-context scope for that prefix.
Do not set `AWS_ROLE_ARN` to the foundation's EC2-only `NodeRoleArn`: that role
trusts EC2, not GitHub, and its object permissions cover `records/`.
Use separately reviewed synthetic resources and OIDC permissions.

After approval, select Azure, S3, DynamoDB, or `aws-hybrid` in
**Actions > Reviewed cloud storage smoke**. Hybrid mode selects private IPFS
with DynamoDB metadata and synchronous SSE-KMS S3 backups; it additionally
needs the private API URLs and Secrets Manager header-secret ARNs as variables.
Private-endpoint-only resources require a hardened runner with network access.
Set the repository variable `STORAGE_RUNNER_LABEL` to its approved runner label;
the default is `ubuntu-latest`. Account provisioning, trust, network access,
and clinical/security review cannot be supplied by this code change.

## AWS hybrid and recovery

See [AWS deployment](AWS_HYBRID_STORAGE.md) and
`examples/config/aws-hybrid.env.example`. Kubo persists encrypted content on
EC2-attached encrypted EBS; DynamoDB holds atomic key-to-CID metadata; S3 keeps
immutable application-encrypted backup bytes, additionally protected by SSE-KMS.
Backup failure prevents metadata publication. KMS protects AWS at-rest storage
keys, **not** the patient/clinician dual-unlock factors or reconstructed record key.

Recovery is explicit, not a read fallback that could hide corruption:

```sh
node --env-file=.env.local --import tsx examples/restore-content.ts OPAQUE_OBJECT_KEY
```

This verifies the backup CID, republishes it to the private cluster, and waits
for replication without modifying metadata. Restore lost DynamoDB metadata
from its separate PITR/backups first; content backups alone cannot recreate the
index or recover lost patient factors. A single EC2/EBS node is still a single
failure domain.
