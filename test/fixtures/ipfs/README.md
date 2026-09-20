# Private IPFS integration fixture

Run `npm run test:integration:ipfs` from the project root with Node.js 22+
and a running native Linux Docker engine on the same host (as on GitHub's
Ubuntu runners). Docker Desktop and remote Docker daemons are not supported:
the runner must be able to reach its internal bridge directly. No hosted account,
API token, public pinning service, or additional npm dependency is required.
Default `npm test` only runs the Docker-free fixture configuration tests.

The runner pulls version-pinned official images `ipfs/kubo:v0.43.1` and
`ipfs/ipfs-cluster:v1.1.6`. These versions and configuration keys were checked
against official documentation and tagged source on September 18, 2026.
Image pulls require internet access; the running fixture does not.

## Isolation and lifecycle

- Three Kubo nodes and three Raft Cluster nodes share one unique Docker
  **internal** bridge network. No host swarm, gateway, proxy, metrics, or
  cluster peer ports are published. Docker does not install published port
  mappings for containers attached only to an internal network. Instead,
  runner-owned TCP relays bind dynamically assigned `127.0.0.1` ports and
  forward only to each container's API over the private bridge. No
  internet-connected network or host networking is added. These unauthenticated administrative APIs are
  for an isolated development/CI machine, not a shared untrusted host.
- Kubo requires `LIBP2P_FORCE_PNET=1`, an independently generated swarm key,
  no public bootstrap peers, no DHT/routing/providing, no delegated routing
  or IPNS publishing, no automatic remote configuration, no mDNS, no AutoTLS,
  and no relay/NAT mapping. Peers connect explicitly by internal DNS plus
  their discovered public peer IDs.
- A distinct random Cluster secret is shared among the three Cluster nodes.
  Raft followers explicitly bootstrap to the first Cluster peer. Raft is
  chosen to exercise this fixture's quorum scenario, not recommended as a
  production topology.
- Both secrets travel on the Docker client's stdin into a uniquely named
  Docker volume. They are never written to the repository or host scratch
  files, passed in command arguments, or included in Docker's saved
  environment. Secret files are mode `0400`. Peer private identities and
  runtime configs stay in private per-node Docker volumes.
- Fresh data volumes use `volume-nocopy`, retaining root ownership for this
  fixture's UID 0 processes with all capabilities dropped, rather than copying
  image UID 1000 ownership that would prevent initialization. No permission-bypass
  capability is granted.
- The Docker log driver is disabled. The runner never dumps daemon logs,
  configuration, identities, upstream errors, or secrets.
- Only this invocation's TCP relays/connections, named containers, attached anonymous volumes,
  named volumes, network, and unique local metadata directory are removed.
  No global prune/kill operation is used. Cleanup runs on normal failure and
  catchable termination signals. Forced machine/process termination can
  leave resources bearing the unique `gphr-ipfs-` prefix; review ownership
  before manually removing any such resources.

## Application suite contract

The runner invokes the existing `vitest.integration.config.ts` with:

```text
STORAGE_INTEGRATION=true
STORAGE_BACKEND=ipfs
STORAGE_EMULATOR=true
IPFS_PRIVATE_NETWORK=true
IPFS_API_URL=http://127.0.0.1:<dynamic Kubo 1 API port>
IPFS_CLUSTER_API_URL=http://127.0.0.1:<dynamic Cluster 1 API port>
IPFS_METADATA_BACKEND=file
IPFS_BACKUP_BACKEND=file
STORAGE_FILE_DIRECTORY=<unique OS-temporary metadata and backup directory>
IPFS_REPLICATION_MIN=2
IPFS_REPLICATION_MAX=3
```

The isolated file backend holds index pointers and CID-addressed synthetic
backups. The suite includes explicit backup restoration with an unchanged
metadata version. This is not an S3 or AWS integration result.

Before starting each additional peer, readiness requires membership, allocation
metrics, and a successful consensus write with concrete pins on all existing
peers. The bootstrap probes use only random synthetic bytes, with one copy
allowed solely while the fixture has one peer; application tests still require
at least two copies. Neither probe writes nor application writes are retried.
After all three peers and allocation metrics are ready and
the application suite succeeds, the runner adds a separate random opaque
1024-byte synthetic ciphertext marker to Kubo 1, requests Cluster replication
with minimum 2 / maximum 3, and waits for recursive pins on **all three**
concrete Kubo peers. It then stops Kubo 1 and Cluster 1 and retrieves the same
existing CID from Kubo 2, comparing every byte. It does not rewrite the probe
after node loss.

This proves existing block availability on an independent replica if the
live run succeeds. It does **not** prove automatic API failover, application
record retrieval after losing its index, metadata-index replication, machine
or region failure tolerance, or production/clinical readiness. The local
metadata index remains a single point of failure.

## Official references

- Docker internal networks permit direct host-to-container communication:
  `https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal`
- Docker's internal-only port-publishing limitation:
  `https://github.com/moby/moby/issues/36174`

- Kubo Docker and swarm-key documentation:
  `https://docs.ipfs.tech/install/run-ipfs-inside-docker/`
- Tagged Kubo configuration:
  `https://github.com/ipfs/kubo/blob/v0.43.1/docs/config.md`
- Cluster distribution versions:
  `https://dist.ipfs.tech/ipfs-cluster-service/versions`
- Official Cluster container images and environment configuration:
  `https://ipfscluster.io/documentation/deployment/automations/`
- Explicit Raft bootstrap:
  `https://ipfscluster.io/documentation/deployment/bootstrap/`
- API behavior and routes:
  `https://ipfscluster.io/documentation/reference/api/`

Live validation requires Docker. A failed engine preflight is a failed
integration run, never a passing/skipped network durability test.
