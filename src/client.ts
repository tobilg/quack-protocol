import { DEFAULT_QUACK_PORT, DUCKDB_MIME_TYPE, QUACK_ENDPOINT, QUACK_VERSION } from "./constants";
import { QuackProtocolError, QuackServerError } from "./errors";
import type { LogicalType } from "./logical-types";
import {
  decodeMessage,
  encodeMessage,
  MessageType
} from "./messages";
import type { ConnectionRequestMessage, FetchResponseMessage, PrepareResponseMessage, QuackMessage } from "./messages";
import { dataChunkFromRows } from "./builders";
import type { ColumnSchema } from "./builders";
import { toJsonRows } from "./json";
import type { QuackJsonOptions, QuackJsonRow } from "./json";
import { formatSql } from "./sql";
import type { SqlParameters } from "./sql";
import { chunksToRows } from "./vector";
import type { QuackDataChunk, QuackRow, QuackValue } from "./vector";
import {
  arrowIPCFromTable,
  arrowTableFromChunks,
  arrowTableFromDataChunk,
  dataChunksFromArrow
} from "./arrow";
import type { QuackArrowAppendOptions, QuackArrowInput, QuackArrowIPCOptions, QuackArrowTableOptions } from "./arrow";
import type { Table as ArrowTable } from "@uwdata/flechette";

/** Options that apply to an individual Quack HTTP request. */
export interface QuackRequestOptions {
  /** Abort signal passed through to the underlying `fetch` request. */
  signal?: AbortSignal;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

/** Options used when opening a Quack connection. */
export interface QuackClientOptions extends QuackRequestOptions {
  /** Authentication token sent in the Quack connection request. */
  authToken?: string;
  /** Optional client DuckDB version string advertised to the server. */
  clientDuckdbVersion?: string;
  /** Optional client platform string advertised to the server. */
  clientPlatform?: string;
  /** Minimum Quack protocol version supported by the client. */
  minSupportedQuackVersion?: number | bigint;
  /** Maximum Quack protocol version supported by the client. */
  maxSupportedQuackVersion?: number | bigint;
  /** Custom fetch implementation, useful for tests or non-standard runtimes. */
  fetch?: typeof fetch;
  /** Extra HTTP headers merged into every Quack request. */
  headers?: HeadersInit;
  /** Force non-HTTP connection strings to resolve to HTTPS. */
  ssl?: boolean;
}

/** Options accepted by query and streaming methods. */
export interface QuackQueryOptions extends QuackRequestOptions {
  /** Positional or named SQL parameters formatted as client-side literals. */
  params?: SqlParameters;
}

/** Options accepted by low-level append calls. */
export interface AppendOptions extends QuackRequestOptions {
  /** Optional schema name for the target table. */
  schema?: string;
}

/** Options accepted by row-oriented append calls. */
export interface AppendRowsOptions<T extends Record<string, unknown>> extends AppendOptions {
  /** Column definitions used to encode row values as a DuckDB DataChunk. */
  columns?: ColumnSchema<T>;
  /** Number of input rows encoded into each append chunk. Defaults to all rows. */
  batchSize?: number;
}

/** Schema-qualified table reference used by append helpers. */
export interface TableReference {
  /** Table name without schema qualification. */
  table: string;
  /** Optional schema name. */
  schema?: string;
}

/** Parsed connection string with the HTTP base URL used for transport. */
export interface ParsedQuackUri {
  /** HTTP or HTTPS base URL without the `/quack` endpoint suffix. */
  baseUrl: string;
  /** Host parsed from the connection string. */
  host: string;
  /** Port parsed from the connection string, defaulting to 9494. */
  port: number;
  /** Whether the transport uses HTTPS. */
  ssl: boolean;
}

/** Server metadata returned by the Quack connection response. */
export interface QuackConnectionInfo {
  /** DuckDB version reported by the server. */
  serverDuckdbVersion?: string;
  /** Platform string reported by the server. */
  serverPlatform?: string;
  /** Quack protocol version reported by the server. */
  quackVersion?: bigint;
}

/** Result of a collected Quack query. */
export interface QuackQueryResult<T extends QuackRow = QuackRow> {
  /** Result column names in DuckDB result order. */
  names: string[];
  /** Decoded DuckDB logical types for each result column. */
  types: LogicalType[];
  /** Decoded DuckDB DataChunks returned by prepare/fetch. */
  chunks: QuackDataChunk[];
  /** Materialize the decoded chunks as row objects keyed by column name. */
  rows(): T[];
  /** Materialize rows and convert Quack-specific values to JSON-safe values. */
  jsonRows(options?: QuackJsonOptions): QuackJsonRow[];
}

/** Options accepted by Arrow query and streaming methods. */
export interface QuackArrowQueryOptions extends QuackQueryOptions, QuackArrowTableOptions {}

/** Options accepted by Arrow IPC query methods. */
export interface QuackArrowQueryIPCOptions extends QuackQueryOptions, QuackArrowIPCOptions {}

/** Options accepted by Arrow append methods. */
export interface AppendArrowOptions extends AppendOptions, QuackArrowAppendOptions {}

type NormalizedArrowQueryOptions = Omit<QuackArrowQueryIPCOptions, "params"> & { params: SqlParameters | undefined };

/** Client for DuckDB's Quack HTTP protocol. */
export class QuackClient {
  /** HTTP or HTTPS base URL used for Quack requests. */
  readonly baseUrl: string;
  /** Fetch implementation used by this client. */
  readonly fetchImpl: typeof fetch;
  /** Server metadata populated after a successful connection. */
  info: QuackConnectionInfo | undefined;
  private readonly headers: HeadersInit | undefined;
  private connectionId: string | undefined;
  private closed = false;
  private nextQueryId = 1n;

  private constructor(baseUrl: string, options: QuackClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.headers = options.headers;
    if (!this.fetchImpl) {
      throw new QuackProtocolError("No fetch implementation is available");
    }
  }

  /**
   * Open a Quack connection.
   *
   * Accepts bare host strings such as `localhost:9494`, DuckDB-style
   * `quack:` URIs, and direct HTTP(S) URLs.
   */
  static async connect(uri: string, options: QuackClientOptions = {}): Promise<QuackClient> {
    const parsed = parseQuackUri(uri, options.ssl);
    const client = new QuackClient(parsed.baseUrl, options);
    const request: ConnectionRequestMessage = {
      type: MessageType.CONNECTION_REQUEST,
      clientPlatform: options.clientPlatform ?? defaultClientPlatform(),
      minSupportedQuackVersion: options.minSupportedQuackVersion ?? QUACK_VERSION,
      maxSupportedQuackVersion: options.maxSupportedQuackVersion ?? QUACK_VERSION
    };
    if (options.authToken !== undefined) {
      request.authString = options.authToken;
    }
    if (options.clientDuckdbVersion !== undefined) {
      request.clientDuckdbVersion = options.clientDuckdbVersion;
    }
    const response = await client.send(request, options);
    if (response.type !== MessageType.CONNECTION_RESPONSE) {
      throw new QuackProtocolError(`Expected CONNECTION_RESPONSE, got ${MessageType[response.type] ?? response.type}`);
    }
    if (!response.connectionId) {
      throw new QuackProtocolError("CONNECTION_RESPONSE did not include a connection id");
    }
    client.connectionId = response.connectionId;
    client.info = {
      ...(response.serverDuckdbVersion === undefined ? {} : { serverDuckdbVersion: response.serverDuckdbVersion }),
      ...(response.serverPlatform === undefined ? {} : { serverPlatform: response.serverPlatform }),
      ...(response.quackVersion === undefined ? {} : { quackVersion: response.quackVersion })
    };
    return client;
  }

  /**
   * Open a connection, run a callback, and always disconnect afterwards.
   */
  static async withConnection<T>(
    uri: string,
    fn: (client: QuackClient) => Promise<T> | T
  ): Promise<T>;
  static async withConnection<T>(
    uri: string,
    options: QuackClientOptions,
    fn: (client: QuackClient) => Promise<T> | T
  ): Promise<T>;
  static async withConnection<T>(
    uri: string,
    optionsOrFn: QuackClientOptions | ((client: QuackClient) => Promise<T> | T),
    maybeFn?: (client: QuackClient) => Promise<T> | T
  ): Promise<T> {
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
    if (!fn) {
      throw new QuackProtocolError("withConnection requires a callback");
    }
    const client = await QuackClient.connect(uri, options);
    try {
      return await fn(client);
    } finally {
      await client.disconnect();
    }
  }

  /** Whether this client currently has an open Quack connection. */
  get isConnected(): boolean {
    return !!this.connectionId && !this.closed;
  }

  /**
   * Run SQL and collect all result chunks.
   *
   * Use the generic parameter to type the materialized rows returned by
   * {@link QuackQueryResult.rows}.
   */
  async query<T extends QuackRow = QuackRow>(sql: string, options?: QuackQueryOptions): Promise<QuackQueryResult<T>>;
  async query<T extends QuackRow = QuackRow>(
    sql: string,
    params: SqlParameters,
    options?: QuackRequestOptions
  ): Promise<QuackQueryResult<T>>;
  async query<T extends QuackRow = QuackRow>(
    sql: string,
    paramsOrOptions?: SqlParameters | QuackQueryOptions,
    requestOptions?: QuackRequestOptions
  ): Promise<QuackQueryResult<T>> {
    const options = normalizeQueryOptions(paramsOrOptions, requestOptions);
    const prepare = await this.prepare(formatSql(sql, options.params), options);
    const chunks = attachColumnNames([...prepare.results], prepare.resultNames);
    while (prepare.needsMoreFetch) {
      const fetchResponse = await this.fetchResult(prepare.resultUuid, options);
      if (fetchResponse.results.length === 0) {
        break;
      }
      chunks.push(...attachColumnNames(fetchResponse.results, prepare.resultNames));
    }
    return {
      names: prepare.resultNames,
      types: prepare.resultTypes,
      chunks,
      rows: () => chunksToRows(chunks, prepare.resultNames) as T[],
      jsonRows: (jsonOptions = {}) => toJsonRows(chunksToRows(chunks, prepare.resultNames), jsonOptions)
    };
  }

  /** Run SQL and collect the result as a Flechette Arrow Table. */
  async queryArrow(sql: string, options?: QuackArrowQueryOptions): Promise<ArrowTable>;
  async queryArrow(
    sql: string,
    params: SqlParameters,
    options?: QuackArrowQueryOptions
  ): Promise<ArrowTable>;
  async queryArrow(
    sql: string,
    paramsOrOptions?: SqlParameters | QuackArrowQueryOptions,
    requestOptions?: QuackArrowQueryOptions
  ): Promise<ArrowTable> {
    const options = normalizeArrowQueryOptions(paramsOrOptions, requestOptions);
    const result = await this.query(sql, options as QuackQueryOptions);
    return arrowTableFromChunks(result.chunks, result.names, { ...options, duckTypes: result.types });
  }

  /** Run SQL and collect the result as Arrow IPC bytes. */
  async queryArrowIPC(sql: string, options?: QuackArrowQueryIPCOptions): Promise<Uint8Array>;
  async queryArrowIPC(
    sql: string,
    params: SqlParameters,
    options?: QuackArrowQueryIPCOptions
  ): Promise<Uint8Array>;
  async queryArrowIPC(
    sql: string,
    paramsOrOptions?: SqlParameters | QuackArrowQueryIPCOptions,
    requestOptions?: QuackArrowQueryIPCOptions
  ): Promise<Uint8Array> {
    const options = normalizeArrowQueryOptions(paramsOrOptions, requestOptions) as QuackArrowQueryIPCOptions;
    const table = await this.queryArrow(sql, options);
    return arrowIPCFromTable(table, options);
  }

  /** Run SQL and return the first row, or `null` when the result is empty. */
  async first<T extends QuackRow = QuackRow>(sql: string, options?: QuackQueryOptions): Promise<T | null>;
  async first<T extends QuackRow = QuackRow>(
    sql: string,
    params: SqlParameters,
    options?: QuackRequestOptions
  ): Promise<T | null>;
  async first<T extends QuackRow = QuackRow>(
    sql: string,
    paramsOrOptions?: SqlParameters | QuackQueryOptions,
    requestOptions?: QuackRequestOptions
  ): Promise<T | null> {
    const rows = (await this.query<T>(sql, normalizeQueryOptions(paramsOrOptions, requestOptions))).rows();
    return rows[0] ?? null;
  }

  /** Run SQL and return exactly one row, throwing when the row count is not one. */
  async one<T extends QuackRow = QuackRow>(sql: string, options?: QuackQueryOptions): Promise<T>;
  async one<T extends QuackRow = QuackRow>(
    sql: string,
    params: SqlParameters,
    options?: QuackRequestOptions
  ): Promise<T>;
  async one<T extends QuackRow = QuackRow>(
    sql: string,
    paramsOrOptions?: SqlParameters | QuackQueryOptions,
    requestOptions?: QuackRequestOptions
  ): Promise<T> {
    const rows = (await this.query<T>(sql, normalizeQueryOptions(paramsOrOptions, requestOptions))).rows();
    if (rows.length !== 1) {
      throw new QuackProtocolError(`Expected exactly one row, got ${rows.length}`);
    }
    return rows[0]!;
  }

  /** Run SQL and return the first column from every materialized row. */
  async values<T extends QuackValue = QuackValue>(sql: string, options?: QuackQueryOptions): Promise<T[]>;
  async values<T extends QuackValue = QuackValue>(
    sql: string,
    params: SqlParameters,
    options?: QuackRequestOptions
  ): Promise<T[]>;
  async values<T extends QuackValue = QuackValue>(
    sql: string,
    paramsOrOptions?: SqlParameters | QuackQueryOptions,
    requestOptions?: QuackRequestOptions
  ): Promise<T[]> {
    const result = await this.query(sql, normalizeQueryOptions(paramsOrOptions, requestOptions));
    const firstName = result.names[0];
    if (!firstName) {
      return [];
    }
    return result.rows().map((row) => row[firstName] as T);
  }

  /** Run SQL and stream decoded DuckDB DataChunks without materializing all rows. */
  stream(sql: string, options?: QuackQueryOptions): AsyncGenerator<QuackDataChunk, void, void>;
  stream(sql: string, params: SqlParameters, options?: QuackRequestOptions): AsyncGenerator<QuackDataChunk, void, void>;
  async *stream(
    sql: string,
    paramsOrOptions?: SqlParameters | QuackQueryOptions,
    requestOptions?: QuackRequestOptions
  ): AsyncGenerator<QuackDataChunk, void, void> {
    const options = normalizeQueryOptions(paramsOrOptions, requestOptions);
    const prepare = await this.prepare(formatSql(sql, options.params), options);
    for (const chunk of attachColumnNames(prepare.results, prepare.resultNames)) {
      yield chunk;
    }
    while (prepare.needsMoreFetch) {
      const fetchResponse = await this.fetchResult(prepare.resultUuid, options);
      if (fetchResponse.results.length === 0) {
        break;
      }
      for (const chunk of attachColumnNames(fetchResponse.results, prepare.resultNames)) {
        yield chunk;
      }
    }
  }

  /** Run SQL and stream materialized rows. */
  streamRows<T extends QuackRow = QuackRow>(sql: string, options?: QuackQueryOptions): AsyncGenerator<T, void, void>;
  streamRows<T extends QuackRow = QuackRow>(
    sql: string,
    params: SqlParameters,
    options?: QuackRequestOptions
  ): AsyncGenerator<T, void, void>;
  async *streamRows<T extends QuackRow = QuackRow>(
    sql: string,
    paramsOrOptions?: SqlParameters | QuackQueryOptions,
    requestOptions?: QuackRequestOptions
  ): AsyncGenerator<T, void, void> {
    for await (const chunk of this.stream(sql, normalizeQueryOptions(paramsOrOptions, requestOptions))) {
      for (const row of chunksToRows([chunk])) {
        yield row as T;
      }
    }
  }

  /** Run SQL and stream result chunks as Flechette Arrow Tables. */
  streamArrow(sql: string, options?: QuackArrowQueryOptions): AsyncGenerator<ArrowTable, void, void>;
  streamArrow(sql: string, params: SqlParameters, options?: QuackArrowQueryOptions): AsyncGenerator<ArrowTable, void, void>;
  async *streamArrow(
    sql: string,
    paramsOrOptions?: SqlParameters | QuackArrowQueryOptions,
    requestOptions?: QuackArrowQueryOptions
  ): AsyncGenerator<ArrowTable, void, void> {
    const options = normalizeArrowQueryOptions(paramsOrOptions, requestOptions);
    for await (const chunk of this.stream(sql, options as QuackQueryOptions)) {
      yield arrowTableFromDataChunk(chunk, chunk.columnNames, options);
    }
  }

  /** Append an already encoded DuckDB DataChunk to a table. */
  async append(table: string, chunk: QuackDataChunk, schemaName?: string): Promise<void>;
  async append(table: string, chunk: QuackDataChunk, options?: AppendOptions): Promise<void>;
  async append(table: TableReference, chunk: QuackDataChunk, options?: QuackRequestOptions): Promise<void>;
  async append(
    table: string | TableReference,
    chunk: QuackDataChunk,
    schemaOrOptions?: string | AppendOptions | QuackRequestOptions
  ): Promise<void>;
  async append(
    table: string | TableReference,
    chunk: QuackDataChunk,
    schemaOrOptions?: string | AppendOptions | QuackRequestOptions
  ): Promise<void> {
    this.ensureOpen();
    const { tableName, schemaName, options } = normalizeAppendArgs(table, schemaOrOptions);
    const message: QuackMessage = {
      type: MessageType.APPEND_REQUEST,
      connectionId: this.getConnectionId(),
      clientQueryId: this.allocateQueryId(),
      tableName,
      appendChunk: chunk
    };
    if (schemaName !== undefined) {
      message.schemaName = schemaName;
    }
    const response = await this.send(message, options);
    if (response.type !== MessageType.SUCCESS_RESPONSE) {
      throw new QuackProtocolError(`Expected SUCCESS_RESPONSE, got ${MessageType[response.type] ?? response.type}`);
    }
  }

  /**
   * Encode row objects as one or more flat DataChunks and append them to a table.
   *
   * Provide explicit column types for stable production use, especially for
   * empty row sets or columns containing only `null`.
   */
  async appendRows<T extends Record<string, unknown>>(
    table: string | TableReference,
    rows: readonly T[],
    options: AppendRowsOptions<T> = {}
  ): Promise<void> {
    const chunkOptions = options.columns === undefined ? {} : { columns: options.columns };
    if (rows.length === 0) {
      await this.append(table, dataChunkFromRows(rows, chunkOptions), options);
      return;
    }
    const batchSize = options.batchSize ?? rows.length;
    if (batchSize < 1) {
      throw new QuackProtocolError("appendRows batchSize must be at least 1");
    }
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      await this.append(table, dataChunkFromRows(batch, chunkOptions), options);
    }
  }

  /** Append data from a Flechette Arrow Table or Arrow IPC bytes. */
  async appendArrow(
    table: string | TableReference,
    input: QuackArrowInput,
    options: AppendArrowOptions = {}
  ): Promise<void> {
    for (const chunk of dataChunksFromArrow(input, options)) {
      await this.append(table, chunk, options);
    }
  }

  /**
   * Run a callback inside a DuckDB transaction.
   *
   * Commits when the callback succeeds and attempts rollback when it throws.
   */
  async transaction<T>(fn: (client: this) => Promise<T> | T, options: QuackRequestOptions = {}): Promise<T> {
    await this.query("BEGIN TRANSACTION", options);
    try {
      const value = await fn(this);
      await this.query("COMMIT", options);
      return value;
    } catch (error) {
      try {
        await this.query("ROLLBACK", options);
      } catch {
        // Preserve the original application error.
      }
      throw error;
    }
  }

  /** Disconnect from the Quack server. Safe to call more than once. */
  async disconnect(options: QuackRequestOptions = {}): Promise<void> {
    if (this.closed || !this.connectionId) {
      this.closed = true;
      return;
    }
    const response = await this.send({
      type: MessageType.DISCONNECT_MESSAGE,
      connectionId: this.connectionId,
      clientQueryId: this.allocateQueryId()
    }, options);
    if (response.type !== MessageType.SUCCESS_RESPONSE) {
      throw new QuackProtocolError(`Expected SUCCESS_RESPONSE, got ${MessageType[response.type] ?? response.type}`);
    }
    this.closed = true;
    this.connectionId = undefined;
  }

  /** Alias for {@link disconnect}. */
  async close(options: QuackRequestOptions = {}): Promise<void> {
    await this.disconnect(options);
  }

  /**
   * Send a raw Quack protocol message.
   *
   * This is an escape hatch for protocol tests and advanced clients; most
   * application code should use higher-level methods.
   */
  async send(message: QuackMessage, options: QuackRequestOptions = {}): Promise<QuackMessage> {
    const bytes = encodeMessage(message);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const { signal, cleanup } = composeRequestSignal(options);
    let response: Response;
    try {
      const init: RequestInit = {
        method: "POST",
        headers: {
          Accept: DUCKDB_MIME_TYPE,
          "Content-Type": DUCKDB_MIME_TYPE,
          ...this.headers
        },
        body
      };
      if (signal !== undefined) {
        init.signal = signal;
      }
      response = await this.fetchImpl(`${this.baseUrl}${QUACK_ENDPOINT}`, init);
    } finally {
      cleanup();
    }
    if (!response.ok) {
      throw new QuackProtocolError(`Quack HTTP request failed with ${response.status} ${response.statusText}`);
    }
    const responseBytes = new Uint8Array(await response.arrayBuffer());
    const decoded = decodeMessage(responseBytes);
    if (decoded.type === MessageType.ERROR_RESPONSE) {
      throw new QuackServerError(decoded.message);
    }
    return decoded;
  }

  private async prepare(sql: string, options: QuackRequestOptions = {}): Promise<PrepareResponseMessage> {
    this.ensureOpen();
    const response = await this.send({
      type: MessageType.PREPARE_REQUEST,
      connectionId: this.getConnectionId(),
      clientQueryId: this.allocateQueryId(),
      sql
    }, options);
    if (response.type !== MessageType.PREPARE_RESPONSE) {
      throw new QuackProtocolError(`Expected PREPARE_RESPONSE, got ${MessageType[response.type] ?? response.type}`);
    }
    return response;
  }

  private async fetchResult(
    resultUuid: PrepareResponseMessage["resultUuid"],
    options: QuackRequestOptions = {}
  ): Promise<FetchResponseMessage> {
    this.ensureOpen();
    const response = await this.send({
      type: MessageType.FETCH_REQUEST,
      connectionId: this.getConnectionId(),
      clientQueryId: this.allocateQueryId(),
      resultUuid
    }, options);
    if (response.type !== MessageType.FETCH_RESPONSE) {
      throw new QuackProtocolError(`Expected FETCH_RESPONSE, got ${MessageType[response.type] ?? response.type}`);
    }
    return response;
  }

  private ensureOpen(): void {
    if (this.closed || !this.connectionId) {
      throw new QuackProtocolError("Quack client is not connected");
    }
  }

  private getConnectionId(): string {
    this.ensureOpen();
    if (!this.connectionId) {
      throw new QuackProtocolError("Quack client is not connected");
    }
    return this.connectionId;
  }

  private allocateQueryId(): bigint {
    return this.nextQueryId++;
  }
}

/**
 * Parse a Quack connection string into the HTTP base URL used by the client.
 *
 * Bare hosts default to port 9494, and `quack:` URIs are normalized to HTTP(S).
 */
export function parseQuackUri(input: string, sslOverride?: boolean): ParsedQuackUri {
  const uri = input.trim();
  if (!uri) {
    throw new QuackProtocolError("Quack URI is empty");
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    const url = new URL(uri);
    const ssl = url.protocol === "https:";
    return {
      baseUrl: `${url.protocol}//${url.host}`,
      host: url.hostname,
      port: url.port ? Number(url.port) : ssl ? 443 : 80,
      ssl
    };
  }

  let rest = uri;
  if (rest.startsWith("quack://")) {
    rest = rest.slice("quack://".length);
  } else if (rest.startsWith("quack:")) {
    rest = rest.slice("quack:".length);
  }
  if (!rest) {
    throw new QuackProtocolError(`Invalid Quack URI ${input}`);
  }

  const { host, port } = parseHostPort(rest);
  const ssl = sslOverride ?? false;
  const protocol = ssl ? "https" : "http";
  const bracketedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return {
    baseUrl: `${protocol}://${bracketedHost}:${port}`,
    host,
    port,
    ssl
  };
}

function parseHostPort(value: string): { host: string; port: number } {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) {
      throw new QuackProtocolError(`Invalid IPv6 Quack URI host ${value}`);
    }
    const host = value.slice(1, end);
    const suffix = value.slice(end + 1);
    const port = suffix.startsWith(":") ? parsePort(suffix.slice(1)) : DEFAULT_QUACK_PORT;
    return { host, port };
  }

  const colonCount = [...value].filter((char) => char === ":").length;
  if (colonCount === 0) {
    return { host: value, port: DEFAULT_QUACK_PORT };
  }
  if (colonCount === 1) {
    const [host, portText] = value.split(":");
    if (!host) {
      throw new QuackProtocolError(`Invalid Quack URI host ${value}`);
    }
    return { host, port: parsePort(portText ?? "") };
  }
  throw new QuackProtocolError(`IPv6 Quack URI hosts must be enclosed in []: ${value}`);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new QuackProtocolError(`Invalid Quack URI port ${value}`);
  }
  return port;
}

function defaultClientPlatform(): string {
  const navigatorLike = globalThis.navigator;
  return navigatorLike?.userAgent ?? "quack-ts";
}

function attachColumnNames(chunks: readonly QuackDataChunk[], names: readonly string[]): QuackDataChunk[] {
  return chunks.map((chunk) => ({ ...chunk, columnNames: [...names] }));
}

function normalizeQueryOptions(
  paramsOrOptions: SqlParameters | QuackQueryOptions | undefined,
  requestOptions: QuackRequestOptions | undefined
): QuackQueryOptions {
  if (paramsOrOptions === undefined) {
    return requestOptions ? { ...requestOptions } : {};
  }
  if (Array.isArray(paramsOrOptions)) {
    return { ...requestOptions, params: paramsOrOptions };
  }
  if (isQueryOptions(paramsOrOptions)) {
    return { ...paramsOrOptions, ...requestOptions };
  }
  return { ...requestOptions, params: paramsOrOptions };
}

function normalizeArrowQueryOptions(
  paramsOrOptions: SqlParameters | QuackArrowQueryOptions | QuackArrowQueryIPCOptions | undefined,
  requestOptions: QuackArrowQueryOptions | QuackArrowQueryIPCOptions | undefined
): NormalizedArrowQueryOptions {
  if (paramsOrOptions === undefined) {
    return (requestOptions ? { ...requestOptions, params: requestOptions.params } : { params: undefined }) as NormalizedArrowQueryOptions;
  }
  if (Array.isArray(paramsOrOptions)) {
    return { ...requestOptions, params: paramsOrOptions } as NormalizedArrowQueryOptions;
  }
  if (isArrowQueryOptions(paramsOrOptions)) {
    const merged = { ...paramsOrOptions, ...requestOptions };
    return { ...merged, params: merged.params } as NormalizedArrowQueryOptions;
  }
  return { ...requestOptions, params: paramsOrOptions } as NormalizedArrowQueryOptions;
}

function isArrowQueryOptions(value: object): value is QuackArrowQueryOptions | QuackArrowQueryIPCOptions {
  return (
    isQueryOptions(value) ||
    "useDate" in value ||
    "useDecimalInt" in value ||
    "useBigInt" in value ||
    "useBigIntTimestamp" in value ||
    "useMap" in value ||
    "useProxy" in value ||
    "duckTypes" in value ||
    "format" in value ||
    "codec" in value
  );
}

function isQueryOptions(value: object): value is QuackQueryOptions {
  return "params" in value || "signal" in value || "timeoutMs" in value;
}

function normalizeAppendArgs(
  table: string | TableReference,
  schemaOrOptions: string | AppendOptions | QuackRequestOptions | undefined
): { tableName: string; schemaName?: string; options: QuackRequestOptions } {
  const tableRef = typeof table === "string" ? { table } : table;
  const baseSchema = tableRef.schema;
  if (typeof schemaOrOptions === "string") {
    return {
      tableName: tableRef.table,
      schemaName: schemaOrOptions,
      options: {}
    };
  }
  const options = schemaOrOptions ?? {};
  const appendOptions = options as AppendOptions;
  const schemaName = appendOptions.schema ?? baseSchema;
  return {
    tableName: tableRef.table,
    ...(schemaName === undefined ? {} : { schemaName }),
    options: {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    }
  };
}

function composeRequestSignal(options: QuackRequestOptions): { signal?: AbortSignal; cleanup: () => void } {
  if (options.timeoutMs === undefined) {
    return { ...(options.signal === undefined ? {} : { signal: options.signal }), cleanup: () => undefined };
  }
  if (options.timeoutMs < 1) {
    throw new QuackProtocolError("timeoutMs must be at least 1");
  }
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal?.reason);
  const timeout = setTimeout(() => controller.abort(new Error(`Quack request timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener("abort", abortFromParent, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromParent);
    }
  };
}
