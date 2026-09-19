# AWS hybrid storage foundation

**Global Patient Record Project — synthetic-only research POC.** This is not
clinical, regulatory, production, disaster-recovery, or ten-year-service
certification. No AWS account, credentials, live deployment, or cloud validation
was used to implement this sample. Review the draft before changing settings.
Nothing here creates a GitHub deployment workflow or stores secrets in GitHub.

## What is implemented

`infra/aws/storage-foundation.json` is a manually deployable CloudFormation
foundation, with `CreateNode=false` by default:

```text
unchanged dual-unlock application cryptography
    -> authenticated ciphertext
    -> private Kubo / IPFS Cluster -> optional EC2 -> encrypted EBS
    -> opaque lookup / CAS metadata -> DynamoDB (customer-managed SSE-KMS)
    -> encrypted content backup -> private versioned S3 (SSE-KMS)
```

The optional node uses an **operator-reviewed, prebuilt AMI**. CloudFormation
does not install Kubo, initialize a repository, format a disk, distribute a swarm
key, create TLS endpoints, join peers, or establish a working private cluster.
The service files under `infra/aws/runtime` are hardening examples for that AMI,
not unattended bootstrap installers. No executable is downloaded by this stack.
The AMI/runtime acceptance checklist below is a deployment prerequisite.

| Resource | Implemented boundary |
| --- | --- |
| DynamoDB | One string partition key `key`, on-demand billing, PITR, deletion protection, separate rotating KMS key; no TTL/index/scan permission |
| S3 | All public access blocked, ACLs disabled, versioning, separate rotating KMS key, TLS-only policy, explicit correct SSE-KMS headers required |
| Retention | Table, bucket, bucket policy, keys and separate data EBS retained on stack deletion/replacement; **no completed-object/version expiry** |
| EC2, opt-in | Private subnet, explicit no public IPv4, no SSH key or SSH ingress, IMDSv2 required, metadata hop limit 1 |
| EBS | Encrypted gp3 root and separate encrypted data volume; only data volume has resource-level Retain policies |
| Networking | Only HTTPS from supplied client SG; egress HTTPS only to endpoint SG and regional S3/DynamoDB prefix lists |
| Instance role | EC2 trust; GetItem/PutItem on one table; GetObject/PutObject on `records/*`; ListBucket on this dedicated backup bucket; service/context-scoped KMS use; optional exact-ARN external bootstrap/API secrets |

These resource properties follow the AWS references [1–8]. Retain is not a
backup or an IAM delete denial: retained resources still cost money and leave
CloudFormation management when removed from a stack [8]. Root volume deletion
is intentional; **all durable Kubo/Cluster state must be on `/srv/ipfs`**.
The sole S3 lifecycle action aborts incomplete multipart uploads after seven
days; it does not expire completed objects [6]. Versioning is not Object Lock:
an administrator can still delete versions or weaken the policy. WORM/Object
Lock, AWS Backup vault policies and legal retention requirements need separate
review; no retention-law claim is made here.

### Encryption and disclosure are separate issues

KMS keys in this stack protect AWS infrastructure **at rest**. They are not
`patientDataKey`, a patient factor, a clinician private key, or a replacement
for dual unlock. Keep the existing authenticated ciphertext, signatures and
authorization checks unchanged. The application role cannot export raw KMS key
material; its KMS data operations are limited to service-mediated use. The
table-creation role, not the application, authorizes DynamoDB maintenance
grants [9]. S3 SSE-KMS protects already-encrypted content [7].

AWS and authorized operators can still observe object identifiers, CIDs, sizes,
versions, item access patterns, network relationships, timestamps and key-use
metadata. A CID is **not an access-control secret**. Do not put names,
demographics, biometric material, plaintext FHIR, or patient factors into table
keys, bucket keys, tags, secret names, logs, endpoint hostnames, or stack
parameters. Do not run a public IPFS gateway or publish private CIDs.

## Before an account-enabled deployment

1. Obtain an approved account/Region, budget and named operational custodians.
   Separate deployment, runtime, recovery and key-administration duties.
   Establish MFA-backed operator sessions and an approved short-lived AWS
   credential source on the operator workstation. Never commit access keys.
2. Review the JSON, policy tests, current AWS documentation and a change set.
   Re-check service availability and IAM in the chosen partition/Region.
   The example is a single-Region design, not a global-table/replication setup.
3. For `CreateNode=true`, provide an existing VPC and **private IPv4 subnet**.
   Verify the subnet belongs to the VPC and its AZ equals `AvailabilityZone`.
   Reject IPv6 autoassignment/public routing in this foundation. Supply
   existing client and endpoint SGs in the same VPC. The template checks for
   required nonempty parameters, not actual topology or SG membership.
4. Install regional **S3 and DynamoDB gateway endpoints** on the subnet route
   table. Supply their correct AWS-managed prefix-list IDs. Constrain endpoint
   policies to the output bucket/table and intended roles. Create a
   Secrets Manager interface endpoint with private DNS when fetching secrets.
   Its SG must allow inbound TCP 443 from the output node SG. DNS resolution,
   VPC DNS settings, NACLs and endpoint routing must work. S3/DynamoDB invoke KMS
   server-side; these operations do not require a node KMS endpoint. Add one
   only if separately approved management/runtime components call KMS.
5. The node has **no internet/NAT egress and no peer traffic rules**. Prebake
   dependencies, certificates/trust roots and binaries. Add separately reviewed
   SG-to-SG/private-overlay rules for chosen Kubo and Cluster peer transports
   before joining other nodes. Never replace the rules with `0.0.0.0/0`,
   `::/0`, public RPC, or unrestricted TCP/UDP. Default ports to investigate
   are Kubo swarm 4001 and Cluster peer RPC 9096; pin the actual transports in
   the reviewed runtime, and do not expose Kubo 5001, gateway 8080, Cluster
   REST 9094 or proxy 9095 remotely [10–11].
6. The role deliberately has **no SSM session, shell, ECR, CloudWatch logs,
   snapshot, object-delete or IAM permissions**. If management
   uses SSM, separately review required instance/session IAM permissions,
   endpoint SGs and `ssm`/`ssmmessages` endpoints for the selected Region and
   agent. Do not assume Session Manager works from this template alone.
   Keep remote command/session output from capturing secrets or CIDs.
7. Supply an approved x86_64 AMI with a root mapping matching `RootDeviceName`,
   no extra AMI data volumes, and root size no greater than the template's
   32 GiB. Record the AMI owner, immutable ID, source build, pinned binary
   versions/digests, provenance and patch review. Do not clone private node
   identities or bake secret values into the image.

### IAM and key-policy review

The operator needs permission to create/describe/execute the designated
CloudFormation change set and `iam:PassRole` on the designated deployment
execution role, with `iam:PassedToService=cloudformation.amazonaws.com`.
That execution role trusts **`cloudformation.amazonaws.com`**, not GitHub and
not arbitrary AWS accounts. Prefer a dedicated review/deploy path; do not grant
runtime credentials to CloudFormation.

The execution role needs resource-management permissions for the resource
types in this template: DynamoDB table/PITR settings; S3 bucket, encryption,
versioning, public-access, ownership, lifecycle and policy settings; KMS keys;
IAM role/inline policy/instance-profile creation; and, when enabled, EC2
launch templates, instances, volumes/attachments and security groups.
Scope to the selected account/Region, stack resources/naming and supported
request tags. Account for rollback/update permissions and AWS actions which
require `Resource: "*"`; do not copy the runtime policy as a deployment policy.
For node launch, restrict `iam:PassRole` to the generated node role and
`iam:PassedToService=ec2.amazonaws.com`.

KMS policies use AWS's standard account-root **IAM delegation** statement [12].
`Resource: "*"` in each key policy means that key, not every account key.
This is deliberately not a wildcard public principal, but account administrators
can delegate broad access: audit IAM and consider SCPs/permissions boundaries.
The execution role must be allowed to create/manage keys and authorize service
use on the new key ARNs. For the DynamoDB key, table creation requires
`kms:Encrypt`, `kms:Decrypt`, `kms:ReEncrypt*`, `kms:GenerateDataKey*`,
`kms:DescribeKey` and `kms:CreateGrant` through DynamoDB [9].
For EBS launch/attachment, authorize the needed key cryptographic/describe
operations and `kms:CreateGrant` for EC2, with
`kms:GrantIsForAWSResource=true` for the grant statement [13].
Do not give these provisioning/grant permissions to the application.
Keep service `kms:ViaService` conditions on service-mediated operations, not
on unrelated KMS administration calls. This stack does not configure global
tables; revisit the documented cross-Region ViaService requirements before
adding them [9].

`NodeRole` always exists, even with compute disabled, and trusts EC2 only.
The default runtime placement is a host process on the approved instance.
Containers must not evade the IMDS hop limit: use a separately reviewed
credential-delivery design if running the application in containers.
For another compute service, create an independently reviewed workload role
with equivalent narrowly scoped permissions and the correct service/OIDC
trust; do not broaden this node trust or use permanent keys.

`s3:ListBucket` is scoped to the **single dedicated backup bucket ARN**, not all
buckets. S3 needs bucket-list authorization to distinguish a nonexistent
GetObject key (404) from access denied (403) [17]. The adapter must not treat
403 as a missing object. This grant also permits enumerating that bucket's
object names, so do not mix other datasets into the bucket. Object read/write
and KMS use remain scoped to `records/*`; version enumeration and deletion
remain recovery-only. No `s3:prefix` request condition is applied to this
missing-key grant: GetObject is not a ListObjects request carrying a prefix.
Validate the missing-key/error contract with the actual role and endpoint
policies before enabling the application.

### External secrets: identifiers in configuration, values outside GitHub

Create secrets separately using an approved secrets-management workflow.
Optionally provide `RuntimeSecretArn` **and** `RuntimeSecretKmsKeyArn`; they
must name an existing secret and customer-managed key in this account/Region.
The external key policy must delegate decrypt to the generated node role.
The optional policy only permits reading this single ARN, with KMS decrypt
through Secrets Manager and matching `SecretARN` encryption context [14].
Do not send secret values to a CloudFormation parameter, dynamic reference,
UserData, command line, shell history, console, GitHub variable or GitHub secret.

The approved AMI must contain a tested secret-mounting agent, running with its
instance role. For example, an **operator-defined JSON secret contract** can
provide private swarm material, Cluster secret and two authorization headers.
This repository does not implement that host agent or prescribe its JSON schema:
review it with the AMI, and fail closed if values are absent/invalid. The agent
must retrieve directly into memory, atomically write restricted files in a
memory-backed `/run/global-patient-record-secrets`, and never print a response
or log secret-bearing errors. Require root ownership, restrictive directories
and mode 0400/0440 with the minimal service group; prohibit symlink substitution.
Disable swap or use separately reviewed encrypted swap, and disable core dumps.
Rotation must atomically replace credentials and restart/reload the consumers;
test unauthorized/expired credentials and rollback without revealing values.

Mount authorization header values as single-line files:

```text
IPFS_API_AUTH_FILE=/run/global-patient-record-secrets/kubo-authorization
IPFS_CLUSTER_AUTH_FILE=/run/global-patient-record-secrets/cluster-authorization
```

These are supported runtime settings; do not put the actual header in the
environment. For direct application retrieval instead, use the alternative
`infra/aws/runtime/direct-api-auth.env.example` fragment and **remove** the two
`*_FILE` settings. Configure:

```text
IPFS_API_AUTH_AWS_SECRET_ID=<ApiAuthorizationSecretArn parameter value>
IPFS_CLUSTER_AUTH_AWS_SECRET_ID=<ClusterAuthorizationSecretArn parameter value>
AWS_REGION=<AwsRegion output>
```

Each referenced `SecretString` must hold the **complete single-line
Authorization header**, not JSON or only a bare token. The application uses
the AWS SDK default role/credential chain; no access-key environment variables
are needed on the approved EC2 host. Do not configure file, Key Vault and
Secrets Manager sources simultaneously for the same setting.

Supply the corresponding optional CloudFormation parameters
`ApiAuthorizationSecretArn` and `ClusterAuthorizationSecretArn`. Each enables
only `secretsmanager:GetSecretValue` for that exact ARN. If either secret uses a
customer-managed key, also supply its
`ApiAuthorizationSecretKmsKeyArn` or `ClusterAuthorizationSecretKmsKeyArn`:
these grant decrypt on the designated key only through Secrets Manager with
the matching secret encryption context. Leave the key parameter empty only
when using the AWS-managed Secrets Manager key. Each external customer key's
policy must authorize the node role. All referenced secrets must exist in the
selected account/Region, and direct retrieval requires the Secrets Manager
endpoint connectivity described above. The two header-secret permissions are
separate from `RuntimeSecretArn`, which can still serve the approved host
bootstrap/mount agent. No secret is created or secret value accepted by this
template.

Kubo's swarm file and Cluster's service configuration contain infrastructure
secrets and must also be mounted/provisioned privately. Patient factors and
clinician private keys remain outside this infrastructure-secret bundle.

## Manual review, validation and deployment

Offline check, from the repository root, requires only existing dependencies:

```powershell
npm test -- test/infrastructure/aws.spec.ts
```

This parses JSON and checks selected policy/security invariants. It is **not**
CloudFormation schema validation, IAM simulation, AMI verification, a private
cluster join test, or evidence that AWS accepted/deployed the stack.

Only after review and account provisioning, run the following yourself.
Use your approved Region/profile; authenticate without storing credentials in
the repository. In these PowerShell examples, replace all uppercase identifiers.

```powershell
aws cloudformation validate-template `
  --template-body file://infra\aws\storage-foundation.json `
  --region REVIEWED_REGION --profile REVIEWED_PROFILE

aws cloudformation create-change-set `
  --stack-name global-patient-record-research `
  --change-set-name reviewed-foundation --change-set-type CREATE `
  --template-body file://infra\aws\storage-foundation.json `
  --capabilities CAPABILITY_IAM `
  --role-arn REVIEWED_CLOUDFORMATION_EXECUTION_ROLE_ARN `
  --parameters ParameterKey=CreateNode,ParameterValue=false `
  --region REVIEWED_REGION --profile REVIEWED_PROFILE

aws cloudformation wait change-set-create-complete `
  --stack-name global-patient-record-research --change-set-name reviewed-foundation `
  --region REVIEWED_REGION --profile REVIEWED_PROFILE

aws cloudformation describe-change-set `
  --stack-name global-patient-record-research --change-set-name reviewed-foundation `
  --region REVIEWED_REGION --profile REVIEWED_PROFILE
```

Stop here for human approval. Check generated IAM, deletion/replacement impacts,
retained-resource billing, key ownership and rollback. After approval:

```powershell
aws cloudformation execute-change-set `
  --stack-name global-patient-record-research --change-set-name reviewed-foundation `
  --region REVIEWED_REGION --profile REVIEWED_PROFILE

aws cloudformation wait stack-create-complete `
  --stack-name global-patient-record-research `
  --region REVIEWED_REGION --profile REVIEWED_PROFILE

aws cloudformation describe-stacks --stack-name global-patient-record-research `
  --query "Stacks[0].Outputs" --region REVIEWED_REGION --profile REVIEWED_PROFILE
```

This creates the storage foundation and role, **not a runnable IPFS deployment**.
Outputs contain only identifiers/nonsecret settings; still avoid publishing
infrastructure inventory. For the optional node, create a second `UPDATE`
change set, with the same template/role/capability, and explicitly supply:

```text
CreateNode=true
VpcId=<existing VPC>
PrivateSubnetId=<reviewed private subnet>
AvailabilityZone=<that subnet's AZ>
ApprovedAmiId=<reviewed immutable AMI>
RootDeviceName=<AMI root device>
ClientSecurityGroupId=<private authenticated-client SG>
EndpointSecurityGroupId=<private AWS interface-endpoint SG>
S3PrefixListId=<regional managed prefix list>
DynamoDbPrefixListId=<regional managed prefix list>
RuntimeSecretArn=<optional existing external secret ARN>
RuntimeSecretKmsKeyArn=<optional existing key ARN, required with secret ARN>
ApiAuthorizationSecretArn=<optional direct Kubo header secret ARN>
ApiAuthorizationSecretKmsKeyArn=<its customer key ARN, if used>
ClusterAuthorizationSecretArn=<optional direct Cluster header secret ARN>
ClusterAuthorizationSecretKmsKeyArn=<its customer key ARN, if used>
```

Use `--parameters ParameterKey=NAME,ParameterValue=VALUE ...` for these nonsecret
identifiers. Review and execute as above, using `stack-update-complete` instead
of `stack-create-complete`. Approve replacement separately: retained EBS does
**not** mean a replacement node automatically remounts/rejoins safely.

### Approved AMI/runtime acceptance checklist

* The host agent waits for the **output `DataVolumeId`** attachment, resolves
  that exact EBS ID to its device, and rejects the root disk or an unexpected
  serial/volume. Nitro device names need not match `/dev/sdf` [15].
  Use EBS NVMe identification/serial tools and confirm with the EC2 attachment
  inventory. **Never format “the next disk”, `/dev/nvme1n1`, or `/dev/sdf`
  based only on a guessed device name.**
* No sample automatically formats storage. An authorized operator may initialize
  only a positively identified, new, empty volume after checking existing
  signatures/partitions and mount use. A recovered/retained volume is never
  reformatted. Mount a reviewed filesystem by UUID at `/srv/ipfs` with
  nodev/nosuid restrictions, appropriate ownership and a fail-closed mount unit.
  Verify the mount after reboot. Snapshot/quiesce before changing it.
* Generate unique node identities at first provisioning, not at AMI build.
  Initialize pinned-version Kubo and Cluster configurations on the data volume
  through the approved provisioning workflow. The provided units do not
  initialize defaults. A missing mount/config/swarm key prevents startup.
* Set Kubo API to loopback, disable its gateway, remove public bootstrap peers,
  restrict discovery/routing/announcements to the private network and enforce
  the shared private-swarm key. `LIBP2P_FORCE_PNET=1` is also set in the sample
  unit. Configure peer addresses to the private routed/overlay network only.
  Inspect the actual effective configuration for the exact baked version [10].
* Configure Cluster REST/IPFS proxy as loopback-only (or disable unused proxy),
  private peer membership, a nonempty separate Cluster secret and reviewed
  consensus/trust/replication settings. Keep `service.json`, `identity.json`,
  Kubo identity and swarm material private. Cluster configuration may include
  secrets and node identities; do not paste it into an issue or logs [11].
* Put an operator-managed **authenticated HTTPS reverse proxy** on private port
  443, with distinct private DNS names for Kubo and Cluster. It must validate
  authorization, use trusted TLS, limit application RPC routes/methods, sizes and
  timeouts, and never log request bodies, authorization headers or CID-bearing
  URLs. No public load balancer or gateway. Auth failures must not reach RPC.
* Install the example units only after inspecting their paths against the AMI.
  Secrets must exist before services start, with restart/rotation ordering
  managed by the approved host agent. Keep swap/core/log disclosure controls.
  Their stdout/stderr are suppressed deliberately; add only reviewed,
  non-identifying health metrics, not unfiltered application/node logs.
* Verify unauthorized HTTPS requests fail, trusted clients authenticate,
  plaintext/TLS-bypass and raw ports cannot be reached, IMDSv1 fails, node
  secrets are unreadable by other users, and an unrelated IAM principal cannot
  access data/keys. Test these **in the account**; offline tests cannot.

### Application configuration

Use `examples/config/aws-hybrid.env.example` for the application quickstart or
copy `infra/aws/runtime/app.env.example` into your separately managed deployment
configuration, substituting these output values:

| Setting | Output |
| --- | --- |
| `STORAGE_BACKEND` | `StorageBackend` (`ipfs`) |
| `IPFS_METADATA_BACKEND` | `IpfsMetadataBackend` (`dynamodb`) |
| `DYNAMODB_TABLE` | `DynamoDbTable` |
| `AWS_REGION` | `AwsRegion` |
| `IPFS_BACKUP_BACKEND` | `IpfsBackupBackend` (`s3`) |
| `S3_BUCKET` | `S3Bucket` |
| `S3_KMS_KEY_ID` | `S3KmsKeyId` (full key ARN) |
| `STORAGE_PREFIX` | `StoragePrefix` (`records/`) |
| `IPFS_PRIVATE_NETWORK` | `IpfsPrivateNetwork` (`true`) |

Also provide actual HTTPS `IPFS_API_URL`, `IPFS_CLUSTER_API_URL` and the mounted
authorization-file paths. Do not use the `.invalid` example hostnames as actual
endpoints. Keep `STORAGE_PREFIX=records/` unless the corresponding IAM and KMS
encryption-context scopes are changed in a reviewed change set. Bucket keys
are disabled because the KMS context policy deliberately scopes to object ARNs.
Send explicit SSE-KMS/key-ARN headers: bucket defaults alone do not satisfy
the upload policy.

**The application requires at least two IPFS replicas outside emulator mode.**
The single optional EC2 instance is only one node; it cannot by itself satisfy
the example `IPFS_REPLICATION_MIN=2`, `IPFS_REPLICATION_MAX=3`. Provision
additional independently persisted peers and approve private peer connectivity
before enabling writes. Do not use emulator mode or weaken replica checks to
make this one-node foundation appear highly available.

## Backup, recovery and operation

There is no atomic transaction spanning Cluster, S3 and DynamoDB. Treat failed
writes and partially completed operations as reconciliation work. The
application's provider-neutral `BackedUpContentStore` writes its configured
backup synchronously as part of a successful content write; it copies
authenticated ciphertext, not plaintext. `IPFS_BACKUP_BACKEND=s3` requires
`S3_KMS_KEY_ID` outside emulator mode. The wrapper uses the `BlobStore`
interface, not S3 SDK calls in the service or crypto layers.
It does not schedule DynamoDB/EBS backups, export a recovery catalog, replicate
accounts, or recover patient factors for you. Track and alarm on failures
without placing record identifiers or CIDs into general-purpose logs.

1. **Establish a recovery baseline.** After account validation, exercise a
   synthetic write/read/CAS, confirm required replicas and S3 encrypted versions,
   and record an access-controlled inventory relating opaque metadata keys,
   CIDs/content hashes and S3 object/version IDs. Do not infer that a versioned
   content bucket backs up the metadata table.
2. **Metadata protection.** Verify PITR enabled and a usable recovery window.
   DynamoDB PITR is a rolling window of up to 35 days, not archival ten-year
   retention [16]. Schedule separately reviewed on-demand/AWS Backup copies
   with appropriate retention and custodian/account separation. Preserve key
   availability for tables **and historical backups**. Schedule protected
   EBS snapshots and Cluster state backups as well; this stack has no schedule.
3. **Choose a consistent cut.** Quiesce writes or establish a verified recovery
   point/catalog. Choose the metadata time and ensure all referenced encrypted
   objects/versions exist. An S3 content backup alone cannot reconstruct lost
   identifier-to-CID mappings or CAS heads. A metadata-only PITR restore can
   refer to objects that require corresponding version/block recovery.
4. **Restore metadata into a new table** with an isolated recovery role, not
   the runtime role. Inspect the latest/earliest restorable times, then use:

   ```powershell
   aws dynamodb restore-table-to-point-in-time `
     --source-table-name SOURCE_TABLE --target-table-name RECOVERY_TABLE `
     --restore-date-time REVIEWED_UTC_TIMESTAMP `
     --region REVIEWED_REGION --profile REVIEWED_RECOVERY_PROFILE
   ```

   Wait for ACTIVE, verify encryption/key access, re-enable PITR and deletion
   protection on the restored table, and reapply IAM, tags, endpoint policies,
   alarms and backup schedules as necessary [16]. The app role is scoped to
   the original table: explicitly review the new table ARN and KMS context in
   its policy before cutover. Do not silently change only `DYNAMODB_TABLE`.
5. **Restore blocks/ciphertext and pins.** If the retained volume is healthy,
   attach it only to an approved replacement in the **same AZ**, with services
   stopped; mount without formatting. For another AZ, restore a reviewed EBS
   snapshot into that AZ or repopulate content on new disks [3,15]. For S3
   recovery, an isolated recovery role may need ListBucketVersions and
   GetObjectVersion on the exact bucket/prefix plus decrypt on the historical
   key. Those extra permissions are intentionally absent from the node role.
   Resolve delete markers/older versions under review; the normal adapter
   reads current versions, not arbitrary historical version IDs.
6. **Verify before publication.** Restore the exact encrypted content and
   compare its content hash/CID, re-add/re-pin through the private endpoints,
   and confirm the required replica count. Use the repository's
   explicit operator command:

   ```powershell
   npm run storage:restore -- OPAQUE_OBJECT_KEY
   ```

   Run with the reviewed runtime configuration and role/secret access.
   `DistributedBlobStore.restore(opaqueObjectKey)` resolves the existing
   metadata reference and repairs from encrypted backup, verifies the CID and
   pin completion, and **does not change the metadata index**. It cannot recover
   a lost index; restore metadata first. Do not treat a successful S3 GET as a
   verified cluster recovery. Preserve node identities
   appropriately, avoiding a live duplicate identity. Independently verify
   restored metadata, version/CAS heads, signatures and parent links with
   synthetic test records before approving traffic/cutover.
7. **Drill and reconcile.** Test loss of a node/AZ, inaccessible KMS keys,
   unavailable S3/DynamoDB, wrong secret/TLS credentials, missing blocks and a
   metadata rollback. Document measured RPO/RTO and repair gaps. Retain source
   volumes/tables and key access until restored data has been verified and a
   deliberate cleanup is approved. Do not blindly toggle `CreateNode` off/on:
   retained disks/keys may become unmanaged and new resources are not a restore.

The default runtime role cannot enumerate the table, delete backups, perform
PITR restore or disable keys. Recovery custodians need a separately approved
role with precisely those operations required for the chosen drill, bounded
to source/destination resources and old/new keys. Root/admin permissions are
not a routine recovery plan.

### Resilience limits and long-term posture

One EC2 plus one AZ-pinned EBS volume remains a single point of failure.
Additional peers need independent volumes, availability zones, monitored pin
health, reviewed quorum/replication and independent custodians. For meaningful
provider/account independence, maintain tested encrypted copies and metadata
exports with independent operators, plus a separate application-key custody
and recovery plan. Do not export clinical plaintext to accomplish this.

This AWS foundation is **not fully decentralized**: it depends on the account,
Region, IAM, KMS, DynamoDB and S3 remaining available and authorized. Multiple
AZs do not remove the account/KMS dependency. Key deletion or account closure
can make retained ciphertext inaccessible; rotation is not a key-deletion
plan [7,9,12]. AWS retention flags do not promise ten years of service.
Fund ongoing storage/egress/operations, patch pinned software through review,
renew certificates, rotate secrets, monitor drift and billing, designate
successor custodians, and repeat recovery/migration drills for the desired
retention horizon. Review crypto agility and migration before obsolete
software/algorithms or organizational changes make recovery impractical.

## Official references

Reviewed September 19, 2026; re-check before a live deployment. These references
describe service behavior, not successful validation of this sample.

1. EC2 launch templates and IMDS properties:
   `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-ec2-launchtemplate-metadataoptions.html`
2. EC2 root EBS mapping:
   `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-ec2-launchtemplate-ebs.html`
3. Separate EC2 volume resource and AZ:
   `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ec2-volume.html`
4. DynamoDB table properties:
   `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-dynamodb-table.html`
5. S3 bucket properties:
   `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-s3-bucket.html`
6. S3 lifecycle behavior:
   `https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html`
7. S3 SSE-KMS:
   `https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html`
8. CloudFormation Retain:
   `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html`
9. DynamoDB KMS permissions, grants and contexts:
   `https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/encryption.usagenotes.html`
10. Kubo configuration (validate against the exact reviewed release):
    `https://github.com/ipfs/kubo/blob/master/docs/config.md`
11. Cluster configuration, identities, secrets, replication and ports:
    `https://ipfscluster.io/documentation/reference/configuration/`
12. KMS default key policy/account delegation:
    `https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html`
13. EBS KMS requirements:
    `https://docs.aws.amazon.com/ebs/latest/userguide/ebs-encryption-requirements.html`
14. Secrets Manager KMS encryption:
    `https://docs.aws.amazon.com/secretsmanager/latest/userguide/security-encryption.html`
15. EBS NVMe device identification:
    `https://docs.aws.amazon.com/ebs/latest/userguide/identify-nvme-ebs-device.html`
16. DynamoDB PITR:
    `https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery_Howitworks.html`
17. S3 GetObject missing-key permission behavior:
    `https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html`
