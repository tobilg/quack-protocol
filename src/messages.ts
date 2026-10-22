import { BinaryReader, BinaryWriter } from "./binary";
import type { HugeIntLike, HugeIntParts } from "./binary";
import { OPTIONAL_INDEX_INVALID } from "./constants";
import { QuackProtocolError } from "./errors";
import { decodeLogicalType, encodeLogicalType } from "./logical-types";
import type { LogicalType } from "./logical-types";
import { decodeDataChunk, decodeDataChunkWrapper, encodeDataChunk, encodeDataChunkWrapper } from "./vector";
import type { QuackDataChunk } from "./vector";

/** Quack protocol message type ids. */
export enum MessageType {
  INVALID = 0,
  CONNECTION_REQUEST = 1,
  CONNECTION_RESPONSE = 2,
  PREPARE_REQUEST = 3,
  PREPARE_RESPONSE = 4,
  FETCH_REQUEST = 7,
  FETCH_RESPONSE = 8,
  SEND_DATA_REQUEST = 9,
  SUCCESS_RESPONSE = 10,
  DISCONNECT_MESSAGE = 11,
  CANCEL_REQUEST = 12,
  SEND_DATA_RESPONSE = 14,
  ACKNOWLEDGEMENT = 15,
  HEARTBEAT_REQUEST = 16,
  ERROR_RESPONSE = 100
}

/** Fields shared by every Quack protocol message header. */
export interface MessageHeader {
  /** Message type id. */
  type: MessageType;
  /** Server-assigned connection id for connection-scoped messages. */
  connectionId?: string;
  /** Client-assigned query/request id. */
  clientQueryId?: bigint;
}

/** Base type for a concrete Quack protocol message. */
export interface BaseMessage<T extends MessageType> extends MessageHeader {
  /** Concrete message type id. */
  type: T;
}

/** Request sent by a client to open a Quack connection. */
export interface ConnectionRequestMessage extends BaseMessage<MessageType.CONNECTION_REQUEST> {
  /** Optional authentication token. */
  authString?: string;
  /** Optional client DuckDB version. */
  clientDuckdbVersion?: string;
  /** Optional client platform string. */
  clientPlatform?: string;
  /** Minimum supported Quack protocol version. */
  minSupportedQuackVersion?: number | bigint;
  /** Maximum supported Quack protocol version. */
  maxSupportedQuackVersion?: number | bigint;
  /** Optional stable client identifier used by the server for reconnects; at least 4 characters. */
  clientId?: string;
  /** Requested heartbeat lease timeout in seconds. The server rejects 0. */
  heartbeatTimeoutSeconds?: number | bigint;
}

/** Response returned by a server after opening a Quack connection. */
export interface ConnectionResponseMessage extends BaseMessage<MessageType.CONNECTION_RESPONSE> {
  /** Server DuckDB version string. */
  serverDuckdbVersion?: string;
  /** Server platform string. */
  serverPlatform?: string;
  /** Negotiated/reported Quack protocol version. */
  quackVersion?: bigint;
  /** Heartbeat lease timeout in seconds accepted by the server. */
  heartbeatTimeoutSeconds?: bigint;
}

/** Request to prepare and execute SQL. */
export interface PrepareRequestMessage extends BaseMessage<MessageType.PREPARE_REQUEST> {
  /** SQL text to execute. */
  sql: string;
  /** Client-chosen query id used by fetch, cancel, and acknowledgement requests. Must be nonzero for client queries. */
  queryUuid: HugeIntLike;
  /** Maximum rows the prepare response may carry inline. Unset uses the server setting. */
  inlineRows?: number | bigint;
}

/** Response containing result schema, initial chunks, and fetch state. */
export interface PrepareResponseMessage extends BaseMessage<MessageType.PREPARE_RESPONSE> {
  /** Logical types for result columns. */
  resultTypes: LogicalType[];
  /** Result column names. */
  resultNames: string[];
  /** Whether more result chunks can be fetched. */
  needsMoreFetch: boolean;
  /** Initial result chunks. */
  results: QuackDataChunk[];
  /** Query id echoed from the prepare request. */
  queryUuid: HugeIntParts;
}

/** Request to fetch one batch of a previously prepared result. */
export interface FetchRequestMessage extends BaseMessage<MessageType.FETCH_REQUEST> {
  /** Query id from the prepare request. */
  queryUuid: HugeIntLike;
  /** 1-based batch index after the batches returned inline by the prepare response. */
  batchIndex: number | bigint;
  /** All batches 1..ackIndex have been received; the server may release them. */
  ackIndex?: number | bigint;
}

/** Response containing one batch of result chunks, or the end of the result. */
export interface FetchResponseMessage extends BaseMessage<MessageType.FETCH_RESPONSE> {
  /** Fetched result chunks. Empty on the terminal response. */
  results: QuackDataChunk[];
  /** Batch index echoed from the request. Present on data responses. */
  batchIndex?: bigint;
  /** Total batch count of the result. Present on the terminal response. */
  totalBatches?: bigint;
}

/** One batch of client data for a statement reading `scan_data_from_quack_client`. */
export interface SendDataRequestMessage extends BaseMessage<MessageType.SEND_DATA_REQUEST> {
  /** Stream id named in the statement's `scan_data_from_quack_client` call. */
  streamId: string;
  /** Chunks carried by this batch. Empty on the terminal message. */
  chunks: QuackDataChunk[];
  /** 1-based batch index. Unset on the terminal message. */
  batchIndex?: number | bigint;
  /** Batch count of the whole stream. Only the terminal message sets it. */
  totalBatches?: number | bigint;
}

/** Success reply to a send-data request. */
export interface SendDataResponseMessage extends BaseMessage<MessageType.SEND_DATA_RESPONSE> {
  /** Reserved flow-control hint; unset means unbounded. */
  acceptBudget?: bigint;
}

/** Generic success response. */
export interface SuccessResponseMessage extends BaseMessage<MessageType.SUCCESS_RESPONSE> {}

/** Message requesting that the server close the connection. */
export interface DisconnectMessage extends BaseMessage<MessageType.DISCONNECT_MESSAGE> {}

/** Request to cancel a running query. */
export interface CancelRequestMessage extends BaseMessage<MessageType.CANCEL_REQUEST> {
  /** Query id to cancel. `0` cancels whatever query runs on the connection. */
  queryUuid: HugeIntLike;
}

/** Confirms that a result was fully received, releasing the server's reconnect cache. */
export interface AcknowledgementMessage extends BaseMessage<MessageType.ACKNOWLEDGEMENT> {
  /** Query id of the acknowledged result. */
  queryUuid: HugeIntLike;
}

/** Renews the connection's heartbeat lease. */
export interface HeartbeatRequestMessage extends BaseMessage<MessageType.HEARTBEAT_REQUEST> {}

/** Server error response. */
export interface ErrorResponseMessage extends BaseMessage<MessageType.ERROR_RESPONSE> {
  /** Server-provided error message. */
  message: string;
  /** DuckDB exception type name, such as `Catalog` or `Invalid Input`. */
  exceptionType?: string;
  /** Additional DuckDB error metadata. */
  extraInfo?: Record<string, string>;
  /** Whether the server's database has been invalidated and the connection must not be reused. */
  mustInvalidate?: boolean;
}

/** Union of all Quack protocol messages supported by this SDK. */
export type QuackMessage =
  | ConnectionRequestMessage
  | ConnectionResponseMessage
  | PrepareRequestMessage
  | PrepareResponseMessage
  | FetchRequestMessage
  | FetchResponseMessage
  | SendDataRequestMessage
  | SendDataResponseMessage
  | SuccessResponseMessage
  | DisconnectMessage
  | CancelRequestMessage
  | AcknowledgementMessage
  | HeartbeatRequestMessage
  | ErrorResponseMessage;

/** Encode a Quack protocol message into its binary wire representation. */
export function encodeMessage(message: QuackMessage): Uint8Array {
  const writer = new BinaryWriter();
  encodeHeader(writer, message);
  encodeBody(writer, message);
  encodeChunkBlob(writer, message);
  return writer.toUint8Array();
}

/** Decode a Quack protocol message from its binary wire representation. */
export function decodeMessage(bytes: Uint8Array): QuackMessage {
  const reader = new BinaryReader(bytes);
  const header = decodeHeader(reader);
  const message = decodeBody(reader, header);
  reader.assertEof();
  return message;
}

/** Encode a Quack message header. */
export function encodeHeader(writer: BinaryWriter, header: MessageHeader): void {
  writer.writeObject((object) => {
    object.writeField(1, () => object.writeUleb(header.type));
    if (header.connectionId) {
      object.writeField(2, () => object.writeString(header.connectionId as string));
    }
    object.writeField(3, () => object.writeUleb(header.clientQueryId ?? OPTIONAL_INDEX_INVALID));
  });
}

/** Decode a Quack message header. */
export function decodeHeader(reader: BinaryReader): MessageHeader {
  return reader.readObject((object) => {
    const type = object.readRequiredField(1, () => object.readUlebNumber()) as MessageType;
    const connectionId = object.readOptionalField(2, () => object.readString(), "");
    const clientQueryIdRaw = object.readRequiredField(3, () => object.readUlebBigInt());
    return {
      type,
      ...(connectionId ? { connectionId } : {}),
      ...(clientQueryIdRaw === OPTIONAL_INDEX_INVALID ? {} : { clientQueryId: clientQueryIdRaw })
    };
  });
}

function encodeBody(writer: BinaryWriter, message: QuackMessage): void {
  switch (message.type) {
    case MessageType.CONNECTION_REQUEST:
      writer.writeObject((object) => {
        writeOptionalString(object, 1, message.authString);
        writeOptionalString(object, 2, message.clientDuckdbVersion);
        writeOptionalString(object, 3, message.clientPlatform);
        writeOptionalIndexDefaultZero(object, 4, message.minSupportedQuackVersion);
        writeOptionalIndexDefaultZero(object, 5, message.maxSupportedQuackVersion);
        writeOptionalString(object, 6, message.clientId);
        writeOptionalIndexDefaultZero(object, 7, message.heartbeatTimeoutSeconds);
      });
      return;
    case MessageType.CONNECTION_RESPONSE:
      writer.writeObject((object) => {
        writeOptionalString(object, 1, message.serverDuckdbVersion);
        writeOptionalString(object, 2, message.serverPlatform);
        writeOptionalIndexDefaultZero(object, 3, message.quackVersion);
        writeOptionalIndexDefaultZero(object, 4, message.heartbeatTimeoutSeconds);
      });
      return;
    case MessageType.PREPARE_REQUEST:
      writer.writeObject((object) => {
        writeOptionalString(object, 1, message.sql);
        object.writeField(2, () => object.writeHugeInt(message.queryUuid));
        writeOptionalIdx(object, 3, message.inlineRows);
      });
      return;
    case MessageType.PREPARE_RESPONSE:
      writer.writeObject((object) => {
        if (message.resultTypes.length) {
          object.writeField(1, () => object.writeList(message.resultTypes, (type) => encodeLogicalType(object, type)));
        }
        if (message.resultNames.length) {
          object.writeField(2, () => object.writeList(message.resultNames, (name) => object.writeString(name)));
        }
        if (message.needsMoreFetch) {
          object.writeField(3, () => object.writeBool(message.needsMoreFetch));
        }
        if (message.results.length) {
          object.writeField(4, () => writeChunkPointerList(object, message.results));
        }
        object.writeField(5, () => object.writeHugeInt(message.queryUuid));
      });
      return;
    case MessageType.FETCH_REQUEST:
      writer.writeObject((object) => {
        object.writeField(1, () => object.writeHugeInt(message.queryUuid));
        writeOptionalIndexDefaultZero(object, 2, message.batchIndex);
        writeOptionalIndexDefaultZero(object, 3, message.ackIndex);
      });
      return;
    case MessageType.FETCH_RESPONSE:
      writer.writeObject((object) => {
        writeOptionalIndexDefaultZero(object, 1, message.results.length);
        writeOptionalIdx(object, 2, message.totalBatches);
        writeOptionalIdx(object, 3, message.batchIndex);
      });
      return;
    case MessageType.SEND_DATA_REQUEST:
      writer.writeObject((object) => {
        writeOptionalString(object, 1, message.streamId);
        writeOptionalIndexDefaultZero(object, 2, message.chunks.length);
        writeOptionalIdx(object, 3, message.totalBatches);
        writeOptionalIdx(object, 4, message.batchIndex);
      });
      return;
    case MessageType.SEND_DATA_RESPONSE:
      writer.writeObject((object) => {
        object.writeField(1, () => object.writeUleb(message.acceptBudget ?? OPTIONAL_INDEX_INVALID));
      });
      return;
    case MessageType.CANCEL_REQUEST:
      writer.writeObject((object) => {
        object.writeField(1, () => object.writeHugeInt(message.queryUuid));
      });
      return;
    case MessageType.ACKNOWLEDGEMENT:
      writer.writeObject((object) => {
        if (!isZeroHugeInt(message.queryUuid)) {
          object.writeField(1, () => object.writeHugeInt(message.queryUuid));
        }
      });
      return;
    case MessageType.SUCCESS_RESPONSE:
    case MessageType.DISCONNECT_MESSAGE:
    case MessageType.HEARTBEAT_REQUEST:
      writer.writeObject(() => undefined);
      return;
    case MessageType.ERROR_RESPONSE:
      writer.writeObject((object) => {
        writeOptionalString(object, 1, message.message);
        writeOptionalString(object, 2, message.exceptionType);
        const extraInfo = Object.entries(message.extraInfo ?? {});
        if (extraInfo.length) {
          object.writeField(3, () =>
            object.writeList(extraInfo, ([key, value]) =>
              object.writeObject((pair) => {
                pair.writeField(0, () => pair.writeString(key));
                pair.writeField(1, () => pair.writeString(value));
              })
            )
          );
        }
        if (message.mustInvalidate) {
          object.writeField(4, () => object.writeBool(true));
        }
      });
      return;
    default:
      throw new QuackProtocolError(`Cannot encode unsupported message type ${(message as MessageHeader).type}`);
  }
}

function decodeBody(reader: BinaryReader, header: MessageHeader): QuackMessage {
  switch (header.type) {
    case MessageType.CONNECTION_REQUEST:
      return reader.readObject((object) => ({
        ...header,
        type: MessageType.CONNECTION_REQUEST,
        ...optionalProp("authString", object.readOptionalField(1, () => object.readString(), undefined)),
        ...optionalProp("clientDuckdbVersion", object.readOptionalField(2, () => object.readString(), undefined)),
        ...optionalProp("clientPlatform", object.readOptionalField(3, () => object.readString(), undefined)),
        minSupportedQuackVersion: object.readOptionalField(4, () => object.readUlebBigInt(), 0n),
        maxSupportedQuackVersion: object.readOptionalField(5, () => object.readUlebBigInt(), 0n),
        ...optionalProp("clientId", object.readOptionalField(6, () => object.readString(), undefined)),
        heartbeatTimeoutSeconds: object.readOptionalField(7, () => object.readUlebBigInt(), 0n)
      }));
    case MessageType.CONNECTION_RESPONSE:
      return reader.readObject((object) => ({
        ...header,
        type: MessageType.CONNECTION_RESPONSE,
        ...optionalProp("serverDuckdbVersion", object.readOptionalField(1, () => object.readString(), undefined)),
        ...optionalProp("serverPlatform", object.readOptionalField(2, () => object.readString(), undefined)),
        ...optionalProp("quackVersion", object.readOptionalField(3, () => object.readUlebBigInt(), undefined)),
        ...optionalProp("heartbeatTimeoutSeconds", object.readOptionalField(4, () => object.readUlebBigInt(), undefined))
      }));
    case MessageType.PREPARE_REQUEST:
      return reader.readObject((object) => {
        const sql = object.readOptionalField(1, () => object.readString(), "");
        const queryUuid = object.readRequiredField(2, () => object.readHugeInt());
        const inlineRows = readOptionalIdx(object, 3);
        return {
          ...header,
          type: MessageType.PREPARE_REQUEST,
          sql,
          queryUuid,
          ...optionalProp("inlineRows", inlineRows)
        };
      });
    case MessageType.PREPARE_RESPONSE:
      return reader.readObject((object) => ({
        ...header,
        type: MessageType.PREPARE_RESPONSE,
        resultTypes: object.readOptionalField(1, () => object.readList(() => decodeLogicalType(object)), []),
        resultNames: object.readOptionalField(2, () => object.readList(() => object.readString()), []),
        needsMoreFetch: object.readOptionalField(3, () => object.readBool(), false),
        results: object.readOptionalField(4, () => readChunkPointerList(object), []),
        queryUuid: object.readRequiredField(5, () => object.readHugeInt())
      }));
    case MessageType.FETCH_REQUEST:
      return reader.readObject((object) => ({
        ...header,
        type: MessageType.FETCH_REQUEST,
        queryUuid: object.readRequiredField(1, () => object.readHugeInt()),
        batchIndex: object.readOptionalField(2, () => object.readUlebBigInt(), 0n),
        ackIndex: object.readOptionalField(3, () => object.readUlebBigInt(), 0n)
      }));
    case MessageType.FETCH_RESPONSE: {
      const body = reader.readObject((object) => ({
        chunkCount: object.readOptionalField(1, () => object.readUlebNumber(), 0),
        totalBatches: readOptionalIdx(object, 2),
        batchIndex: readOptionalIdx(object, 3)
      }));
      return {
        ...header,
        type: MessageType.FETCH_RESPONSE,
        results: readChunkBlob(reader, body.chunkCount),
        ...optionalProp("batchIndex", body.batchIndex),
        ...optionalProp("totalBatches", body.totalBatches)
      };
    }
    case MessageType.SEND_DATA_REQUEST: {
      const body = reader.readObject((object) => ({
        streamId: object.readOptionalField(1, () => object.readString(), ""),
        chunkCount: object.readOptionalField(2, () => object.readUlebNumber(), 0),
        totalBatches: readOptionalIdx(object, 3),
        batchIndex: readOptionalIdx(object, 4)
      }));
      return {
        ...header,
        type: MessageType.SEND_DATA_REQUEST,
        streamId: body.streamId,
        chunks: readChunkBlob(reader, body.chunkCount),
        ...optionalProp("batchIndex", body.batchIndex),
        ...optionalProp("totalBatches", body.totalBatches)
      };
    }
    case MessageType.SEND_DATA_RESPONSE:
      return reader.readObject((object) => ({
        ...header,
        type: MessageType.SEND_DATA_RESPONSE,
        ...optionalProp("acceptBudget", readOptionalIdx(object, 1))
      }));
    case MessageType.CANCEL_REQUEST:
      return reader.readObject((object) => ({
        ...header,
        type: MessageType.CANCEL_REQUEST,
        queryUuid: object.readRequiredField(1, () => object.readHugeInt())
      }));
    case MessageType.ACKNOWLEDGEMENT:
      return reader.readObject((object) => ({
        ...header,
        type: MessageType.ACKNOWLEDGEMENT,
        queryUuid: object.readOptionalField(1, () => object.readHugeInt(), { upper: 0n, lower: 0n })
      }));
    case MessageType.SUCCESS_RESPONSE:
      return reader.readObject(() => ({ ...header, type: MessageType.SUCCESS_RESPONSE }));
    case MessageType.DISCONNECT_MESSAGE:
      return reader.readObject(() => ({ ...header, type: MessageType.DISCONNECT_MESSAGE }));
    case MessageType.HEARTBEAT_REQUEST:
      return reader.readObject(() => ({ ...header, type: MessageType.HEARTBEAT_REQUEST }));
    case MessageType.ERROR_RESPONSE:
      return reader.readObject((object) => {
        const message = object.readOptionalField(1, () => object.readString(), "");
        const exceptionType = object.readOptionalField(2, () => object.readString(), undefined);
        const extraInfo = object.readOptionalField(3, () => readStringMap(object), undefined);
        const mustInvalidate = object.readOptionalField(4, () => object.readBool(), false);
        return {
          ...header,
          type: MessageType.ERROR_RESPONSE,
          message,
          ...optionalProp("exceptionType", exceptionType),
          ...optionalProp("extraInfo", extraInfo),
          ...(mustInvalidate ? { mustInvalidate } : {})
        };
      });
    default:
      throw new QuackProtocolError(`Cannot decode unsupported message type ${header.type}`);
  }
}

/** Write the raw chunk blob that follows chunk-carrying messages. */
function encodeChunkBlob(writer: BinaryWriter, message: QuackMessage): void {
  const chunks =
    message.type === MessageType.FETCH_RESPONSE
      ? message.results
      : message.type === MessageType.SEND_DATA_REQUEST
        ? message.chunks
        : [];
  for (const chunk of chunks) {
    encodeDataChunk(writer, chunk);
  }
}

function readChunkBlob(reader: BinaryReader, chunkCount: number): QuackDataChunk[] {
  const chunks: QuackDataChunk[] = [];
  for (let index = 0; index < chunkCount; index++) {
    chunks.push(decodeDataChunk(reader));
  }
  return chunks;
}

function readChunkPointerList(reader: BinaryReader): QuackDataChunk[] {
  return reader.readList(() => {
    const chunk = reader.readNullable(() => decodeDataChunkWrapper(reader));
    if (!chunk) {
      throw new QuackProtocolError("Encountered null DataChunk pointer in result list");
    }
    return chunk;
  });
}

function writeChunkPointerList(writer: BinaryWriter, chunks: readonly QuackDataChunk[]): void {
  writer.writeList(chunks, (chunk) => writer.writeNullable(chunk, (value) => encodeDataChunkWrapper(writer, value)));
}

function readStringMap(reader: BinaryReader): Record<string, string> {
  const result: Record<string, string> = {};
  reader.readList(() =>
    reader.readObject((pair) => {
      const key = pair.readRequiredField(0, () => pair.readString());
      result[key] = pair.readRequiredField(1, () => pair.readString());
    })
  );
  return result;
}

function writeOptionalString(writer: BinaryWriter, fieldId: number, value: string | undefined): void {
  if (value !== undefined && value !== "") {
    writer.writeField(fieldId, () => writer.writeString(value));
  }
}

function writeOptionalIndexDefaultZero(writer: BinaryWriter, fieldId: number, value: number | bigint | undefined): void {
  if (value !== undefined && BigInt(value) !== 0n) {
    writer.writeField(fieldId, () => writer.writeUleb(value));
  }
}

/** Write a DuckDB `optional_idx` property that is omitted when unset. */
function writeOptionalIdx(writer: BinaryWriter, fieldId: number, value: number | bigint | undefined): void {
  if (value !== undefined) {
    writer.writeField(fieldId, () => writer.writeUleb(value));
  }
}

/** Read a DuckDB `optional_idx` property, mapping absent and invalid values to `undefined`. */
function readOptionalIdx(reader: BinaryReader, fieldId: number): bigint | undefined {
  const value = reader.readOptionalField(fieldId, () => reader.readUlebBigInt(), OPTIONAL_INDEX_INVALID);
  return value === OPTIONAL_INDEX_INVALID ? undefined : value;
}

function isZeroHugeInt(value: HugeIntLike): boolean {
  return typeof value === "bigint" ? value === 0n : value.upper === 0n && value.lower === 0n;
}

function optionalProp<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: T };
}
