# Pluggable storage

```text
storage/
  core/                 BlobStore contract, errors, serialization validation
  config/               Registry/factory, shared settings, runtime secret loading
  adapters/
    memory/             In-memory adapter + provider factory
    file/               Local-file adapter + provider factory
    azure/              Azure SDK adapter + Azure configuration/identity
    s3/                 S3 SDK adapter + AWS configuration/identity
    dynamodb/           Strongly consistent metadata + conditional writes
    ipfs/               Distributed adapter, private client, composed index setup
```

Every adapter owns its provider-specific construction in `provider.ts`. The
central factory is a registry, not a growing provider-specific switch statement.
Only the selected provider factory (and its declared dependencies) is invoked.
The shared contract and record service have no cloud-SDK dependencies.
The package's `src/index.ts` exports remain stable; callers need not depend on
these internal directory paths. Tests mirror the providers under `test/storage/`.

## Select an implementation

Set `STORAGE_BACKEND=file|azure|s3|dynamodb|ipfs|memory` and that provider's nonsecret
settings. The web entry point and configured example use the same factory:

```ts
import { createConfiguredBlobStore, PatientRecordService } from "./src/index.js";

const store = await createConfiguredBlobStore(process.env);
const records = new PatientRecordService(store);
```

Switching the setting changes the backend on the next application start.
It does not migrate data, mirror between backends, or change an existing
service instance's storage underneath in-flight operations.

## Add another provider without changing the service or built-in factory

Implement `BlobStore` in a new adapter folder. Supply a typed provider factory
through the application's composition root:

```ts
import {
  createConfiguredBlobStore,
  type StorageProviderFactory,
} from "./src/index.js";
import { CustomBlobStore } from "./custom-storage.js";

const custom: StorageProviderFactory = ({ environment }) =>
  new CustomBlobStore(environment.CUSTOM_STORAGE_ENDPOINT);

const store = await createConfiguredBlobStore(process.env, {
  providers: { custom },
});
// STORAGE_BACKEND=custom selects it.
```

`CustomBlobStore` above is the implementer's adapter, not a built-in class.
Validate its settings and use runtime identity/secret mounts; never store
credentials in source. A provider that composes another provider can call
`context.createStore(name)`; dependency cycles and unknown providers fail closed.
Additional provider names cannot overwrite built-ins. Custom factories are
trusted application code, not modules loaded from arbitrary environment paths.

Reuse `test/helpers/blob-store-contract.ts` against independently constructed
clients. An adapter must preserve immutable create, atomic CAS, missing-object
semantics and explicit failures. Custom metadata providers for IPFS must be
durable and atomic; registering one does not prove either property.
Keep provider IAM/SDK concerns in its own folder, not the service, shared
contract, or another provider's implementation.

For the AWS hybrid, select IPFS, `IPFS_METADATA_BACKEND=dynamodb`, and
`IPFS_BACKUP_BACKEND=s3`. The IPFS backup composition consumes only `BlobStore`;
it imports no S3 SDK. Other durable backup/index providers can be supplied
through the same registry. See the AWS runbook for KMS and EC2/EBS requirements.

See [secure setup](../../docs/STORAGE_QUICKSTART.md) for account-free examples,
integration tests, Key Vault/mounted secrets, and later cloud configuration.
