# Storage topology diagrams

**Global Patient Record Project — synthetic-only research POC.** These diagrams
describe the implemented storage composition and a **proposed** AWS deployment,
not a deployed system or a clinical, regulatory, or production-readiness claim.
Azure deployment: **To be decided**; an adapter exists, but no Azure topology is
selected here.

**Legend:** solid arrows show calls/data movement; dotted arrows show control,
credentials, or infrastructure encryption. Subgraph labels distinguish
CloudFormation resources from operator-supplied deployment prerequisites.
CID means content identifier; CAS means compare-and-swap. All persisted record
content is application-encrypted; storage adapters do not perform dual unlock.

## AWS: proposed private three-peer deployment

```mermaid
flowchart TB
    subgraph APP["Application host - operator supplied"]
        UI["Local browser UI"]
        SERVICE["Loopback API and record service<br/>Patient factor AND clinician private key<br/>Encryption and verification in application"]
        STORE["DistributedBlobStore<br/>BackedUpContentStore and IpfsClusterClient"]
        UI --> SERVICE
        SERVICE -->|"Already-encrypted values"| STORE
    end

    subgraph OPS["Operator supplied - private networking and runtime"]
        AUTH["Secrets Manager or restricted external mounts<br/>Infrastructure and API authentication only"]
        PROXY["Authenticated private HTTPS endpoints<br/>Separate Kubo and Cluster authorization"]
        subgraph A["Proposed AZ A - optional foundation EC2 or operator host"]
            C1["Cluster 1"]
            K1["Kubo 1"]
            E1["Separately encrypted EBS data volume<br/>Kubo blocks and Cluster state"]
            C1 -.->|"Pin management"| K1
            K1 --> E1
            C1 --> E1
        end
        subgraph B["Proposed AZ B - additional operator-supplied EC2"]
            C2["Cluster 2"]
            K2["Kubo 2"]
            E2["Separately encrypted EBS data volume"]
            C2 -.->|"Pin management"| K2
            K2 --> E2
            C2 --> E2
        end
        subgraph C["Proposed AZ C - additional operator-supplied EC2"]
            C3["Cluster 3"]
            K3["Kubo 3"]
            E3["Separately encrypted EBS data volume"]
            C3 -.->|"Pin management"| K3
            K3 --> E3
            C3 --> E3
        end
        C1 -.->|"Cluster control membership - proposed Raft"| C2
        C2 -.->|"Not application metadata CAS"| C3
        C3 -.-> C1
        K1 <-->|"Private swarm - encrypted blocks"| K2
        K2 <-->|"Private swarm - encrypted blocks"| K3
        K3 <--> K1
    end

    subgraph FOUNDATION["CloudFormation foundation - if manually deployed"]
        INDEX["DynamoDB single-Region key-to-CID index<br/>Strong reads and atomic conditional writes<br/>PITR and infrastructure encryption"]
        BACKUP["Private versioned S3<br/>Immutable CID-addressed encrypted backups<br/>SSE-KMS"]
        KMS["Separate infrastructure KMS keys<br/>Not patient or clinician keys"]
        OPTIONAL["CreateNode=false by default<br/>At most ONE optional EC2 and data EBS<br/>Approved prebuilt AMI required"]
    end

    STORE -->|"Private route and authenticated HTTPS"| PROXY
    PROXY -->|"Block put/get"| K1
    PROXY -->|"Pin request and replica observation"| C1
    STORE -->|"Synchronous backup before pointer publication"| BACKUP
    STORE -->|"Read pointer; publish only after pins and backup"| INDEX
    AUTH -.->|"API headers"| STORE
    AUTH -.->|"Operator-injected swarm and Cluster secrets"| C1
    AUTH -.->|"Operator-injected private swarm key"| K1
    KMS -.-> INDEX
    KMS -.-> BACKUP
    KMS -.-> E1
    KMS -.->|"Operator-configured EBS encryption"| E2
    KMS -.->|"Operator-configured EBS encryption"| E3
    OPTIONAL -.->|"Compute only - no cluster bootstrap"| K1
```

- The three nodes/AZs are a **proposal**, not stack-created replicas. The
  [foundation template](../infra/aws/storage-foundation.json) provisions storage
  and at most one optional node. The operator supplies additional peers, private
  routes/SG rules, service endpoints, DNS/TLS/authenticated proxies, approved AMI,
  secret injection, swarm configuration and monitoring. Repeat node-secret
  provisioning for every peer; peer identities must be distinct.
- The app may run on the approved EC2 host or on a local host with reviewed
  private connectivity, API credentials and scoped AWS identity. The current web
  server remains loopback-only; this is **not** an internet-facing app deployment.
  The foundation role trusts EC2; a local/other host needs its own reviewed
  identity. No GitHub credentials belong in runtime secret mounts or configuration.
- Cluster places pins among distinct Kubo peers. Success requires observing at
  least **two** live, distinct Kubo identities reporting pinned content (sample
  maximum: three). This observation is not a continuing durability guarantee.
  Raft, if selected by the operator, concerns Cluster control state/membership,
  **not** the application's CAS; DynamoDB supplies that authority.
- A single EC2/EBS node remains a single point of failure and cannot satisfy the
  remote two-copy policy alone. Even the proposed topology retains ingress,
  metadata, AWS account/IAM and KMS dependencies; automatic API failover is not
  implemented. A private swarm alone does not establish independently governed
  decentralized durability. Operators still see CIDs, sizes, placement and timing.
- KMS adds infrastructure encryption; it never replaces patient/clinician
  factors or receives the reconstructed record key. External secrets contain
  infrastructure/API material, not patient factors or plaintext records.

Implementation: [IPFS provider](../src/storage/adapters/ipfs/provider.ts),
[client](../src/storage/adapters/ipfs/ipfs-cluster-client.ts),
[DynamoDB adapter](../src/storage/adapters/dynamodb/dynamodb-blob-store.ts),
[S3 adapter](../src/storage/adapters/s3/s3-blob-store.ts).
Deployment details: [AWS runbook](AWS_HYBRID_STORAGE.md),
[runtime samples](../infra/aws/runtime), and
[nonsecret configuration](../examples/config/aws-hybrid.env.example).

## Write ordering: replicated content, backup, then index

```mermaid
sequenceDiagram
    participant App as Application crypto and record service
    participant Store as DistributedBlobStore
    participant Wrapper as BackedUpContentStore
    participant Primary as IpfsClusterClient via private HTTPS
    participant S3 as S3 backup
    participant Index as DynamoDB index
    App->>Store: Create or CAS with already-encrypted value
    Note over Store,Index: CAS first checks the current metadata version
    Store->>Wrapper: Put serialized envelope bytes
    Wrapper->>Primary: Put bytes
    Note over Primary: Compute and verify raw CID, upload to Kubo, request Cluster pins
    Note over Primary: Poll pin state and live peers, require at least two distinct Kubo copies
    Primary-->>Wrapper: Verified CID after replication threshold
    Wrapper->>S3: Conditional immutable create with SSE-KMS
    Note over Wrapper,S3: Existing backup is accepted only after byte and CID verification
    S3-->>Wrapper: Backup complete
    Wrapper-->>Store: CID
    Store->>Index: Atomic create or expected-version CAS of key-to-CID pointer
    Index-->>Store: Published version
    Store-->>App: Success
```

No pointer publication occurs if replication or backup fails. A lost CAS can
leave unreachable blocks/backups; no automatic unpin/delete occurs. A timeout
can have an ambiguous outcome, so reconcile before retrying. This is ordered
publication, not a transaction spanning IPFS, S3 and DynamoDB.
Sources: [distributed store](../src/storage/adapters/ipfs/distributed-blob-store.ts)
and [backup wrapper](../src/storage/adapters/ipfs/backed-up-content-store.ts).

## Explicit restore: never an invisible read fallback

```mermaid
sequenceDiagram
    participant Operator as Operator
    participant Store as DistributedBlobStore
    participant Index as DynamoDB index
    participant Wrapper as BackedUpContentStore
    participant S3 as S3 backup
    participant Primary as Private Kubo and Cluster via client
    Operator->>Store: Restore opaque object key
    Store->>Index: Strong read of current pointer
    Index-->>Store: CID and version
    Store->>Wrapper: Restore CID
    Wrapper->>S3: Read immutable backup
    S3-->>Wrapper: Encrypted bytes and CID envelope
    Note over Wrapper: Validate format, version, bytes and matching CID
    Wrapper->>Primary: Republish bytes and repin
    Primary-->>Wrapper: Same CID after replica threshold
    Wrapper-->>Store: Verified restored CID
    Store-->>Operator: Complete, metadata unchanged
```

Ordinary reads use the index and primary Kubo bytes with CID verification;
primary failure is surfaced, not silently replaced with S3. Restore the metadata
index separately first if it is lost. Concurrent pointer changes can require
another recovery pass; content restore cannot recover lost factors or establish
snapshot freshness. See [recovery guidance](AWS_HYBRID_STORAGE.md).

## Local default: no IPFS, Docker or cloud required

With dependencies installed and no backend override, `npm start` runs this path:

```mermaid
flowchart LR
    UI["Browser UI<br/>http://127.0.0.1:3000"]
    API["Localhost-only API<br/>Patient factor AND clinician private key"]
    SERVICE["Record service<br/>Application encryption and verification"]
    FILE["FileBlobStore<br/>.data/web<br/>Encrypted records; single process"]
    UI --> API
    API --> SERVICE
    SERVICE --> FILE
```

This is a single-host demonstration, not a distributed durability test. Existing
`.data/web` data is not automatically migrated when another backend is selected.
Sources: [web server](../src/web/server.ts) and
[file provider](../src/storage/adapters/file/provider.ts).

## Optional local private-IPFS integration fixture

`npm run test:integration:ipfs` is a **separate native Linux Docker** test path,
not part of `npm start`. Docker Desktop and remote Docker daemons are unsupported.

```mermaid
flowchart TB
    subgraph HOST["One native Linux host - synthetic integration only; no AWS"]
        RUN["Integration runner and record-service tests<br/>DistributedBlobStore and backup wrapper"]
        FILES["Temporary local FileBlobStore<br/>Metadata pointers and encrypted backups"]
        RELAYS["Runner-owned TCP API relays<br/>127.0.0.1 dynamic ports only"]
        subgraph NET["Docker internal bridge - six containers"]
            C1["Cluster 1"] -.->|"Pin control"| K1["Kubo 1"]
            C2["Cluster 2"] -.->|"Pin control"| K2["Kubo 2"]
            C3["Cluster 3"] -.->|"Pin control"| K3["Kubo 3"]
            C1 -.->|"Raft control membership"| C2
            C2 -.-> C3
            C3 -.-> C1
            K1 <-->|"Private swarm"| K2
            K2 <--> K3
            K3 <--> K1
            VOLUMES["Per-node Docker data volumes<br/>Separate restricted swarm and Cluster secret volume"]
            K1 --> VOLUMES
            K2 --> VOLUMES
            K3 --> VOLUMES
        end
        RUN --> FILES
        RUN -->|"Explicit loopback HTTP emulator mode"| RELAYS
        RELAYS -->|"Suite ingress"| K1
        RELAYS -->|"Suite pin API"| C1
        RELAYS -->|"Probe and readiness APIs on other peers"| K2
        RELAYS --> K3
        RELAYS --> C2
        RELAYS --> C3
    end
```

The runner owns six API relays; no Docker host ports, public gateways or swarm
ports are published. APIs are unauthenticated for an isolated development host,
not safe for a shared untrusted machine. Only image pulls need internet access;
the running fixture stays on its internal bridge. Metadata/backups use temporary
local files, never AWS. Cluster state also persists in per-node Docker volumes.

The suite exercises synthetic records and CID-verified restore. A separate
node-loss probe first confirms a synthetic block on **all three** Kubo peers,
then stops Kubo 1/Cluster 1 and checks the same bytes through Kubo 2. This is not
automatic ingress failover or proof of host/region failure tolerance: all peers,
metadata and backups still share one host. See the
[fixture contract](../test/fixtures/ipfs/README.md) and
[runner](../scripts/run-ipfs-integration.ts).

## Azure: To be decided

The Azure adapter does not select an Azure deployment architecture. Hosting,
networking, identity, metadata placement and recovery topology are intentionally
undefined here; no cross-cloud mirroring is implied.
