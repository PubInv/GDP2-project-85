export {
  createClinicianCredential,
  deriveCapsuleLocator,
} from "./crypto/primitives.js";
export {
  SUPPORTED_FHIR_RESOURCE_TYPES,
  InvalidFhirResourceError,
  type FhirResource,
  type SupportedFhirResourceType,
} from "./domain/fhir.js";
export type {
  ClinicianCredential,
  ProvenanceEventPayload,
  TimelineEntry,
} from "./domain/provenance.js";
export {
  AccessDeniedError,
  IntegrityError,
  RecordAlreadyExistsError,
  RecordNotFoundError,
} from "./service/errors.js";
export {
  PatientRecordService,
  type AppendRequest,
  type AppendResult,
  type EnrollRequest,
} from "./service/patient-record-service.js";
export {
  ConcurrentUpdateError,
  ObjectAlreadyExistsError,
  ObjectNotFoundError,
  type BlobStore,
  type StoredObject,
} from "./storage/core/blob-store.js";
export { FileBlobStore } from "./storage/adapters/file/file-blob-store.js";
export { InMemoryBlobStore } from "./storage/adapters/memory/in-memory-blob-store.js";
export { AzureBlobStore } from "./storage/adapters/azure/azure-blob-store.js";
export { S3BlobStore, type S3BlobStoreOptions } from "./storage/adapters/s3/s3-blob-store.js";
export {
  DynamoDbBlobStore, type DynamoDbBlobStoreOptions,
} from "./storage/adapters/dynamodb/dynamodb-blob-store.js";
export {
  DistributedBlobStore, type DistributedContentStore,
} from "./storage/adapters/ipfs/distributed-blob-store.js";
export {
  IpfsClusterClient, type IpfsClusterClientOptions,
} from "./storage/adapters/ipfs/ipfs-cluster-client.js";
export { BackedUpContentStore } from "./storage/adapters/ipfs/backed-up-content-store.js";
export { createConfiguredBlobStore } from "./storage/config/factory.js";
export {
  StorageConfigurationError, type StorageBackend, type StorageEnvironment,
} from "./storage/config/settings.js";
export type {
  StorageProviderContext, StorageProviderFactory, StorageProviderRegistry, StorageFactoryOptions,
} from "./storage/config/provider.js";
