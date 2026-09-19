# Experimental private distributed storage

Global Patient Record Project is research software, not clinically or
production ready. `DistributedBlobStore(metadata, content)` separates a required
atomic key-to-CID index from immutable opaque content. It serializes JSON values
inside a format envelope, computes a CIDv1 raw SHA-256 identifier, and publishes
the pointer only after `content.put` confirms its replication policy. Reads
verify bytes against the pointer CID before decoding. The storage adapter does
not encrypt: callers must supply authenticated ciphertext, never plaintext FHIR,
biometrics, tokens, or derived keys.

## Atomicity and failure model

The injected `BlobStore` index supplies atomic create and numeric-version CAS.
Use cloud conditional-write storage or an independently consensus-backed
implementation across processes. `FileBlobStore` is only a local,
single-process demonstration. **IPFS and Cluster do not provide this
application's CAS**, and this design does not achieve independent decentralized
CAS. There is no storage fallback.

Content is uploaded and pinned before index create/CAS. A losing concurrent
writer, failed index request, or replication timeout may leave unreachable
blocks and pins. No destructive cleanup is attempted: another writer or key may
reference the same CID. Retain and reconcile with the complete authoritative
index and backups before any operator-controlled garbage collection. A timeout
can have an ambiguous outcome. The uploading Kubo block is locally pinned to
avoid garbage collection while Cluster distributes it.

## Client and deployment requirements

`IpfsClusterClient` implements `DistributedContentStore`:
`put(Uint8Array): Promise<string>` and `get(cid): Promise<Uint8Array>`.
Its options are `kuboUrl`, `clusterUrl`, optional `kuboAuthorization` and
`clusterAuthorization` (complete Authorization header values), and optional
`minReplicas`/`maxReplicas` (both default 2), `timeoutMs` (30000),
`pollIntervalMs` (250), and `maxBlobBytes` (1048575). `fetch` is an optional
injected transport for tests. Secret resolution belongs outside the client:
load headers through the application's secret-file/Key Vault configuration,
not source, command arguments, URLs, logs, or examples.

Endpoint URLs are origins only, HTTPS by default, without credentials, paths,
queries or fragments. HTTP requires explicit `allowInsecureLocal: true` and
localhost/127.0.0.1/[::1]; use that only for isolated development. Redirects
are refused and credentials are scoped separately to each endpoint. The
deadline covers requests, body reads and polling. Bodies and raw blocks are
bounded; raw blocks must be nonempty and smaller than 1 MiB.

The wire API is Kubo `POST /api/v0/block/put` with multipart file, raw codec and
SHA-256, then Cluster `POST /pins/{cid}` with `replication-min` and
`replication-max`. Retrieval uses Kubo `POST /api/v0/block/get`; there is no
public gateway. Kubo's returned CID and length must match local bytes.

Replication polls Cluster `GET /pins/{cid}?local=false` and `/peers` (NDJSON
or array). A replica must report exactly `pinned`, no error, and a matching,
live Cluster/Kubo identity from the peer query. Duplicate Cluster identities
and multiple Cluster peers backed by one Kubo do not count twice. Allocation,
queued, remote, error, and stale pinned entries for unavailable peers do not
count. Require a modern **stateless pin tracker**, whose single-CID status
queries Kubo pin state; legacy cached trackers are not supported. Pin timestamps
are creation/change times, not liveness proofs, and are not counted as such.
The app cannot authenticate whether an operator actually selected that tracker.

This is a momentary observation from trusted administrative endpoints, not
proof of ongoing durability, independent failure domains, Byzantine honesty,
or future availability. Nodes can fail immediately afterward. Monitor and
repair replication separately, test restore, and keep encrypted backups.
`minReplicas: 1, maxReplicas: 1` is only for an isolated single-node test.

Configure and verify the private Kubo swarm **outside this application**:
runtime-mount the shared swarm key and Cluster secret, remove public bootstrap
peers, disable public discovery/routing as appropriate, and restrict all
administrative, swarm and gateway listeners with network policy. Do not commit
those secrets. Cluster's peer secret is not the Kubo swarm key. Cluster is
neither storage confidentiality nor application CAS; encryption remains
mandatory. Private peers see ciphertext, CIDs, sizes, pin membership and
timing; the index sees random object keys, CIDs and versions.

## Upstream references

Consult the official Kubo RPC reference (`docs.ipfs.tech/reference/kubo/rpc/`),
Cluster REST reference (`ipfscluster.io/documentation/reference/api/`), and
`ipfs-cluster/ipfs-cluster` source: `api/types.go` (`GlobalPinInfo`, `ID`,
`PinOptions.ToQuery`) and `pintracker/stateless/stateless.go`
(`Tracker.Status`, which calls `PinLsCid`). Pin dependency/container versions
and verify these wire contracts in the opt-in integration environment.
