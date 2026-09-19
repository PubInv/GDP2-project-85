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
} from "./storage/blob-store.js";
export { FileBlobStore } from "./storage/file-blob-store.js";
export { InMemoryBlobStore } from "./storage/in-memory-blob-store.js";
export { AzureBlobStore } from "./storage/azure-blob-store.js";
export { S3BlobStore, type S3BlobStoreOptions } from "./storage/s3-blob-store.js";
export {
  DistributedBlobStore, type DistributedContentStore,
} from "./storage/distributed-blob-store.js";
export {
  IpfsClusterClient, type IpfsClusterClientOptions,
} from "./storage/ipfs-cluster-client.js";
export { createConfiguredBlobStore } from "./storage/configured-blob-store.js";
export {
  StorageConfigurationError, type StorageBackend, type StorageEnvironment,
} from "./storage/configuration.js";
