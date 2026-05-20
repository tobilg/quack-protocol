import {
  batchType,
  binary,
  bool,
  Column,
  CompressionType,
  dateDay,
  decimal128,
  decimal256,
  decimal32,
  decimal64,
  Endianness,
  fixedSizeList,
  float32,
  float64,
  int16,
  int32,
  int64,
  int8,
  interval,
  IntervalUnit,
  largeBinary,
  largeList,
  largeUtf8,
  list,
  map,
  nullType,
  struct,
  Table,
  tableFromIPC,
  tableToIPC,
  timeMicrosecond,
  timeNanosecond,
  timestamp,
  TimeUnit,
  Type,
  uint16,
  uint32,
  uint64,
  uint8,
  utf8,
  Version
} from "@uwdata/flechette";
import type {
  Batch,
  CompressionType_,
  DataType,
  ExtractionOptions,
  Field,
  Schema,
  TypedArray
} from "@uwdata/flechette";
import { QuackProtocolError, QuackUnsupportedTypeError } from "./errors";
import {
  ExtraTypeInfoType,
  getArraySize,
  getChildType,
  getEnumValues,
  getStructChildren,
  LogicalTypeId,
  LogicalTypes,
  logicalType
} from "./logical-types";
import type { ChildType, LogicalType } from "./logical-types";
import { dateFromJSDate, decimalValue, timestampFromJSDate } from "./values";
import { column, dataChunk } from "./builders";
import type { ColumnInput } from "./builders";
import type {
  DateValue,
  DecimalValue,
  IntervalValue,
  QuackDataChunk,
  QuackValue,
  TimeTzValue,
  TimeValue,
  TimestampValue
} from "./vector";

const textEncoder = new TextEncoder();
const QUACK_LOGICAL_TYPE_METADATA = "quack:logicalType";
const BIGINT_METADATA_KEY = "__quackBigInt";

/** Flechette extraction options accepted by Quack Arrow helpers. */
export interface QuackArrowOptions extends ExtractionOptions {}

/** Explicit DuckDB logical types for Arrow columns, by index or column name. */
export type QuackArrowDuckTypeSchema = readonly LogicalType[] | Record<string, LogicalType>;

/** Options for converting Quack chunks into a Flechette Arrow table. */
export interface QuackArrowTableOptions extends QuackArrowOptions {
  /** DuckDB logical types to use when chunks are empty or types should be overridden. */
  duckTypes?: readonly LogicalType[];
}

/** Options for encoding Quack results as Arrow IPC bytes. */
export interface QuackArrowIPCOptions extends QuackArrowTableOptions {
  /** Arrow IPC output format. Defaults to Flechette's stream format. */
  format?: "stream" | "file";
  /** Optional Flechette compression codec id. */
  codec?: CompressionType_ | null;
}

/** Options for converting Arrow input into Quack append chunks. */
export interface QuackArrowAppendOptions extends QuackArrowOptions {
  /** DuckDB logical types to use instead of inferring from Arrow schema metadata. */
  duckTypes?: QuackArrowDuckTypeSchema;
}

/** Arrow IPC input accepted by Flechette. */
export type QuackArrowIPCInput = ArrayBufferLike | Uint8Array | Uint8Array[];

/** Arrow input accepted by append helpers. */
export type QuackArrowInput = Table | QuackArrowIPCInput;

/** Re-export Flechette's compression enum for callers using Arrow IPC compression. */
export { CompressionType };

/** Re-export Flechette's Arrow table class for public SDK type narrowing. */
export { Table as ArrowTable };

/** Convert one Quack DataChunk into a Flechette Arrow table. */
export function arrowTableFromDataChunk(
  chunk: QuackDataChunk,
  columnNames = chunk.columnNames,
  options: QuackArrowTableOptions = {}
): Table {
  return arrowTableFromChunks([chunk], columnNames, options);
}

/** Convert Quack DataChunks into one Flechette Arrow table. */
export function arrowTableFromChunks(
  chunks: readonly QuackDataChunk[],
  columnNames?: readonly string[],
  options: QuackArrowTableOptions = {}
): Table {
  const duckTypes = options.duckTypes ?? chunks[0]?.types ?? [];
  const names = resolveColumnNames(columnNames, chunks[0], duckTypes.length);
  if (names.length !== duckTypes.length) {
    throw new QuackProtocolError(`Arrow conversion has ${names.length} column names but ${duckTypes.length} DuckDB types`);
  }
  const arrowOptions = extractionOptions(options);
  const fields = duckTypes.map((type, index) => arrowFieldFromLogicalType(names[index] ?? `column${index}`, type));
  const columns = fields.map((field, columnIndex) => {
    const type = duckTypes[columnIndex];
    if (!type) {
      throw new QuackProtocolError(`Missing DuckDB type for Arrow column ${columnIndex}`);
    }
    const batches = chunks.map((chunk) => {
      if (chunk.types.length !== duckTypes.length || chunk.columns.length !== duckTypes.length) {
        throw new QuackProtocolError("All Quack chunks converted to Arrow must have the same column count");
      }
      const columnData = chunk.columns[columnIndex];
      if (!columnData) {
        throw new QuackProtocolError(`Chunk is missing column ${columnIndex}`);
      }
      return arrowBatchFromValues(field.type, type, columnData.values, arrowOptions);
    });
    return new Column(batches, field.type);
  });
  const schema: Schema = {
    version: Version.V5,
    endianness: Endianness.Little,
    fields,
    metadata: null
  };
  return new Table(schema, columns, options.useProxy);
}

/** Convert Quack DataChunks into Arrow IPC bytes. */
export function arrowIPCFromChunks(
  chunks: readonly QuackDataChunk[],
  columnNames?: readonly string[],
  options: QuackArrowIPCOptions = {}
): Uint8Array {
  const table = arrowTableFromChunks(chunks, columnNames, options);
  return arrowIPCFromTable(table, options);
}

/** Encode a Flechette Arrow table as Arrow IPC bytes. */
export function arrowIPCFromTable(table: Table, options: QuackArrowIPCOptions = {}): Uint8Array {
  const ipcOptions = {
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.codec === undefined ? {} : { codec: options.codec })
  };
  const bytes = tableToIPC(table, ipcOptions);
  if (!bytes) {
    throw new QuackProtocolError("Arrow IPC encoding did not return in-memory bytes");
  }
  return bytes;
}

/** Convert Arrow IPC bytes into Quack append chunks. */
export function dataChunksFromArrowIPC(
  input: QuackArrowIPCInput,
  options: QuackArrowAppendOptions = {}
): QuackDataChunk[] {
  return dataChunksFromArrowTable(tableFromIPC(input, extractionOptions(options)), options);
}

/** Convert a Flechette Arrow table into Quack append chunks. */
export function dataChunksFromArrowTable(
  table: Table,
  options: QuackArrowAppendOptions = {}
): QuackDataChunk[] {
  if (table.numCols === 0) {
    throw new QuackProtocolError("Cannot convert an Arrow table with no columns to Quack append chunks");
  }
  const fields = table.schema.fields;
  const duckTypes = fields.map((field, index) => resolveDuckType(field, index, options.duckTypes));
  const batchCount = table.children[0]?.data.length ?? 0;

  if (batchCount === 0) {
    return [
      dataChunk(fields.map((field, index) => column(duckTypes[index]!, [], field.name)))
    ];
  }

  const chunks: QuackDataChunk[] = [];
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    const columns: ColumnInput[] = fields.map((field, columnIndex) => {
      const arrowColumn = table.children[columnIndex];
      const batch = arrowColumn?.data[batchIndex];
      const duckType = duckTypes[columnIndex];
      if (!arrowColumn || !batch || !duckType) {
        throw new QuackProtocolError(`Arrow table is missing batch ${batchIndex} for column ${field.name}`);
      }
      const values = Array.from({ length: batch.length }, (_, rowIndex) =>
        arrowValueToQuack(batch.at(rowIndex), duckType, field.type)
      );
      return column(duckType, values, field.name);
    });
    chunks.push(dataChunk(columns));
  }
  return chunks;
}

/** Convert either a Flechette table or Arrow IPC bytes into Quack append chunks. */
export function dataChunksFromArrow(input: QuackArrowInput, options: QuackArrowAppendOptions = {}): QuackDataChunk[] {
  return input instanceof Table
    ? dataChunksFromArrowTable(input, options)
    : dataChunksFromArrowIPC(input, options);
}

function arrowFieldFromLogicalType(name: string, type: LogicalType): Field {
  return {
    name,
    type: arrowTypeFromLogicalType(type),
    nullable: true,
    metadata: new Map([[QUACK_LOGICAL_TYPE_METADATA, serializeLogicalType(type)]])
  };
}

function arrowTypeFromLogicalType(type: LogicalType): DataType {
  switch (type.id) {
    case LogicalTypeId.SQLNULL:
      return nullType();
    case LogicalTypeId.BOOLEAN:
      return bool();
    case LogicalTypeId.TINYINT:
      return int8();
    case LogicalTypeId.SMALLINT:
      return int16();
    case LogicalTypeId.INTEGER:
      return int32();
    case LogicalTypeId.BIGINT:
      return int64();
    case LogicalTypeId.UTINYINT:
      return uint8();
    case LogicalTypeId.USMALLINT:
      return uint16();
    case LogicalTypeId.UINTEGER:
      return uint32();
    case LogicalTypeId.UBIGINT:
      return uint64();
    case LogicalTypeId.HUGEINT:
      return decimal128(38, 0);
    case LogicalTypeId.UHUGEINT:
      return decimal256(39, 0);
    case LogicalTypeId.FLOAT:
      return float32();
    case LogicalTypeId.DOUBLE:
      return float64();
    case LogicalTypeId.DECIMAL: {
      const { width, scale } = decimalTypeInfo(type);
      return width <= 9 ? decimal32(width, scale) : width <= 18 ? decimal64(width, scale) : decimal128(width, scale);
    }
    case LogicalTypeId.CHAR:
    case LogicalTypeId.VARCHAR:
    case LogicalTypeId.ENUM:
    case LogicalTypeId.UUID:
      return utf8();
    case LogicalTypeId.BLOB:
    case LogicalTypeId.BIT:
    case LogicalTypeId.GEOMETRY:
      return binary();
    case LogicalTypeId.DATE:
      return dateDay();
    case LogicalTypeId.TIME:
      return timeMicrosecond();
    case LogicalTypeId.TIME_NS:
      return timeNanosecond();
    case LogicalTypeId.TIME_TZ:
      return int64();
    case LogicalTypeId.TIMESTAMP_SEC:
      return timestamp(TimeUnit.SECOND);
    case LogicalTypeId.TIMESTAMP_MS:
      return timestamp(TimeUnit.MILLISECOND);
    case LogicalTypeId.TIMESTAMP:
      return timestamp(TimeUnit.MICROSECOND);
    case LogicalTypeId.TIMESTAMP_NS:
      return timestamp(TimeUnit.NANOSECOND);
    case LogicalTypeId.TIMESTAMP_TZ:
      return timestamp(TimeUnit.MICROSECOND, "UTC");
    case LogicalTypeId.INTERVAL:
      return interval(IntervalUnit.MONTH_DAY_NANO);
    case LogicalTypeId.LIST:
      return list(arrowFieldFromLogicalType("item", getChildType(type)));
    case LogicalTypeId.MAP: {
      const child = getChildType(type);
      const entries = getStructChildren(child);
      const key = entries.find((entry) => entry.name === "key") ?? entries[0];
      const value = entries.find((entry) => entry.name === "value") ?? entries[1];
      if (!key || !value) {
        throw new QuackProtocolError("DuckDB MAP type is missing key/value children");
      }
      return map(arrowFieldFromLogicalType("key", key.type), arrowFieldFromLogicalType("value", value.type));
    }
    case LogicalTypeId.STRUCT:
      return struct(getStructChildren(type).map((child) => arrowFieldFromLogicalType(child.name, child.type)));
    case LogicalTypeId.ARRAY:
      return fixedSizeList(arrowFieldFromLogicalType("item", getChildType(type)), getArraySize(type));
    default:
      throw new QuackUnsupportedTypeError(`Cannot map DuckDB logical type ${LogicalTypeId[type.id] ?? type.id} to Arrow`);
  }
}

function arrowBatchFromValues(
  arrowType: DataType,
  duckType: LogicalType,
  values: readonly QuackValue[],
  options: QuackArrowOptions
): Batch<unknown> {
  const length = values.length;
  const { validity, nullCount } = validityBitmap(values);
  const BatchCtor = batchType(arrowType, options) as new (options: Record<string, unknown>) => Batch<unknown>;
  const base = { length, nullCount, type: arrowType, validity };

  switch (arrowType.typeId) {
    case Type.Null:
      return new BatchCtor({ ...base, nullCount: length });
    case Type.Bool:
      return new BatchCtor({ ...base, values: booleanBitmap(values) });
    case Type.Int:
    case Type.Float:
    case Type.Date:
    case Type.Time:
    case Type.Timestamp:
    case Type.Decimal:
    case Type.Interval:
      return new BatchCtor({ ...base, values: fixedValues(arrowType, duckType, values) });
    case Type.Utf8:
    case Type.LargeUtf8:
      return new BatchCtor({ ...base, ...variableBytes(values, (value) => textEncoder.encode(String(value ?? ""))) });
    case Type.Binary:
    case Type.LargeBinary:
      return new BatchCtor({ ...base, ...variableBytes(values, bytesFromValue) });
    case Type.List:
    case Type.LargeList:
      return new BatchCtor({ ...base, ...listBuffers(arrowType, duckType, values, options) });
    case Type.Map:
      return new BatchCtor({ ...base, ...mapBuffers(arrowType, duckType, values, options) });
    case Type.Struct:
      return new BatchCtor({ ...base, children: structChildren(arrowType, duckType, values, options) });
    case Type.FixedSizeList:
      return new BatchCtor({ ...base, children: fixedSizeListChildren(arrowType, duckType, values, options) });
    default:
      throw new QuackUnsupportedTypeError(`Cannot build Arrow batch for type id ${arrowType.typeId}`);
  }
}

function fixedValues(arrowType: DataType, duckType: LogicalType, values: readonly QuackValue[]): TypedArray {
  switch (arrowType.typeId) {
    case Type.Int:
    case Type.Date:
    case Type.Time:
    case Type.Timestamp: {
      const ArrayType = arrowType.values;
      const data = new ArrayType(alignedLength(values.length, ArrayType.BYTES_PER_ELEMENT));
      values.forEach((value, index) => {
        data[index] = integerLikeValue(value, duckType, arrowType);
      });
      return data;
    }
    case Type.Float: {
      const ArrayType = arrowType.values;
      const data = new ArrayType(alignedLength(values.length, ArrayType.BYTES_PER_ELEMENT));
      values.forEach((value, index) => {
        data[index] = Number(value ?? 0);
      });
      return data;
    }
    case Type.Decimal:
      return decimalValues(arrowType, duckType, values);
    case Type.Interval:
      return intervalValues(values);
    default:
      throw new QuackUnsupportedTypeError(`Cannot create fixed Arrow values for type id ${arrowType.typeId}`);
  }
}

function integerLikeValue(value: QuackValue, duckType: LogicalType, arrowType: DataType): number | bigint {
  if (value === null) {
    return hasBigIntValues(arrowType) ? 0n : 0;
  }
  switch (duckType.id) {
    case LogicalTypeId.DATE:
      return (value as DateValue).days;
    case LogicalTypeId.TIME:
    case LogicalTypeId.TIME_NS:
      return BigInt((value as TimeValue).value);
    case LogicalTypeId.TIME_TZ:
      return BigInt((value as TimeTzValue).bits);
    case LogicalTypeId.TIMESTAMP:
    case LogicalTypeId.TIMESTAMP_SEC:
    case LogicalTypeId.TIMESTAMP_MS:
    case LogicalTypeId.TIMESTAMP_NS:
    case LogicalTypeId.TIMESTAMP_TZ:
      return BigInt((value as TimestampValue).value);
    default:
      return typeof value === "bigint" ? value : Number(value);
  }
}

function hasBigIntValues(type: DataType): boolean {
  return "values" in type && (type.values === BigInt64Array || type.values === BigUint64Array);
}

function decimalValues(arrowType: Extract<DataType, { typeId: typeof Type.Decimal }>, duckType: LogicalType, values: readonly QuackValue[]): TypedArray {
  const { scale } = decimalTypeInfo(duckType);
  if (arrowType.bitWidth === 32) {
    const data = new Int32Array(alignedLength(values.length, Int32Array.BYTES_PER_ELEMENT));
    values.forEach((value, index) => {
      data[index] = Number(decimalUnscaled(value, duckType, scale));
    });
    return data;
  }

  const stride = arrowType.bitWidth >> 6;
  const data = new BigUint64Array(alignedLength(values.length * stride, BigUint64Array.BYTES_PER_ELEMENT));
  values.forEach((value, index) => {
    const unscaled = decimalUnscaled(value, duckType, scale);
    const offset = index * stride;
    for (let word = 0; word < stride; word++) {
      data[offset + word] = unscaled >> BigInt(word * 64);
    }
  });
  return data;
}

function intervalValues(values: readonly QuackValue[]): Uint8Array {
  const data = new Uint8Array(alignedLength(values.length * 16, Uint8Array.BYTES_PER_ELEMENT));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  values.forEach((value, index) => {
    const interval = value as IntervalValue | null;
    const offset = index * 16;
    view.setInt32(offset, interval?.months ?? 0, true);
    view.setInt32(offset + 4, interval?.days ?? 0, true);
    view.setBigInt64(offset + 8, (interval?.micros ?? 0n) * 1_000n, true);
  });
  return data;
}

function variableBytes(
  values: readonly QuackValue[],
  encode: (value: QuackValue) => Uint8Array
): { offsets: Int32Array; values: Uint8Array } {
  const offsets = new Int32Array(alignedLength(values.length + 1, Int32Array.BYTES_PER_ELEMENT));
  const parts: Uint8Array[] = [];
  let byteLength = 0;
  values.forEach((value, index) => {
    offsets[index] = byteLength;
    if (value !== null) {
      const bytes = encode(value);
      parts.push(bytes);
      byteLength += bytes.byteLength;
    }
  });
  offsets[values.length] = byteLength;
  const data = new Uint8Array(alignedLength(byteLength, Uint8Array.BYTES_PER_ELEMENT));
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.byteLength;
  }
  return { offsets, values: data };
}

function listBuffers(
  arrowType: Extract<DataType, { typeId: typeof Type.List | typeof Type.LargeList }>,
  duckType: LogicalType,
  values: readonly QuackValue[],
  options: QuackArrowOptions
): { offsets: Int32Array; children: Batch<unknown>[] } {
  const childField = arrowType.children[0];
  if (!childField) {
    throw new QuackProtocolError("Arrow LIST type is missing child metadata");
  }
  const childDuckType = getChildType(duckType);
  const offsets = new Int32Array(alignedLength(values.length + 1, Int32Array.BYTES_PER_ELEMENT));
  const childValues: QuackValue[] = [];
  values.forEach((value, index) => {
    offsets[index] = childValues.length;
    if (Array.isArray(value)) {
      childValues.push(...value);
    }
  });
  offsets[values.length] = childValues.length;
  return {
    offsets,
    children: [arrowBatchFromValues(childField.type, childDuckType, childValues, options)]
  };
}

function mapBuffers(
  arrowType: Extract<DataType, { typeId: typeof Type.Map }>,
  duckType: LogicalType,
  values: readonly QuackValue[],
  options: QuackArrowOptions
): { offsets: Int32Array; children: Batch<unknown>[] } {
  const childField = arrowType.children[0];
  const childDuckType = getChildType(duckType);
  const offsets = new Int32Array(alignedLength(values.length + 1, Int32Array.BYTES_PER_ELEMENT));
  const entries: QuackValue[] = [];
  values.forEach((value, index) => {
    offsets[index] = entries.length;
    if (Array.isArray(value)) {
      entries.push(...value);
    }
  });
  offsets[values.length] = entries.length;
  return {
    offsets,
    children: [arrowBatchFromValues(childField.type, childDuckType, entries, options)]
  };
}

function structChildren(
  arrowType: Extract<DataType, { typeId: typeof Type.Struct }>,
  duckType: LogicalType,
  values: readonly QuackValue[],
  options: QuackArrowOptions
): Batch<unknown>[] {
  const children = getStructChildren(duckType);
  return arrowType.children.map((field, index) => {
    const child = children[index];
    if (!child) {
      throw new QuackProtocolError(`STRUCT child ${index} is missing DuckDB metadata`);
    }
    const childValues = values.map((value) => {
      if (value === null || Array.isArray(value) || value instanceof Uint8Array || typeof value !== "object") {
        return null;
      }
      return (value as Record<string, QuackValue>)[child.name] ?? null;
    });
    return arrowBatchFromValues(field.type, child.type, childValues, options);
  });
}

function fixedSizeListChildren(
  arrowType: Extract<DataType, { typeId: typeof Type.FixedSizeList }>,
  duckType: LogicalType,
  values: readonly QuackValue[],
  options: QuackArrowOptions
): Batch<unknown>[] {
  const childField = arrowType.children[0];
  if (!childField) {
    throw new QuackProtocolError("Arrow FixedSizeList type is missing child metadata");
  }
  const childDuckType = getChildType(duckType);
  const childValues: QuackValue[] = [];
  for (const value of values) {
    if (value === null) {
      childValues.push(...Array.from({ length: arrowType.stride }, () => null));
    } else if (Array.isArray(value) && value.length === arrowType.stride) {
      childValues.push(...value);
    } else {
      throw new QuackProtocolError(`ARRAY values must contain exactly ${arrowType.stride} entries`);
    }
  }
  return [arrowBatchFromValues(childField.type, childDuckType, childValues, options)];
}

function resolveDuckType(field: Field, index: number, schema?: QuackArrowDuckTypeSchema): LogicalType {
  if (isDuckTypeArraySchema(schema)) {
    const type = schema[index];
    if (!type) {
      throw new QuackProtocolError(`Missing DuckDB type for Arrow column ${field.name}`);
    }
    return type;
  }
  if (schema) {
    const type = schema[field.name];
    if (!type) {
      throw new QuackProtocolError(`Missing DuckDB type for Arrow column ${field.name}`);
    }
    return type;
  }
  return logicalTypeFromFieldMetadata(field) ?? duckTypeFromArrowType(field.type);
}

function isDuckTypeArraySchema(schema: QuackArrowDuckTypeSchema | undefined): schema is readonly LogicalType[] {
  return Array.isArray(schema);
}

function duckTypeFromArrowType(type: DataType): LogicalType {
  switch (type.typeId) {
    case Type.Null:
      return LogicalTypes.null();
    case Type.Bool:
      return LogicalTypes.boolean();
    case Type.Int:
      return type.signed
        ? type.bitWidth === 8
          ? LogicalTypes.tinyint()
          : type.bitWidth === 16
            ? LogicalTypes.smallint()
            : type.bitWidth === 32
              ? LogicalTypes.integer()
              : LogicalTypes.bigint()
        : type.bitWidth === 8
          ? LogicalTypes.utinyint()
          : type.bitWidth === 16
            ? LogicalTypes.usmallint()
            : type.bitWidth === 32
              ? LogicalTypes.uinteger()
              : LogicalTypes.ubigint();
    case Type.Float:
      return type.precision === 2 ? LogicalTypes.double() : LogicalTypes.float();
    case Type.Decimal:
      return LogicalTypes.decimal(type.precision, type.scale);
    case Type.Utf8:
    case Type.LargeUtf8:
      return LogicalTypes.varchar();
    case Type.Binary:
    case Type.LargeBinary:
    case Type.FixedSizeBinary:
      return LogicalTypes.blob();
    case Type.Date:
      return LogicalTypes.date();
    case Type.Time:
      return type.unit === TimeUnit.NANOSECOND ? LogicalTypes.timeNs() : LogicalTypes.time();
    case Type.Timestamp:
      if (type.timezone) {
        return LogicalTypes.timestampTz();
      }
      return type.unit === TimeUnit.SECOND
        ? LogicalTypes.timestampSeconds()
        : type.unit === TimeUnit.MILLISECOND
          ? LogicalTypes.timestampMillis()
          : type.unit === TimeUnit.NANOSECOND
            ? LogicalTypes.timestampNanos()
            : LogicalTypes.timestamp();
    case Type.Interval:
      return LogicalTypes.interval();
    case Type.List:
    case Type.LargeList:
      return LogicalTypes.list(duckTypeFromArrowField(type.children[0]));
    case Type.FixedSizeList:
      return LogicalTypes.array(duckTypeFromArrowField(type.children[0]), type.stride);
    case Type.Struct:
      return LogicalTypes.struct(type.children.map((child): ChildType => ({ name: child.name, type: duckTypeFromArrowField(child) })));
    case Type.Map: {
      const entries = type.children[0]?.type;
      if (!entries || entries.typeId !== Type.Struct) {
        throw new QuackUnsupportedTypeError("Arrow Map type is missing entries struct metadata");
      }
      const key = entries.children[0];
      const value = entries.children[1];
      if (!key || !value) {
        throw new QuackUnsupportedTypeError("Arrow Map type is missing key/value metadata");
      }
      return LogicalTypes.map(duckTypeFromArrowField(key), duckTypeFromArrowField(value));
    }
    case Type.Dictionary:
      return duckTypeFromArrowType(type.dictionary);
    default:
      throw new QuackUnsupportedTypeError(`Cannot infer a DuckDB type from Arrow type id ${type.typeId}`);
  }
}

function duckTypeFromArrowField(field: Field | undefined): LogicalType {
  if (!field) {
    throw new QuackProtocolError("Arrow field is missing");
  }
  return logicalTypeFromFieldMetadata(field) ?? duckTypeFromArrowType(field.type);
}

function arrowValueToQuack(value: unknown, duckType: LogicalType, arrowType: DataType): QuackValue {
  if (value === null || value === undefined) {
    return null;
  }
  switch (duckType.id) {
    case LogicalTypeId.DECIMAL:
      return typeof value === "bigint" ? value : String(value);
    case LogicalTypeId.HUGEINT:
    case LogicalTypeId.UHUGEINT:
      return typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
    case LogicalTypeId.DATE:
      return value instanceof Date ? dateFromJSDate(value) : { kind: "date", days: Math.trunc(Number(value) / 86_400_000) };
    case LogicalTypeId.TIME:
      return { kind: "time", unit: "micros", value: arrowTimeToDuck(value, arrowType, "micros") };
    case LogicalTypeId.TIME_NS:
      return { kind: "time", unit: "nanos", value: arrowTimeToDuck(value, arrowType, "nanos") };
    case LogicalTypeId.TIME_TZ:
      return { kind: "time_tz", bits: BigInt(value as bigint | number | string) };
    case LogicalTypeId.TIMESTAMP:
    case LogicalTypeId.TIMESTAMP_SEC:
    case LogicalTypeId.TIMESTAMP_MS:
    case LogicalTypeId.TIMESTAMP_NS:
    case LogicalTypeId.TIMESTAMP_TZ:
      return arrowTimestampToDuck(value, duckType, arrowType);
    case LogicalTypeId.INTERVAL:
      return arrowIntervalToDuck(value);
    case LogicalTypeId.LIST:
      return Array.from(value as Iterable<unknown>, (item) => arrowValueToQuack(item, getChildType(duckType), childArrowType(arrowType)));
    case LogicalTypeId.ARRAY:
      return Array.from(value as Iterable<unknown>, (item) => arrowValueToQuack(item, getChildType(duckType), childArrowType(arrowType)));
    case LogicalTypeId.MAP:
      return arrowMapToQuack(value, duckType, arrowType);
    case LogicalTypeId.STRUCT:
      return arrowStructToQuack(value, duckType, arrowType);
    default:
      return value instanceof Uint8Array ? value : value as QuackValue;
  }
}

function arrowTimestampToDuck(value: unknown, duckType: LogicalType, arrowType: DataType): TimestampValue {
  const unit = duckTimestampUnit(duckType);
  const timezone = duckType.id === LogicalTypeId.TIMESTAMP_TZ ? "utc" : undefined;
  if (value instanceof Date) {
    return timestampFromJSDate(value, unit, timezone);
  }
  const raw =
    typeof value === "bigint" && arrowType.typeId === Type.Timestamp
      ? convertTimestampUnit(value, arrowType.unit, unit)
      : millisToTimestampUnit(Number(value), unit);
  return timezone === undefined
    ? { kind: "timestamp", unit, value: raw }
    : { kind: "timestamp", unit, value: raw, timezone };
}

function arrowTimeToDuck(value: unknown, arrowType: DataType, unit: "micros" | "nanos"): bigint {
  const raw = BigInt(value as bigint | number | string);
  if (arrowType.typeId !== Type.Time) {
    return raw;
  }
  const micros =
    arrowType.unit === TimeUnit.SECOND
      ? raw * 1_000_000n
      : arrowType.unit === TimeUnit.MILLISECOND
        ? raw * 1_000n
        : arrowType.unit === TimeUnit.NANOSECOND
          ? raw / 1_000n
          : raw;
  return unit === "nanos" ? micros * 1_000n : micros;
}

function arrowIntervalToDuck(value: unknown): IntervalValue {
  const parts = Array.from(value as ArrayLike<number>);
  return {
    kind: "interval",
    months: Number(parts[0] ?? 0),
    days: Number(parts[1] ?? 0),
    micros: BigInt(Math.trunc(Number(parts[2] ?? 0) / 1_000))
  };
}

function arrowMapToQuack(value: unknown, duckType: LogicalType, arrowType: DataType): QuackValue {
  const entryDuckType = getChildType(duckType);
  const entryArrowType = childArrowType(arrowType);
  if (entryArrowType.typeId !== Type.Struct) {
    throw new QuackProtocolError("Arrow Map entries must be STRUCT values");
  }
  const entryDuckChildren = getStructChildren(entryDuckType);
  const keyDuckType = entryDuckChildren[0]?.type;
  const valueDuckType = entryDuckChildren[1]?.type;
  const keyArrowType = entryArrowType.children[0]?.type;
  const valueArrowType = entryArrowType.children[1]?.type;
  if (!keyDuckType || !valueDuckType || !keyArrowType || !valueArrowType) {
    throw new QuackProtocolError("Arrow Map entries are missing key/value metadata");
  }
  const pairs = value instanceof Map ? Array.from(value.entries()) : Array.from(value as Iterable<unknown>);
  return pairs.map((pair) => {
    if (Array.isArray(pair)) {
      return {
        key: arrowValueToQuack(pair[0], keyDuckType, keyArrowType),
        value: arrowValueToQuack(pair[1], valueDuckType, valueArrowType)
      };
    }
    return arrowStructToQuack(pair, entryDuckType, entryArrowType);
  });
}

function arrowStructToQuack(value: unknown, duckType: LogicalType, arrowType: DataType): QuackValue {
  const children = getStructChildren(duckType);
  const record: Record<string, QuackValue> = {};
  children.forEach((child, index) => {
    record[child.name] = arrowValueToQuack(
      (value as Record<string, unknown>)[child.name],
      child.type,
      childArrowType(arrowType, index)
    );
  });
  return record;
}

function childArrowType(type: DataType, index = 0): DataType {
  if ("children" in type) {
    const child = type.children[index];
    if (!child) {
      throw new QuackProtocolError(`Arrow type id ${type.typeId} is missing child ${index}`);
    }
    return child.type;
  }
  throw new QuackProtocolError(`Arrow type id ${type.typeId} does not have children`);
}

function duckTimestampUnit(type: LogicalType): TimestampValue["unit"] {
  switch (type.id) {
    case LogicalTypeId.TIMESTAMP_SEC:
      return "seconds";
    case LogicalTypeId.TIMESTAMP_MS:
      return "millis";
    case LogicalTypeId.TIMESTAMP_NS:
      return "nanos";
    default:
      return "micros";
  }
}

function convertTimestampUnit(value: bigint, arrowUnit: number, duckUnit: TimestampValue["unit"]): bigint {
  const nanos =
    arrowUnit === TimeUnit.SECOND
      ? value * 1_000_000_000n
      : arrowUnit === TimeUnit.MILLISECOND
        ? value * 1_000_000n
        : arrowUnit === TimeUnit.MICROSECOND
          ? value * 1_000n
          : value;
  switch (duckUnit) {
    case "seconds":
      return nanos / 1_000_000_000n;
    case "millis":
      return nanos / 1_000_000n;
    case "micros":
      return nanos / 1_000n;
    case "nanos":
      return nanos;
  }
}

function millisToTimestampUnit(value: number, unit: TimestampValue["unit"]): bigint {
  switch (unit) {
    case "seconds":
      return BigInt(Math.trunc(value / 1_000));
    case "millis":
      return BigInt(Math.trunc(value));
    case "micros":
      return BigInt(Math.trunc(value * 1_000));
    case "nanos":
      return BigInt(Math.trunc(value * 1_000_000));
  }
}

function validityBitmap(values: readonly QuackValue[]): { validity: Uint8Array; nullCount: number } {
  let nullCount = 0;
  for (const value of values) {
    if (value === null) {
      nullCount++;
    }
  }
  if (nullCount === 0) {
    return { validity: new Uint8Array(0), nullCount };
  }
  const validity = new Uint8Array(alignedLength(Math.ceil(values.length / 8), Uint8Array.BYTES_PER_ELEMENT));
  values.forEach((value, index) => {
    if (value !== null) {
      validity[index >> 3] = (validity[index >> 3] ?? 0) | (1 << (index % 8));
    }
  });
  return { validity, nullCount };
}

function booleanBitmap(values: readonly QuackValue[]): Uint8Array {
  const bits = new Uint8Array(alignedLength(Math.ceil(values.length / 8), Uint8Array.BYTES_PER_ELEMENT));
  values.forEach((value, index) => {
    if (value === true) {
      bits[index >> 3] = (bits[index >> 3] ?? 0) | (1 << (index % 8));
    }
  });
  return bits;
}

function decimalUnscaled(value: QuackValue, type: LogicalType, scale: number): bigint {
  if (value === null) {
    return 0n;
  }
  if (typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)) {
    const decimal = value as DecimalValue;
    if (decimal.kind === "decimal") {
      return BigInt(decimal.value);
    }
  }
  if (typeof value === "bigint") {
    return value;
  }
  const { width } = decimalTypeInfo(type);
  return decimalValue(value as string | number, width, scale).value;
}

function decimalTypeInfo(type: LogicalType): { width: number; scale: number } {
  const info = type.typeInfo;
  if (info?.type !== ExtraTypeInfoType.DECIMAL) {
    throw new QuackProtocolError("DECIMAL type is missing DecimalTypeInfo");
  }
  return { width: info.width, scale: info.scale };
}

function bytesFromValue(value: QuackValue): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  return textEncoder.encode(String(value ?? ""));
}

function resolveColumnNames(
  columnNames: readonly string[] | undefined,
  firstChunk: QuackDataChunk | undefined,
  columnCount: number
): string[] {
  if (columnNames) {
    return [...columnNames];
  }
  if (firstChunk?.columnNames) {
    return [...firstChunk.columnNames];
  }
  return Array.from({ length: columnCount }, (_, index) => `column${index}`);
}

function serializeLogicalType(type: LogicalType): string {
  return JSON.stringify(type, (_key, value) =>
    typeof value === "bigint" ? { [BIGINT_METADATA_KEY]: value.toString() } : value
  );
}

function logicalTypeFromFieldMetadata(field: Field): LogicalType | undefined {
  const metadata = field.metadata;
  const encoded = metadata instanceof Map ? metadata.get(QUACK_LOGICAL_TYPE_METADATA) : undefined;
  return encoded ? deserializeLogicalType(encoded) : undefined;
}

function deserializeLogicalType(value: string): LogicalType {
  return JSON.parse(value, (_key, nested) => {
    if (nested && typeof nested === "object" && BIGINT_METADATA_KEY in nested) {
      return BigInt(String((nested as Record<string, unknown>)[BIGINT_METADATA_KEY]));
    }
    return nested;
  }) as LogicalType;
}

function extractionOptions<T extends QuackArrowOptions>(options: T): QuackArrowOptions {
  return {
    ...(options.useDate === undefined ? {} : { useDate: options.useDate }),
    ...(options.useDecimalInt === undefined ? {} : { useDecimalInt: options.useDecimalInt }),
    ...(options.useBigInt === undefined ? {} : { useBigInt: options.useBigInt }),
    ...(options.useBigIntTimestamp === undefined ? {} : { useBigIntTimestamp: options.useBigIntTimestamp }),
    ...(options.useMap === undefined ? {} : { useMap: options.useMap }),
    ...(options.useProxy === undefined ? {} : { useProxy: options.useProxy })
  };
}

function alignedLength(length: number, bytesPerElement: number): number {
  return (((length * bytesPerElement) + 7) & ~7) / bytesPerElement;
}
