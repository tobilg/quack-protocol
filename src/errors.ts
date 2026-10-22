/** Base class for errors thrown by the Quack SDK. */
export class QuackError extends Error {
  /** Create a Quack SDK error. */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QuackError";
  }
}

/** Error raised for client-side protocol, transport, URI, or state failures. */
export class QuackProtocolError extends QuackError {
  /** Create a protocol/client-state error. */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QuackProtocolError";
  }
}

/** Structured details carried by a Quack error response. */
export interface QuackServerErrorDetails {
  /** DuckDB exception type name, such as `Catalog` or `Invalid Input`. */
  exceptionType?: string;
  /** Additional DuckDB error metadata. */
  extraInfo?: Record<string, string>;
  /** Whether the server's database has been invalidated. */
  mustInvalidate?: boolean;
}

/** Error raised when the server returns a Quack error response. */
export class QuackServerError extends QuackError {
  /** Server-provided error message, without the exception type prefix. */
  readonly serverMessage: string;
  /** DuckDB exception type name, such as `Catalog` or `Invalid Input`. */
  readonly exceptionType: string | undefined;
  /** Additional DuckDB error metadata. */
  readonly extraInfo: Record<string, string>;
  /** Whether the server's database has been invalidated; the client cannot be used afterwards. */
  readonly mustInvalidate: boolean;

  /** Create a server error from a Quack error response. */
  constructor(serverMessage: string, details: QuackServerErrorDetails = {}) {
    super(details.exceptionType ? `${details.exceptionType} Error: ${serverMessage}` : serverMessage);
    this.name = "QuackServerError";
    this.serverMessage = serverMessage;
    this.exceptionType = details.exceptionType;
    this.extraInfo = details.extraInfo ?? {};
    this.mustInvalidate = details.mustInvalidate ?? false;
  }
}

/** Error raised for known DuckDB serialization paths outside current support. */
export class QuackUnsupportedTypeError extends QuackProtocolError {
  /** Create an unsupported-type error. */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QuackUnsupportedTypeError";
  }
}
