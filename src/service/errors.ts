export class RecordNotFoundError extends Error {
  public constructor() {
    super("No record exists for the supplied patient factor.");
    this.name = "RecordNotFoundError";
  }
}

export class RecordAlreadyExistsError extends Error {
  public constructor() {
    super("A record already exists for the supplied patient factor.");
    this.name = "RecordAlreadyExistsError";
  }
}

export class AccessDeniedError extends Error {
  public constructor() {
    super("The patient factor and clinician credential could not unlock the record.");
    this.name = "AccessDeniedError";
  }
}

export class IntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}
