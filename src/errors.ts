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

/** Error raised when the server returns a Quack error response. */
export class QuackServerError extends QuackError {
  /** Server-provided error message. */
  readonly serverMessage: string;

  /** Create a server error from a Quack error response. */
  constructor(serverMessage: string) {
    super(serverMessage);
    this.name = "QuackServerError";
    this.serverMessage = serverMessage;
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
