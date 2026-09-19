import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const templateUrl = new URL("../../infra/aws/storage-foundation.json", import.meta.url);
const raw = readFileSync(templateUrl, "utf8");
// This is a local policy regression check, not the CloudFormation service/schema validator.
const template = JSON.parse(raw);
const resources = template.Resources;
const launch = resources.NodeLaunchTemplate.Properties.LaunchTemplateData;
const statements = resources.NodeRole.Properties.Policies[0].PolicyDocument.Statement;
const policy = (sid: string) => statements.find((item: { Sid?: string }) => item.Sid === sid);
const bucketStatements = resources.BackupBucketPolicy.Properties.PolicyDocument.Statement;

describe("review-only AWS hybrid storage foundation", () => {
  it("parses offline and defaults to no compute or bootstrap", () => {
    expect(template.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(template.Parameters.CreateNode.Default).toBe("false");
    expect(template.Conditions.NodeEnabled).toEqual({
      "Fn::Equals": [{ Ref: "CreateNode" }, "true"],
    });
    for (const name of [
      "Node", "NodeLaunchTemplate", "NodeProfile", "NodeSecurityGroup",
      "DataVolume", "DataVolumeAttachment", "VolumeKey",
    ]) {
      expect(resources[name].Condition).toBe("NodeEnabled");
    }
    expect(raw).not.toMatch(/"UserData"|"KeyName"|"AWS::IAM::AccessKey"/);
    expect(launch.ImageId).toEqual({ Ref: "ApprovedAmiId" });
    expect(template.Parameters.ApprovedAmiId.Default).toBe("");
    expect(template.Rules.NodePrerequisites.Assertions[0].Assert["Fn::And"]).toHaveLength(8);
  });

  it("requires IMDSv2, no public IP and no IPv6 metadata", () => {
    expect(launch.MetadataOptions).toEqual({
      HttpEndpoint: "enabled",
      HttpTokens: "required",
      HttpPutResponseHopLimit: 1,
      HttpProtocolIpv6: "disabled",
      InstanceMetadataTags: "disabled",
    });
    expect(launch.NetworkInterfaces).toEqual([{
      DeviceIndex: 0,
      AssociatePublicIpAddress: false,
      DeleteOnTermination: true,
      SubnetId: { Ref: "PrivateSubnetId" },
      Groups: [{ Ref: "NodeSecurityGroup" }],
    }]);
    expect(raw).not.toMatch(/AWS::EC2::EIP|"Ipv6AddressCount"|"Ipv6Addresses"/);
  });

  it("only exposes HTTPS to an existing private client SG", () => {
    const sg = resources.NodeSecurityGroup.Properties;
    expect(sg.SecurityGroupIngress).toEqual([{
      IpProtocol: "tcp", FromPort: 443, ToPort: 443,
      SourceSecurityGroupId: { Ref: "ClientSecurityGroupId" },
    }]);
    expect(sg.SecurityGroupEgress).toHaveLength(3);
    for (const rule of sg.SecurityGroupEgress) {
      expect(rule.IpProtocol).toBe("tcp");
      expect(rule.FromPort).toBe(443);
      expect(rule.ToPort).toBe(443);
      expect(rule.CidrIp).toBeUndefined();
      expect(rule.CidrIpv6).toBeUndefined();
      expect(rule.DestinationSecurityGroupId ?? rule.DestinationPrefixListId).toBeDefined();
    }
    expect(raw).not.toMatch(/0\.0\.0\.0\/0|::\/0/);
  });

  it("encrypts root and separately retained data volumes with the EBS key", () => {
    const root = launch.BlockDeviceMappings[0].Ebs;
    expect(root.Encrypted).toBe(true);
    expect(root.KmsKeyId).toEqual({ "Fn::GetAtt": ["VolumeKey", "Arn"] });
    expect(root.VolumeType).toBe("gp3");
    expect(root).not.toHaveProperty("DeletionPolicy");
    expect(root).not.toHaveProperty("UpdateReplacePolicy");
    const volume = resources.DataVolume;
    expect(volume.Type).toBe("AWS::EC2::Volume");
    expect(volume.Properties.Encrypted).toBe(true);
    expect(volume.Properties.KmsKeyId).toEqual(root.KmsKeyId);
    expect(volume.Properties.AvailabilityZone).toEqual(resources.Node.Properties.AvailabilityZone);
    expect(resources.DataVolumeAttachment.Properties.VolumeId).toEqual({ Ref: "DataVolume" });
  });

  it("retains data and key resources on deletion and replacement", () => {
    for (const name of [
      "BackupKey", "MetadataKey", "VolumeKey", "BackupBucket",
      "BackupBucketPolicy", "MetadataTable", "DataVolume",
    ]) {
      expect(resources[name].DeletionPolicy).toBe("Retain");
      expect(resources[name].UpdateReplacePolicy).toBe("Retain");
    }
    for (const name of ["BackupKey", "MetadataKey", "VolumeKey"]) {
      expect(resources[name].Properties.EnableKeyRotation).toBe(true);
      expect(resources[name].Properties.PendingWindowInDays).toBe(30);
      expect(resources[name].Properties.KeyPolicy.Statement).toEqual([{
        Sid: "AccountDelegatesThroughIAM",
        Effect: "Allow",
        Principal: { AWS: { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:root" } },
        Action: "kms:*",
        Resource: "*",
      }]);
    }
  });

  it("provides the adapter's string key table with PITR and deletion protection", () => {
    const table = resources.MetadataTable.Properties;
    expect(table.AttributeDefinitions).toEqual([{ AttributeName: "key", AttributeType: "S" }]);
    expect(table.KeySchema).toEqual([{ AttributeName: "key", KeyType: "HASH" }]);
    expect(table.BillingMode).toBe("PAY_PER_REQUEST");
    expect(table.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
    expect(table.DeletionProtectionEnabled).toBe(true);
    expect(table.SSESpecification).toEqual({
      SSEEnabled: true, SSEType: "KMS",
      KMSMasterKeyId: { "Fn::GetAtt": ["MetadataKey", "Arn"] },
    });
    expect(table.TimeToLiveSpecification).toBeUndefined();
  });

  it("keeps backups private, versioned, SSE-KMS encrypted and without automatic expiry", () => {
    const bucket = resources.BackupBucket.Properties;
    expect(bucket.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true, BlockPublicPolicy: true,
      IgnorePublicAcls: true, RestrictPublicBuckets: true,
    });
    expect(bucket.OwnershipControls.Rules).toEqual([{ ObjectOwnership: "BucketOwnerEnforced" }]);
    expect(bucket.VersioningConfiguration.Status).toBe("Enabled");
    expect(bucket.BucketEncryption.ServerSideEncryptionConfiguration).toEqual([{
      BucketKeyEnabled: false,
      ServerSideEncryptionByDefault: {
        SSEAlgorithm: "aws:kms", KMSMasterKeyID: { "Fn::GetAtt": ["BackupKey", "Arn"] },
      },
    }]);
    expect(bucket.LifecycleConfiguration.Rules).toEqual([{
      Id: "AbortIncompleteUploadsOnly", Status: "Enabled",
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
    }]);
  });

  it("denies non-TLS access and uploads without the explicit designated KMS key", () => {
    expect(bucketStatements).toHaveLength(3);
    for (const statement of bucketStatements) {
      expect(statement.Effect).toBe("Deny");
      expect(statement.Principal).toBe("*");
    }
    expect(bucketStatements[0].Action).toBe("s3:*");
    expect(bucketStatements[0].Condition).toEqual({ Bool: { "aws:SecureTransport": "false" } });
    expect(bucketStatements[0].Resource).toEqual([
      { "Fn::GetAtt": ["BackupBucket", "Arn"] }, { "Fn::Sub": "${BackupBucket.Arn}/*" },
    ]);
    expect(bucketStatements[1].Condition.StringNotEquals).toEqual({
      "s3:x-amz-server-side-encryption": "aws:kms",
    });
    expect(bucketStatements[2].Condition.StringNotEquals).toEqual({
      "s3:x-amz-server-side-encryption-aws-kms-key-id": { "Fn::GetAtt": ["BackupKey", "Arn"] },
    });
  });

  it("limits node trust to EC2 and data access to one table and backup prefix", () => {
    expect(resources.NodeRole.Properties.AssumeRolePolicyDocument.Statement).toEqual([{
      Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole",
    }]);
    expect(policy("MetadataReadAndConditionalWrite")).toMatchObject({
      Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
      Resource: { "Fn::GetAtt": ["MetadataTable", "Arn"] },
    });
    expect(policy("EncryptedContentBackup")).toMatchObject({
      Action: ["s3:GetObject", "s3:PutObject"],
      Resource: { "Fn::Sub": "${BackupBucket.Arn}/records/*" },
    });
    expect(policy("BackupMissingKeySemantics")).toEqual({
      Sid: "BackupMissingKeySemantics", Effect: "Allow",
      Action: ["s3:ListBucket"], Resource: { "Fn::GetAtt": ["BackupBucket", "Arn"] },
    });
    const runtimePolicy = JSON.stringify(statements);
    expect(runtimePolicy).not.toMatch(/s3:Delete|dynamodb:Delete|dynamodb:Scan|iam:|kms:\*|kms:CreateGrant|kms:ScheduleKeyDeletion/);
    expect(runtimePolicy).not.toContain('"Resource":"*"');
    expect(resources.NodeRole.Properties.ManagedPolicyArns).toBeUndefined();
  });

  it("only authorizes KMS decryption through the relevant AWS service and context", () => {
    const s3 = policy("BackupEncryptionViaS3");
    expect(s3.Resource).toEqual({ "Fn::GetAtt": ["BackupKey", "Arn"] });
    expect(s3.Condition.StringEquals["kms:ViaService"]).toEqual({
      "Fn::Sub": "s3.${AWS::Region}.${AWS::URLSuffix}",
    });
    expect(s3.Condition.StringLike["kms:EncryptionContext:aws:s3:arn"]).toEqual({
      "Fn::Sub": "${BackupBucket.Arn}/records/*",
    });
    const dynamo = policy("ReadTableKeyViaDynamoDB");
    expect(dynamo.Action).toEqual(["kms:Decrypt"]);
    expect(dynamo.Resource).toEqual({ "Fn::GetAtt": ["MetadataKey", "Arn"] });
    expect(dynamo.Condition.StringEquals["kms:ViaService"]).toEqual({
      "Fn::Sub": "dynamodb.${AWS::Region}.${AWS::URLSuffix}",
    });
    expect(dynamo.Condition.StringEquals["kms:EncryptionContext:aws:dynamodb:tableName"]).toEqual({
      Ref: "MetadataTable",
    });
  });

  it("accepts external secret identifiers only, with optional narrowly scoped access", () => {
    expect(template.Parameters.RuntimeSecretArn.Default).toBe("");
    expect(template.Parameters.RuntimeSecretKmsKeyArn.Default).toBe("");
    expect(template.Rules.SecretKeyPair).toBeDefined();
    const optional = statements.filter((item: Record<string, unknown>) => item["Fn::If"]);
    expect(optional).toHaveLength(6);
    for (const item of optional) {
      expect(template.Conditions[item["Fn::If"][0]]).toBeDefined();
      expect(item["Fn::If"][2]).toEqual({ Ref: "AWS::NoValue" });
    }
    expect(optional[0]["Fn::If"][1]).toMatchObject({
      Action: ["secretsmanager:GetSecretValue"], Resource: { Ref: "RuntimeSecretArn" },
    });
    expect(optional[1]["Fn::If"][1].Condition.StringEquals).toMatchObject({
      "kms:ViaService": { "Fn::Sub": "secretsmanager.${AWS::Region}.${AWS::URLSuffix}" },
      "kms:EncryptionContext:SecretARN": { Ref: "RuntimeSecretArn" },
    });
    expect(raw).not.toMatch(/"SecretString"\s*:|"SecretBinary"\s*:|GenerateSecretString|AKIA[0-9A-Z]{16}|BEGIN .*PRIVATE KEY/);
    expect(JSON.stringify(template.Outputs)).not.toMatch(/RuntimeSecret|AUTH|patientDataKey/);
  });

  it("supports separate direct AWS authorization secrets without wildcard access", () => {
    const optional = statements.filter((item: Record<string, unknown>) => item["Fn::If"]);
    for (const [name, sid] of [
      ["ApiAuthorization", "KuboAuthorization"],
      ["ClusterAuthorization", "ClusterAuthorization"],
    ]) {
      expect(template.Parameters[`${name}SecretArn`].Default).toBe("");
      expect(template.Parameters[`${name}SecretKmsKeyArn`].Default).toBe("");
      expect(template.Rules[`${name}KeyRequiresSecret`]).toBeDefined();
      const read = optional.find((item: Record<string, any>) =>
        item["Fn::If"][1].Sid === `Read${sid}Secret`);
      expect(read["Fn::If"][0]).toBe(`Has${name}Secret`);
      expect(read["Fn::If"][1]).toMatchObject({
        Action: ["secretsmanager:GetSecretValue"], Resource: { Ref: `${name}SecretArn` },
      });
      const decrypt = optional.find((item: Record<string, any>) =>
        item["Fn::If"][1].Sid === `Decrypt${sid}ViaSecretsManager`);
      expect(decrypt["Fn::If"][0]).toBe(`Has${name}SecretKey`);
      expect(decrypt["Fn::If"][1]).toMatchObject({
        Action: ["kms:Decrypt"], Resource: { Ref: `${name}SecretKmsKeyArn` },
        Condition: { StringEquals: {
          "kms:ViaService": { "Fn::Sub": "secretsmanager.${AWS::Region}.${AWS::URLSuffix}" },
          "kms:EncryptionContext:SecretARN": { Ref: `${name}SecretArn` },
        } },
      });
    }
    const fragment = readFileSync(
      new URL("../../infra/aws/runtime/direct-api-auth.env.example", import.meta.url), "utf8",
    ).split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
    expect(fragment).toEqual([
      "IPFS_API_AUTH_AWS_SECRET_ID=REPLACE_WITH_ApiAuthorizationSecretArn",
      "IPFS_CLUSTER_AUTH_AWS_SECRET_ID=REPLACE_WITH_ClusterAuthorizationSecretArn",
    ]);
  });

  it("keeps application environment examples aligned with nonsecret outputs", () => {
    const env = Object.fromEntries(readFileSync(
      new URL("../../infra/aws/runtime/app.env.example", import.meta.url), "utf8",
    ).split(/\r?\n/).filter((line) => line && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    const mapping = {
      STORAGE_BACKEND: "StorageBackend", IPFS_METADATA_BACKEND: "IpfsMetadataBackend",
      DYNAMODB_TABLE: "DynamoDbTable", AWS_REGION: "AwsRegion",
      IPFS_BACKUP_BACKEND: "IpfsBackupBackend", S3_BUCKET: "S3Bucket",
      S3_KMS_KEY_ID: "S3KmsKeyId", STORAGE_PREFIX: "StoragePrefix",
      IPFS_PRIVATE_NETWORK: "IpfsPrivateNetwork",
    };
    for (const [setting, output] of Object.entries(mapping)) {
      const value = template.Outputs[output].Value;
      expect(env[setting]).toBe(typeof value === "string" ? value : `REPLACE_WITH_${output}`);
    }
    expect(env.IPFS_API_URL).toMatch(/^https:\/\/.+\.invalid$/);
    expect(env.IPFS_CLUSTER_API_URL).toMatch(/^https:\/\/.+\.invalid$/);
    expect(env.IPFS_REPLICATION_MIN).toBe("2");
    expect(env.IPFS_API_AUTH_FILE).toMatch(/^\/run\//);
    expect(env.IPFS_CLUSTER_AUTH_FILE).toMatch(/^\/run\//);
    expect(env.IPFS_API_AUTH).toBeUndefined();
    expect(env.IPFS_CLUSTER_AUTH).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("ships fail-closed AMI service examples rather than automatic formatting or downloads", () => {
    for (const name of ["kubo", "ipfs-cluster"]) {
      const unit = readFileSync(
        new URL(`../../infra/aws/runtime/${name}.service`, import.meta.url), "utf8",
      );
      expect(unit).toContain("ConditionPathIsMountPoint=/srv/ipfs");
      expect(unit).toContain("User=ipfs");
      expect(unit).toContain("NoNewPrivileges=true");
      expect(unit).toContain("LimitCORE=0");
      expect(unit).toContain("StandardOutput=null");
      expect(unit).not.toMatch(/mkfs|curl|wget|docker pull|:latest/);
    }
    const kubo = readFileSync(
      new URL("../../infra/aws/runtime/kubo.service", import.meta.url), "utf8",
    );
    expect(kubo).toContain("Environment=LIBP2P_FORCE_PNET=1");
    expect(kubo).toContain("ExecStartPre=/usr/bin/test -s /srv/ipfs/kubo/swarm.key");
  });
});
