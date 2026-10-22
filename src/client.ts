import {
  DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
  DEFAULT_QUACK_PORT,
  DUCKDB_MIME_TYPE,
  MAX_HEARTBEAT_TIMEOUT_SECONDS,
  QUACK_ENDPOINT,
  QUACK_VERSION,
  STANDARD_VECTOR_SIZE
} from "./constants";
import { QuackProtocolError, QuackServerError } from "./errors";
import type { HugeIntParts } from "./binary";
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
import { formatSql, logicalTypeToSql, quoteIdentifier, sqlLiteral } from "./sql";
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

/** Rows sent per SEND_DATA batch by append helpers. */
const APPEND_BATCH_ROWS = STANDARD_VECTOR_SIZE * 16;
/** Timeout for best-effort cleanup requests such as cancel after a failed statement. */
const CLEANUP_TIMEOUT_MS = 5_000;

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
  /** Optional stable client identifier sent to the server; at least 4 characters when set. */
  clientId?: string;
  /** Heartbeat lease timeout in seconds requested from the server. Defaults to 60. */
  heartbeatTimeoutSeconds?: number;
  /**
   * Send heartbeat requests while the connection is idle so the server keeps
   * the lease alive. Defaults to `true`.
   */
  heartbeat?: boolean;
  /**
   * Send an acknowledgement after each fully received result, releasing the
   * server's reconnect cache (only used when the server enables
   * `quack_enable_reconnects`). Defaults to `false`.
   */
  acknowledgeResults?: boolean;
  /** Custom fetch implementation, useful for tests or non-standard runtimes. */
  fetch?: typeof fetch;
  /** Extra HTTP headers merged into every Quack request. */
  headers?: HeadersInit;
  /**
   * Transport for `quack:` and bare-host connection strings: `true` forces
   * HTTPS, `false` forces HTTP. By default, like DuckDB, the client uses HTTP
   * for `localhost`, `127.0.0.1`, and `::1`, and HTTPS for every other host.
   * Ignored for `http://` and `https://` URLs.
   */
  ssl?: boolean;
}

/** Options accepted by query and streaming methods. */
export interface QuackQueryOptions extends QuackRequestOptions {
  /** Positional or named SQL parameters formatted as client-side literals. */
  params?: SqlParameters;
  /** Maximum rows the prepare response may carry inline. Unset uses the server setting. */
  inlineRows?: number;
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
  /** Number of input rows encoded into each DataChunk. Defaults to all rows. */
  batchSize?: number;
}

/** Schema-qualified table reference used by append helpers. */
export interface TableReference {
  /** Table name without schema qualification. */
  table: string;
  /** Optional schema name. */
  schema?: string;
  /** Optional catalog (database) name. */
  catalog?: string;
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
  /** Heartbeat lease timeout in seconds accepted by the server. */
  heartbeatTimeoutSeconds?: number;
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

interface ActiveStatement {
  generation: number;
  queryUuid: HugeIntParts;
}

/**
 * Client for DuckDB's Quack HTTP protocol.
 *
 * A Quack connection runs one statement at a time; the server cancels a
 * running statement when the next one starts. The client therefore queues
 * statements issued concurrently on the same instance. Streams release the
 * queue between batches, so a statement started while a stream is not yet
 * drained interrupts that stream. Use separate clients for concurrent work.
 */
export class QuackClient {
  /** HTTP or HTTPS base URL used for Quack requests. */
  readonly baseUrl: string;
  /** Fetch implementation used by this client. */
  readonly fetchImpl: typeof fetch;
  /** Server metadata populated after a successful connection. */
  info: QuackConnectionInfo | undefined;
  private readonly headers: HeadersInit | undefined;
  private readonly heartbeatEnabled: boolean;
  private readonly acknowledgeResults: boolean;
  private connectionId: string | undefined;
  private closed = false;
  private invalidatedReason: string | undefined;
  private nextQueryId = 1n;
  private heartbeatTimeoutSeconds = DEFAULT_HEARTBEAT_TIMEOUT_SECONDS;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRequestAt = 0;
  private statementTail: Promise<void> = Promise.resolve();
  private statementGeneration = 0;
  private activeStatement: ActiveStatement | undefined;

  private constructor(baseUrl: string, options: QuackClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.headers = options.headers;
    this.heartbeatEnabled = options.heartbeat ?? true;
    this.acknowledgeResults = options.acknowledgeResults ?? false;
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
    const heartbeatTimeoutSeconds = validateHeartbeatTimeout(options.heartbeatTimeoutSeconds ?? DEFAULT_HEARTBEAT_TIMEOUT_SECONDS);
    if (options.clientId !== undefined && options.clientId !== "" && options.clientId.length < 4) {
      throw new QuackProtocolError("clientId must be at least 4 characters long");
    }
    const client = new QuackClient(parsed.baseUrl, options);
    const request: ConnectionRequestMessage = {
      type: MessageType.CONNECTION_REQUEST,
      clientPlatform: options.clientPlatform ?? defaultClientPlatform(),
      minSupportedQuackVersion: options.minSupportedQuackVersion ?? QUACK_VERSION,
      maxSupportedQuackVersion: options.maxSupportedQuackVersion ?? QUACK_VERSION,
      heartbeatTimeoutSeconds
    };
    if (options.authToken !== undefined) {
      request.authString = options.authToken;
    }
    if (options.clientDuckdbVersion !== undefined) {
      request.clientDuckdbVersion = options.clientDuckdbVersion;
    }
    if (options.clientId !== undefined) {
      request.clientId = options.clientId;
    }
    const response = await client.send(request, options);
    if (response.type !== MessageType.CONNECTION_RESPONSE) {
      throw new QuackProtocolError(`Expected CONNECTION_RESPONSE, got ${MessageType[response.type] ?? response.type}`);
    }
    if (!response.connectionId) {
      throw new QuackProtocolError("CONNECTION_RESPONSE did not include a connection id");
    }
    client.connectionId = response.connectionId;
    if (response.quackVersion !== BigInt(QUACK_VERSION)) {
      await client.disconnect().catch(() => undefined);
      throw new QuackProtocolError(
        `Incompatible Quack protocol version: server uses ${response.quackVersion ?? "unknown"}, client supports ${QUACK_VERSION}`
      );
    }
    if (response.heartbeatTimeoutSeconds !== undefined && response.heartbeatTimeoutSeconds > 0n) {
      client.heartbeatTimeoutSeconds = validateHeartbeatTimeout(response.heartbeatTimeoutSeconds);
    } else {
      client.heartbeatTimeoutSeconds = heartbeatTimeoutSeconds;
    }
    client.info = {
      ...(response.serverDuckdbVersion === undefined ? {} : { serverDuckdbVersion: response.serverDuckdbVersion }),
      ...(response.serverPlatform === undefined ? {} : { serverPlatform: response.serverPlatform }),
      ...(response.quackVersion === undefined ? {} : { quackVersion: response.quackVersion }),
      heartbeatTimeoutSeconds: client.heartbeatTimeoutSeconds
    };
    client.scheduleHeartbeat();
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
    return !!this.connectionId && !this.closed && this.invalidatedReason === undefined;
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
    const formatted = formatSql(sql, options.params);
    const { prepare, chunks } = await this.withStatement(async (statement) => {
      const prepare = await this.prepare(formatted, statement, options);
      const chunks = attachColumnNames(prepare.results, prepare.resultNames);
      if (prepare.needsMoreFetch) {
        for (let batchIndex = 1; ; batchIndex++) {
          const response = await this.fetchBatch(statement, batchIndex, options);
          if (response.results.length === 0) {
            break;
          }
          chunks.push(...attachColumnNames(response.results, prepare.resultNames));
        }
      }
      await this.acknowledge(statement);
      return { prepare, chunks };
    });
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

  /**
   * Run SQL and stream decoded DuckDB DataChunks without materializing all rows.
   *
   * Breaking out of the loop cancels the remaining result on the server. A
   * statement started on this client before the stream is drained interrupts
   * the stream.
   */
  stream(sql: string, options?: QuackQueryOptions): AsyncGenerator<QuackDataChunk, void, void>;
  stream(sql: string, params: SqlParameters, options?: QuackRequestOptions): AsyncGenerator<QuackDataChunk, void, void>;
  async *stream(
    sql: string,
    paramsOrOptions?: SqlParameters | QuackQueryOptions,
    requestOptions?: QuackRequestOptions
  ): AsyncGenerator<QuackDataChunk, void, void> {
    const options = normalizeQueryOptions(paramsOrOptions, requestOptions);
    const formatted = formatSql(sql, options.params);
    let statement: ActiveStatement | undefined;
    const prepare = await this.withStatement(async (active) => {
      statement = active;
      return this.prepare(formatted, active, options);
    }, { keepActive: true });
    const current = statement!;
    let drained = !prepare.needsMoreFetch;
    try {
      for (const chunk of attachColumnNames(prepare.results, prepare.resultNames)) {
        yield chunk;
      }
      for (let batchIndex = 1; !drained; batchIndex++) {
        const response = await this.withStatementSlot(async () => {
          if (this.statementGeneration !== current.generation) {
            throw new QuackProtocolError("Stream was interrupted by another statement on the same Quack client");
          }
          return this.fetchBatch(current, batchIndex, options);
        });
        if (response.results.length === 0) {
          drained = true;
          break;
        }
        for (const chunk of attachColumnNames(response.results, prepare.resultNames)) {
          yield chunk;
        }
      }
      await this.acknowledge(current);
    } finally {
      if (!drained && this.statementGeneration === current.generation) {
        await this.cancelQuietly(current);
      }
      this.endStatement(current);
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

  /**
   * Append one or more encoded DuckDB DataChunks to a table and return the number of inserted rows.
   *
   * All chunks are inserted by one `INSERT` statement, so they succeed or fail
   * together. Columns are matched by position against the target table.
   */
  async append(table: string, data: QuackDataChunk | readonly QuackDataChunk[], schemaName?: string): Promise<number>;
  async append(table: string, data: QuackDataChunk | readonly QuackDataChunk[], options?: AppendOptions): Promise<number>;
  async append(table: TableReference, data: QuackDataChunk | readonly QuackDataChunk[], options?: QuackRequestOptions): Promise<number>;
  async append(
    table: string | TableReference,
    data: QuackDataChunk | readonly QuackDataChunk[],
    schemaOrOptions?: string | AppendOptions | QuackRequestOptions
  ): Promise<number>;
  async append(
    table: string | TableReference,
    data: QuackDataChunk | readonly QuackDataChunk[],
    schemaOrOptions?: string | AppendOptions | QuackRequestOptions
  ): Promise<number> {
    this.ensureOpen();
    const { target, options } = normalizeAppendArgs(table, schemaOrOptions);
    const chunks: readonly QuackDataChunk[] = isChunkArray(data) ? data : [data];
    const types = chunks[0]?.types;
    if (!types || types.length === 0) {
      throw new QuackProtocolError("append requires at least one chunk with at least one column");
    }
    for (const chunk of chunks) {
      if (chunk.types.length !== types.length || chunk.types.some((type, index) => type.id !== types[index]?.id)) {
        throw new QuackProtocolError("All append chunks must have the same column types");
      }
    }
    const batches = appendBatches(chunks);
    const streamId = randomStreamId();
    const prototype = `NULL::STRUCT(${types.map((type, index) => `col${index} ${logicalTypeToSql(type)}`).join(", ")})`;
    const sql = `INSERT INTO ${target} SELECT * FROM scan_data_from_quack_client(${sqlLiteral(streamId)}, ${prototype}, ordered := true)`;

    return this.withStatement(async (statement) => {
      // inline_rows = 0: the statement waits for client data, so PREPARE must answer before any row exists
      await this.prepare(sql, statement, { ...options, inlineRows: 0 });
      for (let index = 0; index < batches.length; index++) {
        await this.sendData({
          type: MessageType.SEND_DATA_REQUEST,
          connectionId: this.getConnectionId(),
          clientQueryId: this.allocateQueryId(),
          streamId,
          chunks: batches[index]!,
          batchIndex: index + 1
        }, options);
      }
      await this.sendData({
        type: MessageType.SEND_DATA_REQUEST,
        connectionId: this.getConnectionId(),
        clientQueryId: this.allocateQueryId(),
        streamId,
        chunks: [],
        totalBatches: batches.length
      }, options);
      const response = await this.fetchBatch(statement, 1, options);
      const count = response.results[0]?.columns[0]?.values[0];
      return count === undefined || count === null ? 0 : Number(count);
    }, { cancelOnServerError: true });
  }

  /**
   * Encode row objects as flat DataChunks and append them to a table in one
   * statement. Returns the number of inserted rows.
   *
   * Provide explicit column types for stable production use, especially for
   * empty row sets or columns containing only `null`.
   */
  async appendRows<T extends Record<string, unknown>>(
    table: string | TableReference,
    rows: readonly T[],
    options: AppendRowsOptions<T> = {}
  ): Promise<number> {
    const chunkOptions = options.columns === undefined ? {} : { columns: options.columns };
    if (rows.length === 0) {
      return this.append(table, dataChunkFromRows(rows, chunkOptions), options);
    }
    const batchSize = options.batchSize ?? rows.length;
    if (batchSize < 1) {
      throw new QuackProtocolError("appendRows batchSize must be at least 1");
    }
    const chunks: QuackDataChunk[] = [];
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      chunks.push(dataChunkFromRows(rows.slice(offset, offset + batchSize), chunkOptions));
    }
    return this.append(table, chunks, options);
  }

  /** Append data from a Flechette Arrow Table or Arrow IPC bytes. Returns the number of inserted rows. */
  async appendArrow(
    table: string | TableReference,
    input: QuackArrowInput,
    options: AppendArrowOptions = {}
  ): Promise<number> {
    return this.append(table, dataChunksFromArrow(input, options), options);
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

  /**
   * Cancel the statement currently running on this client.
   *
   * Resolves to `false` when no statement is running.
   */
  async cancel(options: QuackRequestOptions = {}): Promise<boolean> {
    const statement = this.activeStatement;
    if (!statement || !this.isConnected) {
      return false;
    }
    const response = await this.send({
      type: MessageType.CANCEL_REQUEST,
      connectionId: this.getConnectionId(),
      clientQueryId: this.allocateQueryId(),
      queryUuid: statement.queryUuid
    }, options);
    expectResponse(response, MessageType.SUCCESS_RESPONSE);
    return true;
  }

  /** Send a heartbeat request, renewing the connection lease. */
  async heartbeat(options: QuackRequestOptions = {}): Promise<void> {
    this.ensureOpen();
    const response = await this.send({
      type: MessageType.HEARTBEAT_REQUEST,
      connectionId: this.getConnectionId(),
      clientQueryId: this.allocateQueryId()
    }, options);
    expectResponse(response, MessageType.SUCCESS_RESPONSE);
  }

  /** Disconnect from the Quack server. Safe to call more than once. */
  async disconnect(options: QuackRequestOptions = {}): Promise<void> {
    this.stopHeartbeat();
    const connectionId = this.connectionId;
    if (this.closed || !connectionId) {
      this.closed = true;
      return;
    }
    this.closed = true;
    this.connectionId = undefined;
    if (this.invalidatedReason !== undefined) {
      return;
    }
    const response = await this.send({
      type: MessageType.DISCONNECT_MESSAGE,
      connectionId,
      clientQueryId: this.allocateQueryId()
    }, options);
    expectResponse(response, MessageType.SUCCESS_RESPONSE);
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
    let responseBytes: Uint8Array;
    this.lastRequestAt = Date.now();
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
      if (!response.ok) {
        throw new QuackProtocolError(`Quack HTTP request failed with ${response.status} ${response.statusText}`);
      }
      responseBytes = new Uint8Array(await response.arrayBuffer());
    } finally {
      cleanup();
    }
    const decoded = decodeMessage(responseBytes);
    if (decoded.type === MessageType.ERROR_RESPONSE) {
      if (decoded.mustInvalidate) {
        this.invalidatedReason = decoded.message;
        this.stopHeartbeat();
      }
      throw new QuackServerError(decoded.message, {
        ...(decoded.exceptionType === undefined ? {} : { exceptionType: decoded.exceptionType }),
        ...(decoded.extraInfo === undefined ? {} : { extraInfo: decoded.extraInfo }),
        ...(decoded.mustInvalidate === undefined ? {} : { mustInvalidate: decoded.mustInvalidate })
      });
    }
    return decoded;
  }

  private async prepare(
    sql: string,
    statement: ActiveStatement,
    options: QuackQueryOptions = {}
  ): Promise<PrepareResponseMessage> {
    const response = await this.send({
      type: MessageType.PREPARE_REQUEST,
      connectionId: this.getConnectionId(),
      clientQueryId: this.allocateQueryId(),
      sql,
      queryUuid: statement.queryUuid,
      ...(options.inlineRows === undefined ? {} : { inlineRows: options.inlineRows })
    }, options);
    return expectResponse(response, MessageType.PREPARE_RESPONSE);
  }

  private async fetchBatch(
    statement: ActiveStatement,
    batchIndex: number,
    options: QuackRequestOptions = {}
  ): Promise<FetchResponseMessage> {
    const response = expectResponse(
      await this.send({
        type: MessageType.FETCH_REQUEST,
        connectionId: this.getConnectionId(),
        clientQueryId: this.allocateQueryId(),
        queryUuid: statement.queryUuid,
        batchIndex,
        ackIndex: batchIndex - 1
      }, options),
      MessageType.FETCH_RESPONSE
    );
    if (response.results.length === 0) {
      const received = BigInt(batchIndex - 1);
      if (response.totalBatches !== undefined && response.totalBatches !== received) {
        throw new QuackProtocolError(`Result ended after ${received} batches but the server announced ${response.totalBatches}`);
      }
    } else if (response.batchIndex !== BigInt(batchIndex)) {
      throw new QuackProtocolError(`FETCH_RESPONSE carries batch ${response.batchIndex ?? "none"} but batch ${batchIndex} was requested`);
    }
    return response;
  }

  private async sendData(message: QuackMessage, options: QuackRequestOptions): Promise<void> {
    expectResponse(await this.send(message, options), MessageType.SEND_DATA_RESPONSE);
  }

  private async acknowledge(statement: ActiveStatement): Promise<void> {
    if (!this.acknowledgeResults || !this.isConnected) {
      return;
    }
    try {
      await this.send({
        type: MessageType.ACKNOWLEDGEMENT,
        connectionId: this.getConnectionId(),
        clientQueryId: this.allocateQueryId(),
        queryUuid: statement.queryUuid
      }, { timeoutMs: CLEANUP_TIMEOUT_MS });
    } catch {
      // The result is complete; a failed acknowledgement only delays cache release.
    }
  }

  /** Best-effort cancel of a statement that failed or was abandoned client-side. */
  private async cancelQuietly(statement: ActiveStatement): Promise<void> {
    if (!this.isConnected) {
      return;
    }
    try {
      await this.send({
        type: MessageType.CANCEL_REQUEST,
        connectionId: this.getConnectionId(),
        clientQueryId: this.allocateQueryId(),
        queryUuid: statement.queryUuid
      }, { timeoutMs: CLEANUP_TIMEOUT_MS });
    } catch {
      // The next statement supersedes the abandoned one anyway.
    }
  }

  /**
   * Run a statement while holding the connection's statement slot.
   *
   * Failures other than server errors (aborts, timeouts, transport errors)
   * cancel the statement on the server before the slot is released. A server
   * error already ends a query, but not a statement waiting for client data.
   */
  private async withStatement<T>(
    fn: (statement: ActiveStatement) => Promise<T>,
    { keepActive = false, cancelOnServerError = false }: { keepActive?: boolean; cancelOnServerError?: boolean } = {}
  ): Promise<T> {
    return this.withStatementSlot(async () => {
      this.ensureOpen();
      const statement = this.beginStatement();
      let succeeded = false;
      try {
        const result = await fn(statement);
        succeeded = true;
        return result;
      } catch (error) {
        if (cancelOnServerError || !(error instanceof QuackServerError)) {
          await this.cancelQuietly(statement);
        }
        throw error;
      } finally {
        if (!succeeded || !keepActive) {
          this.endStatement(statement);
        }
      }
    });
  }

  private async withStatementSlot<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.statementTail;
    this.statementTail = previous.then(() => slot);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private beginStatement(): ActiveStatement {
    const statement = { generation: ++this.statementGeneration, queryUuid: randomQueryUuid() };
    this.activeStatement = statement;
    return statement;
  }

  private endStatement(statement: ActiveStatement): void {
    if (this.activeStatement === statement) {
      this.activeStatement = undefined;
    }
  }

  private scheduleHeartbeat(): void {
    if (!this.heartbeatEnabled || !this.isConnected) {
      return;
    }
    // renew at about a third of the lease, with jitter, like DuckDB's own client
    const intervalMs = (this.heartbeatTimeoutSeconds * 1000) / 3;
    const delayMs = Math.min(intervalMs * (0.8 + Math.random() * 0.4), 0x7fff_ffff);
    const timer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      void this.heartbeatTick(intervalMs);
    }, delayMs);
    unrefTimer(timer);
    this.heartbeatTimer = timer;
  }

  private async heartbeatTick(intervalMs: number): Promise<void> {
    if (!this.isConnected) {
      return;
    }
    // any request renews the lease, so skip the heartbeat while the client is busy
    if (Date.now() - this.lastRequestAt >= intervalMs / 2) {
      try {
        await this.heartbeat({ timeoutMs: CLEANUP_TIMEOUT_MS });
      } catch {
        // A failed heartbeat is retried on the next interval.
      }
    }
    this.scheduleHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private ensureOpen(): void {
    if (this.invalidatedReason !== undefined) {
      throw new QuackProtocolError(
        `The Quack server invalidated its database and must be restarted: ${this.invalidatedReason}`
      );
    }
    if (this.closed || !this.connectionId) {
      throw new QuackProtocolError("Quack client is not connected");
    }
  }

  private getConnectionId(): string {
    this.ensureOpen();
    return this.connectionId!;
  }

  private allocateQueryId(): bigint {
    return this.nextQueryId++;
  }
}

/**
 * Parse a Quack connection string into the HTTP base URL used by the client.
 *
 * Bare hosts default to port 9494, and `quack:` URIs are normalized to HTTP(S):
 * HTTP for local hosts and HTTPS otherwise, unless `sslOverride` is given.
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
  const ssl = sslOverride ?? !isLocalHost(host);
  const protocol = ssl ? "https" : "http";
  const bracketedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return {
    baseUrl: `${protocol}://${bracketedHost}:${port}`,
    host,
    port,
    ssl
  };
}

/** DuckDB's rule (`QuackUri::IsLocal`) for hosts served over plain HTTP by default. */
function isLocalHost(host: string): boolean {
  return host.toLowerCase() === "localhost" || host === "127.0.0.1" || host === "::1";
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

function validateHeartbeatTimeout(value: number | bigint): number {
  const seconds = BigInt(value);
  if (typeof value === "number" && !Number.isInteger(value)) {
    throw new QuackProtocolError("heartbeatTimeoutSeconds must be an integer");
  }
  if (seconds < 1n || seconds > MAX_HEARTBEAT_TIMEOUT_SECONDS || seconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new QuackProtocolError(`heartbeatTimeoutSeconds must be between 1 and ${Number.MAX_SAFE_INTEGER}`);
  }
  return Number(seconds);
}

function expectResponse<T extends MessageType>(
  response: QuackMessage,
  type: T
): Extract<QuackMessage, { type: T }> {
  if (response.type !== type) {
    throw new QuackProtocolError(`Expected ${MessageType[type]}, got ${MessageType[response.type] ?? response.type}`);
  }
  return response as Extract<QuackMessage, { type: T }>;
}

function attachColumnNames(chunks: readonly QuackDataChunk[], names: readonly string[]): QuackDataChunk[] {
  return chunks.map((chunk) => ({ ...chunk, columnNames: [...names] }));
}

function isChunkArray(data: QuackDataChunk | readonly QuackDataChunk[]): data is readonly QuackDataChunk[] {
  return Array.isArray(data);
}

/** Split chunks into SEND_DATA batches of at most {@link APPEND_BATCH_ROWS} rows, each chunk at most 2048 rows. */
function appendBatches(chunks: readonly QuackDataChunk[]): QuackDataChunk[][] {
  const batches: QuackDataChunk[][] = [];
  let current: QuackDataChunk[] = [];
  let currentRows = 0;
  for (const chunk of chunks) {
    for (let offset = 0; offset < chunk.rowCount; offset += STANDARD_VECTOR_SIZE) {
      const slice = sliceChunk(chunk, offset, Math.min(chunk.rowCount, offset + STANDARD_VECTOR_SIZE));
      if (currentRows + slice.rowCount > APPEND_BATCH_ROWS && current.length > 0) {
        batches.push(current);
        current = [];
        currentRows = 0;
      }
      current.push(slice);
      currentRows += slice.rowCount;
    }
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function sliceChunk(chunk: QuackDataChunk, start: number, end: number): QuackDataChunk {
  if (start === 0 && end === chunk.rowCount) {
    return chunk;
  }
  return {
    ...chunk,
    rowCount: end - start,
    columns: chunk.columns.map((column) => ({ ...column, values: column.values.slice(start, end) }))
  };
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < length; index++) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

/** Generate a random, nonzero 128-bit query id. Zero is reserved for internal server traffic. */
function randomQueryUuid(): HugeIntParts {
  for (;;) {
    const view = new DataView(randomBytes(16).buffer);
    const upper = view.getBigInt64(0, true);
    const lower = view.getBigUint64(8, true);
    if (upper !== 0n || lower !== 0n) {
      return { upper, lower };
    }
  }
}

function randomStreamId(): string {
  return [...randomBytes(16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Let Node exit while only the heartbeat timer is pending; browsers return plain timer ids. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle = timer as unknown as { unref?: () => void } | number;
  if (typeof handle === "object" && typeof handle.unref === "function") {
    handle.unref();
  }
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
    "useGeoJSON" in value ||
    "duckTypes" in value ||
    "format" in value ||
    "codec" in value
  );
}

function isQueryOptions(value: object): value is QuackQueryOptions {
  return "params" in value || "signal" in value || "timeoutMs" in value || "inlineRows" in value;
}

function normalizeAppendArgs(
  table: string | TableReference,
  schemaOrOptions: string | AppendOptions | QuackRequestOptions | undefined
): { target: string; options: QuackRequestOptions } {
  const tableRef: TableReference = typeof table === "string" ? { table } : table;
  const options = typeof schemaOrOptions === "string" ? {} : schemaOrOptions ?? {};
  const schemaName = typeof schemaOrOptions === "string" ? schemaOrOptions : (options as AppendOptions).schema ?? tableRef.schema;
  if (!tableRef.table) {
    throw new QuackProtocolError("append requires a table name");
  }
  const parts = [
    ...(tableRef.catalog === undefined ? [] : [tableRef.catalog]),
    ...(schemaName === undefined ? [] : [schemaName]),
    tableRef.table
  ];
  return {
    target: parts.map(quoteIdentifier).join("."),
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
