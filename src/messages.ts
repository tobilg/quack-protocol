import { BinaryReader, BinaryWriter } from "./binary";
import type { HugeIntLike, HugeIntParts } from "./binary";
import { OPTIONAL_INDEX_INVALID } from "./constants";
import { QuackProtocolError } from "./errors";
import { decodeLogicalType, encodeLogicalType } from "./logical-types";
import type { LogicalType } from "./logical-types";
import { decodeDataChunkWrapper, encodeDataChunkWrapper } from "./vector";
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
  APPEND_REQUEST = 9,
  SUCCESS_RESPONSE = 10,
  DISCONNECT_MESSAGE = 11,
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
}

/** Response returned by a server after opening a Quack connection. */
export interface ConnectionResponseMessage extends BaseMessage<MessageType.CONNECTION_RESPONSE> {
  /** Server DuckDB version string. */
  serverDuckdbVersion?: string;
  /** Server platform string. */
  serverPlatform?: string;
  /** Negotiated/reported Quack protocol version. */
  quackVersion?: bigint;
}

/** Request to prepare and execute SQL. */
export interface PrepareRequestMessage extends BaseMessage<MessageType.PREPARE_REQUEST> {
  /** SQL text to execute. */
  sql: string;
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
  /** Server-side result id for subsequent fetch requests. */
  resultUuid: HugeIntParts;
}

/** Request to fetch additional chunks for a previous result. */
export interface FetchRequestMessage extends BaseMessage<MessageType.FETCH_REQUEST> {
  /** Result id returned by a prepare response. */
  resultUuid: HugeIntLike;
}

/** Response containing additional result chunks. */
export interface FetchResponseMessage extends BaseMessage<MessageType.FETCH_RESPONSE> {
  /** Fetched result chunks. */
  results: QuackDataChunk[];
  /** Optional server batch index. */
  batchIndex?: bigint;
}

/** Request to append a DataChunk into a DuckDB table. */
export interface AppendRequestMessage extends BaseMessage<MessageType.APPEND_REQUEST> {
  /** Optional schema name. */
  schemaName?: string;
  /** Target table name. */
  tableName: string;
  /** DataChunk to append. */
  appendChunk: QuackDataChunk;
}

/** Generic success response. */
export interface SuccessResponseMessage extends BaseMessage<MessageType.SUCCESS_RESPONSE> {}

/** Message requesting that the server close the connection. */
export interface DisconnectMessage extends BaseMessage<MessageType.DISCONNECT_MESSAGE> {}

/** Server error response. */
export interface ErrorResponseMessage extends BaseMessage<MessageType.ERROR_RESPONSE> {
  /** Server-provided error message. */
  message: string;
}

/** Union of all Quack protocol messages supported by this SDK. */
export type QuackMessage =
  | ConnectionRequestMessage
  | ConnectionResponseMessage
  | PrepareRequestMessage
  | PrepareResponseMessage
  | FetchRequestMessage
  | FetchResponseMessage
  | AppendRequestMessage
  | SuccessResponseMessage
  | DisconnectMessage
  | ErrorResponseMessage;

/** Encode a Quack protocol message into its binary wire representation. */
export function encodeMessage(message: QuackMessage): Uint8Array {
  const writer = new BinaryWriter();
  encodeHeader(writer, message);
  encodeBody(writer, message);
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
      });
      return;
    case MessageType.CONNECTION_RESPONSE:
      writer.writeObject((object) => {
        writeOptionalString(object, 1, message.serverDuckdbVersion);
        writeOptionalString(object, 2, message.serverPlatform);
        if (message.quackVersion !== undefined) {
          object.writeField(3, () => object.writeUleb(message.quackVersion as bigint));
        }
      });
      return;
    case MessageType.PREPARE_REQUEST:
      writer.writeObject((object) => writeOptionalString(object, 1, message.sql));
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
        object.writeField(5, () => object.writeHugeInt(message.resultUuid));
      });
      return;
    case MessageType.FETCH_REQUEST:
      writer.writeObject((object) => {
        object.writeField(1, () => object.writeHugeInt(message.resultUuid));
      });
      return;
    case MessageType.FETCH_RESPONSE:
      writer.writeObject((object) => {
        if (message.results.length) {
          object.writeField(1, () => writeChunkPointerList(object, message.results));
        }
        object.writeField(2, () => object.writeUleb(message.batchIndex ?? OPTIONAL_INDEX_INVALID));
      });
      return;
    case MessageType.APPEND_REQUEST:
      writer.writeObject((object) => {
        writeOptionalString(object, 1, message.schemaName);
        writeOptionalString(object, 2, message.tableName);
        object.writeField(3, () => object.writeNullable(message.appendChunk, (chunk) => encodeDataChunkWrapper(object, chunk)));
      });
      return;
    case MessageType.SUCCESS_RESPONSE:
    case MessageType.DISCONNECT_MESSAGE:
      writer.writeObject(() => undefined);
      return;
    case MessageType.ERROR_RESPONSE:
      writer.writeObject((object) => writeOptionalString(object, 1, message.message));
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
        maxSupportedQuackVersion: object.readOptionalField(5, () => object.readUlebBigInt(), 0n)
      }));
    case MessageType.CONNECTION_RESPONSE:
      return reader.readObject((object) => ({
        ...header,
        type: MessageType.CONNECTION_RESPONSE,
        ...optionalProp("serverDuckdbVersion", object.readOptionalField(1, () => object.readString(), undefined)),
        ...optionalProp("serverPlatform", object.readOptionalField(2, () => object.readString(), undefined)),
        ...optionalProp("quackVersion", object.readOptionalField(3, () => object.readUlebBigInt(), undefined))
      }));
    case MessageType.PREPARE_REQUEST:
      return reader.readObject((object) => ({
        ...header,
        type: MessageType.PREPARE_REQUEST,
        sql: object.readOptionalField(1, () => object.readString(), "")
      }));
    case MessageType.PREPARE_RESPONSE:
      return reader.readObject((object) => ({
        ...header,
        type: MessageType.PREPARE_RESPONSE,
        resultTypes: object.readOptionalField(1, () => object.readList(() => decodeLogicalType(object)), []),
        resultNames: object.readOptionalField(2, () => object.readList(() => object.readString()), []),
        needsMoreFetch: object.readOptionalField(3, () => object.readBool(), false),
        results: object.readOptionalField(4, () => readChunkPointerList(object), []),
        resultUuid: object.readRequiredField(5, () => object.readHugeInt())
      }));
    case MessageType.FETCH_REQUEST:
      return reader.readObject((object) => ({
        ...header,
        type: MessageType.FETCH_REQUEST,
        resultUuid: object.readRequiredField(1, () => object.readHugeInt())
      }));
    case MessageType.FETCH_RESPONSE:
      return reader.readObject((object) => {
        const results = object.readOptionalField(1, () => readChunkPointerList(object), []);
        const batchIndex = object.readRequiredField(2, () => object.readUlebBigInt());
        return {
          ...header,
          type: MessageType.FETCH_RESPONSE,
          results,
          ...(batchIndex === OPTIONAL_INDEX_INVALID ? {} : { batchIndex })
        };
      });
    case MessageType.APPEND_REQUEST:
      return reader.readObject((object) => {
        const schemaName = object.readOptionalField(1, () => object.readString(), undefined);
        const tableName = object.readOptionalField(2, () => object.readString(), "");
        const appendChunk = object.readOptionalField(
          3,
          () => object.readNullable(() => decodeDataChunkWrapper(object)),
          undefined
        );
        if (!appendChunk) {
          throw new QuackProtocolError("APPEND_REQUEST is missing append_chunk");
        }
        return {
          ...header,
          type: MessageType.APPEND_REQUEST,
          ...optionalProp("schemaName", schemaName),
          tableName,
          appendChunk
        };
      });
    case MessageType.SUCCESS_RESPONSE:
      return reader.readObject(() => ({ ...header, type: MessageType.SUCCESS_RESPONSE }));
    case MessageType.DISCONNECT_MESSAGE:
      return reader.readObject(() => ({ ...header, type: MessageType.DISCONNECT_MESSAGE }));
    case MessageType.ERROR_RESPONSE:
      return reader.readObject((object) => ({
        ...header,
        type: MessageType.ERROR_RESPONSE,
        message: object.readOptionalField(1, () => object.readString(), "")
      }));
    default:
      throw new QuackProtocolError(`Cannot decode unsupported message type ${header.type}`);
  }
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

function optionalProp<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: T };
}
