import { describe, expect, it } from "vitest";

import {
  InvalidFhirResourceError,
  validateFhirResource,
} from "../src/domain/fhir.js";

describe("FHIR validation", () => {
  it("accepts the supported essential record types", () => {
    expect(() =>
      validateFhirResource({
        resourceType: "Immunization",
        id: "synthetic-immunization",
        status: "completed",
      }),
    ).not.toThrow();
  });

  it("rejects unsupported and non-JSON resources", () => {
    expect(() =>
      validateFhirResource({ resourceType: "Patient", id: "patient-1" }),
    ).toThrow(InvalidFhirResourceError);

    expect(() =>
      validateFhirResource({
        resourceType: "Condition",
        invalid: undefined,
      }),
    ).toThrow(InvalidFhirResourceError);
  });
});
