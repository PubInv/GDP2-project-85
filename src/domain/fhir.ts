export const SUPPORTED_FHIR_RESOURCE_TYPES = [
  "AllergyIntolerance",
  "Condition",
  "Immunization",
  "MedicationStatement",
  "Observation",
] as const;

export type SupportedFhirResourceType =
  (typeof SUPPORTED_FHIR_RESOURCE_TYPES)[number];

export interface FhirResource {
  resourceType: SupportedFhirResourceType;
  id?: string;
  [key: string]: unknown;
}

const MAX_RESOURCE_BYTES = 256 * 1024;

export class InvalidFhirResourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidFhirResourceError";
  }
}

export function validateFhirResource(value: unknown): asserts value is FhirResource {
  if (!isJsonObject(value)) {
    throw new InvalidFhirResourceError("FHIR resource must be a JSON object.");
  }

  if (
    typeof value.resourceType !== "string" ||
    !SUPPORTED_FHIR_RESOURCE_TYPES.includes(
      value.resourceType as SupportedFhirResourceType,
    )
  ) {
    throw new InvalidFhirResourceError(
      `Unsupported FHIR resourceType. Supported types: ${SUPPORTED_FHIR_RESOURCE_TYPES.join(", ")}.`,
    );
  }

  if (
    value.id !== undefined &&
    (typeof value.id !== "string" || value.id.length === 0)
  ) {
    throw new InvalidFhirResourceError(
      "FHIR resource id must be a non-empty string when present.",
    );
  }

  assertJsonValue(value, "$");

  const encoded = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (encoded > MAX_RESOURCE_BYTES) {
    throw new InvalidFhirResourceError(
      `FHIR resource exceeds the ${MAX_RESOURCE_BYTES}-byte POC limit.`,
    );
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonValue(value: unknown, path: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidFhirResourceError(
        `FHIR value at ${path} must be a finite number.`,
      );
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }

  if (isJsonObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) {
        throw new InvalidFhirResourceError(
          `FHIR value at ${path}.${key} cannot be undefined.`,
        );
      }
      assertJsonValue(child, `${path}.${key}`);
    }
    return;
  }

  throw new InvalidFhirResourceError(
    `FHIR value at ${path} is not JSON-serializable.`,
  );
}
