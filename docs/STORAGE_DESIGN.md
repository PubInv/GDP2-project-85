# Pluggable storage decision (draft)

## Scope

This draft addresses the storage seam behind issue #1. It adds executable cloud
and private-IPFS experiments without changing dual unlock, FHIR validation,
signatures, MACs, or provenance verification. It does not claim clinical,
regulatory, or production readiness.

The [storage topology diagrams](STORAGE_TOPOLOGY_DIAGRAMS.md) distinguish
implemented composition from proposed AWS infrastructure and local test setups.
Azure deployment topology is **To be decided**.

```text
PatientRecordService -> BlobStore
                         |-- InMemoryBlobStore (test)
                         |-- FileBlobStore (local, single-process)
                         |-- AzureBlobStore (conditional block-blob writes)
                         |-- S3BlobStore (conditional object writes)
                         |-- DynamoDbBlobStore (strong reads, conditional metadata)
                         `-- DistributedBlobStore
                               |-- private Kubo / IPFS Cluster (immutable bytes)
                               `-- configured BlobStore (key-to-CID index, CAS)
```

Each deployment chooses one backend. Cross-cloud mirroring and a
`ReplicatedBlobStore` are deliberately absent: acknowledging partial writes
across independent services is not atomic CAS, and rollback would not solve
concurrent writers. A separate consensus/repair design is required.

The contract lives in `src/storage/core/`, generic selection and secrets in
`src/storage/config/`, and each implementation plus its construction/config
factory in `src/storage/adapters/{provider}/`. Provider-specific tests mirror
these folders. Additional typed factories can be registered at the application
composition root; selection does not require changing the service or adding
another provider-specific branch to the generic factory.

The optional AWS path runs Kubo on EC2 with encrypted EBS persistence, uses
DynamoDB for the atomic index, and synchronously copies immutable encrypted
content into SSE-KMS S3 before index publication. The backup wrapper consumes
the same provider-neutral `BlobStore`, so neither it nor the record service
imports an S3 SDK. KMS protects AWS storage encryption keys and does not replace
dual unlock. See [AWS foundation](AWS_HYBRID_STORAGE.md) for infrastructure and
failure-domain limits.

## Contract and concurrency

`create` preserves version 1 only if the opaque key is absent. `read` returns
the serialized value and logical numeric version. `compareAndSwap` must reject
missing/stale records and permit only one writer for the expected version.
Azure/S3 read the body and provider ETag together, check the logical version,
then condition the replacement on that ETag. No process-local map is used for
cloud concurrency. Native precondition failures map to contract errors;
authorization, service, malformed-object, and transport failures remain errors.

DynamoDB uses strongly consistent reads and a conditional item replacement
against the expected version in a single-region table. It requires a string
partition key named `key` and no sort key. Serialized payloads are limited to
350 KiB, so this adapter is intended primarily for small IPFS metadata pointers,
not large encrypted content or backups. DAX and eventually consistent
multi-region global-table writes are not supported CAS authorities.

Factory-created SDK clients do not automatically retry writes. A timed-out
request may have committed; callers must not interpret a timeout as definite
rollback or blindly re-append. Read/reconcile verified history before retrying.
The web API returns a generic conflict for known stale updates and never logs
raw provider errors, which may contain request headers.

The distributed adapter persists new immutable content before atomically
publishing its index pointer. A failed CAS can leave unreachable encrypted
blocks. It does not unpin/delete on failure because another writer or reference
may need those blocks. Garbage collection needs a separate reachability and
retention design.

## Availability boundary

IPFS Cluster coordinates retention and replica placement; it is not the
application's numeric CAS authority. A private swarm and independently operated
peers are infrastructure requirements, not something a config flag proves.
The adapter's observed replication status is not a perpetual durability
guarantee. Health monitoring, independent operators, repair, funding, incident
response, and recovery exercises remain necessary.

The index remains a dependency even if every encrypted block is replicated.
Azure/S3 make it possible to use managed infrastructure instead of a single
local file, but do not eliminate the provider/account trust boundary. This
draft therefore makes progress on issue #1; it does not fully satisfy "no
single point of failure" or guarantee ten years of service. Future work is a
reviewed consensus-backed index or signed multi-head publication/merge protocol,
not an ordinary IPNS mutable pointer pretending to provide linearizable CAS.

## Security and metadata

- Existing application encryption stays in place; provider-side encryption is
  defense in depth, not a substitute for dual unlock.
- Cloud operators observe opaque keys, size, timing, revisions, and access
  patterns. IPFS/Cluster peers additionally observe CIDs, pin placement, and
  ciphertext equality. The index links opaque object keys and revisions to
  CIDs. Do not add patient identifiers to blob names, tags, prefixes, or logs.
- TLS remains enabled; loopback HTTP is opt-in emulator behavior only.
  Service credentials are resolved at runtime through workload identity,
  Key Vault, AWS Secrets Manager, or restricted secret mounts. No static
  credentials are checked in.
- Default credential chains are a convenience, not proof of least privilege;
  operators must configure narrowly scoped identities and network controls.
- Authenticated encryption detects modification but does not independently
  prove freshness against rollback of an entire valid storage snapshot.
  Durable freshness anchors/rollback resistance remain future work.
- Encryption cannot recover lost patient/clinician factors; replicated
  ciphertext is not a credential-recovery strategy.
- Storage-provider administration can still delete objects or deny service.
  Permission policies, backups, retention, and periodic restore tests are
  necessary operational controls.

## Validation boundary

Default tests use synthetic values, fake provider transports, and shared
contract scenarios. Azurite exercises the actual Azure SDK without an account.
The private Docker fixture and opt-in provider suite exercise external APIs.
Real-cloud authentication/KMS/network behavior requires the manual protected
workflow or a local approved identity; it cannot be validated without accounts.
The quickstart lists exactly which settings and provisioning steps are needed.

## References

- [Azure concurrency](https://learn.microsoft.com/azure/storage/blobs/concurrency-manage)
- [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- [IPFS persistence](https://docs.ipfs.tech/concepts/persistence/)
- [IPFS Cluster pinning](https://ipfscluster.io/documentation/guides/pinning/)
- [GitHub OIDC](https://docs.github.com/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
