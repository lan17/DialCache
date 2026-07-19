export class DialCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UseCaseIsAlreadyRegisteredError extends DialCacheError {
  constructor(useCase: string) {
    super(`Use case already registered: ${useCase}`);
  }
}

export class UseCaseNameIsReservedError extends DialCacheError {
  constructor(useCase: string) {
    super(`Use case name is reserved: ${useCase}`);
  }
}

/** @deprecated Missing policy now resolves to the disabled baseline and does not throw. */
export class MissingKeyConfigError extends DialCacheError {
  constructor(useCase: string) {
    super(`Missing key config for use case: ${useCase}`);
  }
}
