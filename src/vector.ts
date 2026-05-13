import {
  BinaryReader,
  BinaryWriter,
  combineSignedHugeInt,
  combineUnsignedHugeInt,
  splitSignedHugeInt
} from "./binary";
import { QuackProtocolError, QuackUnsupportedTypeError } from "./errors";
import {
  ExtraTypeInfoType,
  getArraySize,
  getChildType,
  getEnumValues,
  getPhysicalType,
  getStructChildren,
  isConstantSizePhysicalType,
  LogicalTypeId,
  PhysicalType,
  physicalTypeSize,
  decodeLogicalType,
  encodeLogicalType
} from "./logical-types";
import type { LogicalType } from "./logical-types";

/** DuckDB vector encodings supported by the Quack wire format. */
export enum VectorType {
  FLAT = 0,
  FSST = 1,
  CONSTANT = 2,
  DICTIONARY = 3,
  SEQUENCE = 4
}

/** Tagged value used for DuckDB DECIMAL values. */
export interface DecimalValue {
  /** Discriminator for decimal values. */
  kind: "decimal";
  /** Unscaled integer value. */
  value: bigint;
  /** DuckDB decimal width. */
  width: number;
  /** DuckDB decimal scale. */
  scale: number;
}

/** Tagged value used for DuckDB DATE values. */
export interface DateValue {
  /** Discriminator for date values. */
  kind: "date";
  /** Days since 1970-01-01. */
  days: number;
}

/** Tagged value used for DuckDB TIME and TIME_NS values. */
export interface TimeValue {
  /** Discriminator for time values. */
  kind: "time";
  /** Unit used by the stored integer value. */
  unit: "micros" | "nanos";
  /** Time value in the specified unit since midnight. */
  value: bigint;
}

/** Tagged value used for DuckDB TIME WITH TIME ZONE values. */
export interface TimeTzValue {
  /** Discriminator for time-with-time-zone values. */
  kind: "time_tz";
  /** DuckDB packed TIME WITH TIME ZONE bits. */
  bits: bigint;
}

/** Tagged value used for DuckDB TIMESTAMP families. */
export interface TimestampValue {
  /** Discriminator for timestamp values. */
  kind: "timestamp";
  /** Unit used by the stored integer value. */
  unit: "seconds" | "millis" | "micros" | "nanos";
  /** Timestamp value in the specified unit since Unix epoch. */
  value: bigint;
  /** Present for DuckDB TIMESTAMP WITH TIME ZONE values. */
  timezone?: "utc";
}

/** Tagged value used for DuckDB INTERVAL values. */
export interface IntervalValue {
  /** Discriminator for interval values. */
  kind: "interval";
  /** Interval months component. */
  months: number;
  /** Interval days component. */
  days: number;
  /** Interval microseconds component. */
  micros: bigint;
}

/** Scalar value representation produced and consumed by the SDK. */
export type QuackScalarValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | DecimalValue
  | DateValue
  | TimeValue
  | TimeTzValue
  | TimestampValue
  | IntervalValue;

/** Recursive value representation for scalars and nested DuckDB types. */
export type QuackValue = QuackScalarValue | QuackValue[] | { [key: string]: QuackValue };

/** Decoded DuckDB vector. */
export interface DecodedVector {
  /** Logical type of the vector values. */
  type: LogicalType;
  /** Physical vector encoding used on the wire. */
  vectorType: VectorType;
  /** Materialized values in row order. */
  values: QuackValue[];
}

/** Decoded DuckDB DataChunk. */
export interface QuackDataChunk {
  /** Number of rows in the chunk. */
  rowCount: number;
  /** Logical types for each column. */
  types: LogicalType[];
  /** Decoded column vectors. */
  columns: DecodedVector[];
  /** Optional names used when materializing rows locally. */
  columnNames?: string[];
}

/** Materialized row object keyed by column name. */
export type QuackRow = Record<string, QuackValue>;

interface ListEntry {
  offset: number;
  length: number;
}

/** Decode a nullable-pointer DataChunk wrapper used in Quack messages. */
export function decodeDataChunkWrapper(reader: BinaryReader): QuackDataChunk {
  return reader.readObject((object) => object.readRequiredField(300, () => decodeDataChunk(object)));
}

/** Encode a nullable-pointer DataChunk wrapper used in Quack messages. */
export function encodeDataChunkWrapper(writer: BinaryWriter, chunk: QuackDataChunk): void {
  writer.writeObject((object) => {
    object.writeField(300, () => encodeDataChunk(object, chunk));
  });
}

/** Decode a DuckDB DataChunk body. */
export function decodeDataChunk(reader: BinaryReader): QuackDataChunk {
  return reader.readObject((object) => {
    const rowCount = object.readRequiredField(100, () => object.readUlebNumber());
    const types = object.readRequiredField(101, () => object.readList(() => decodeLogicalType(object)));
    const columns = object.readRequiredField(102, () =>
      object.readList((index) => {
        const type = types[index];
        if (!type) {
          throw new QuackProtocolError(`Column vector ${index} has no matching logical type`);
        }
        return decodeVector(object, type, rowCount);
      })
    );
    if (columns.length !== types.length) {
      throw new QuackProtocolError(`DataChunk declared ${types.length} types but serialized ${columns.length} columns`);
    }
    return { rowCount, types, columns };
  });
}

/** Encode a DuckDB DataChunk body. */
export function encodeDataChunk(writer: BinaryWriter, chunk: QuackDataChunk): void {
  if (chunk.types.length !== chunk.columns.length) {
    throw new QuackProtocolError("DataChunk type count must match column count");
  }
  writer.writeObject((object) => {
    object.writeField(100, () => object.writeUleb(chunk.rowCount));
    object.writeField(101, () => object.writeList(chunk.types, (type) => encodeLogicalType(object, type)));
    object.writeField(102, () =>
      object.writeList(chunk.columns, (column, index) => {
        const type = chunk.types[index];
        if (!type) {
          throw new QuackProtocolError(`Column ${index} has no logical type`);
        }
        if (column.values.length !== chunk.rowCount) {
          throw new QuackProtocolError(`Column ${index} has ${column.values.length} values, expected ${chunk.rowCount}`);
        }
        encodeVector(object, type, column.values, chunk.rowCount);
      })
    );
  });
}

/** Decode a DuckDB vector for a known logical type and row count. */
export function decodeVector(reader: BinaryReader, type: LogicalType, count: number): DecodedVector {
  return reader.readObject((object) => decodeVectorBody(object, type, count));
}

/** Encode values as a flat DuckDB vector. */
export function encodeVector(writer: BinaryWriter, type: LogicalType, values: readonly QuackValue[], count: number): void {
  writer.writeObject((object) => encodeFlatVectorBody(object, type, values, count));
}

/** Materialize one DataChunk as row objects. */
export function rowsFromChunk(chunk: QuackDataChunk, columnNames = chunk.columnNames): QuackRow[] {
  const names = columnNames ?? chunk.columns.map((_, index) => `column${index}`);
  const rows: QuackRow[] = [];
  for (let rowIndex = 0; rowIndex < chunk.rowCount; rowIndex++) {
    const row: QuackRow = {};
    for (let columnIndex = 0; columnIndex < chunk.columns.length; columnIndex++) {
      const name = names[columnIndex] ?? `column${columnIndex}`;
      const column = chunk.columns[columnIndex];
      if (!column) {
        throw new QuackProtocolError(`Missing column ${columnIndex}`);
      }
      row[name] = column.values[rowIndex] ?? null;
    }
    rows.push(row);
  }
  return rows;
}

/** Materialize multiple DataChunks as row objects. */
export function chunksToRows(chunks: readonly QuackDataChunk[], columnNames?: readonly string[]): QuackRow[] {
  return chunks.flatMap((chunk) => rowsFromChunk(chunk, columnNames ? [...columnNames] : chunk.columnNames));
}

/** Render a tagged decimal value with its scale. */
export function decimalToString(decimal: DecimalValue): string {
  const scale = decimal.scale;
  const negative = decimal.value < 0n;
  const abs = negative ? -decimal.value : decimal.value;
  if (scale === 0) {
    return `${negative ? "-" : ""}${abs.toString()}`;
  }
  const factor = 10n ** BigInt(scale);
  const integer = abs / factor;
  const fraction = (abs % factor).toString().padStart(scale, "0");
  return `${negative ? "-" : ""}${integer.toString()}.${fraction}`;
}

function decodeVectorBody(reader: BinaryReader, type: LogicalType, count: number): DecodedVector {
  const vectorType = reader.readOptionalField(90, () => reader.readUlebNumber(), VectorType.FLAT) as VectorType;
  switch (vectorType) {
    case VectorType.FLAT:
      return decodeFlatVectorBody(reader, type, count, vectorType);
    case VectorType.FSST:
      throw new QuackUnsupportedTypeError("FSST-compressed vectors are not supported by quack-ts");
    case VectorType.CONSTANT: {
      const decoded = decodeVectorBody(reader, type, count > 0 ? 1 : 0);
      const value = decoded.values[0] ?? null;
      return { type, vectorType, values: Array.from({ length: count }, () => value) };
    }
    case VectorType.DICTIONARY: {
      const selection = reader.readRequiredField(91, () => readSelectionVector(reader, count));
      const dictionaryCount = reader.readRequiredField(92, () => reader.readUlebNumber());
      const dictionary = decodeVectorBody(reader, type, dictionaryCount);
      return {
        type,
        vectorType,
        values: selection.map((index) => {
          const value = dictionary.values[index];
          if (value === undefined) {
            throw new QuackProtocolError(`Dictionary selection ${index} is out of range`);
          }
          return value;
        })
      };
    }
    case VectorType.SEQUENCE: {
      const start = reader.readRequiredField(91, () => reader.readSlebBigInt());
      const increment = reader.readRequiredField(92, () => reader.readSlebBigInt());
      const values = Array.from({ length: count }, (_, index) => decodeSequenceValue(type, start + increment * BigInt(index)));
      return { type, vectorType, values };
    }
    default:
      throw new QuackProtocolError(`Unknown vector type ${vectorType}`);
  }
}

function decodeFlatVectorBody(reader: BinaryReader, type: LogicalType, count: number, vectorType: VectorType): DecodedVector {
  if (type.id === LogicalTypeId.GEOMETRY && reader.peekFieldId() === 99) {
    reader.readRequiredField(99, () => reader.readUlebNumber());
  }

  const hasValidityMask = reader.readRequiredField(100, () => reader.readBool());
  const validity = hasValidityMask ? reader.readRequiredField(101, () => readValidityMask(reader, count)) : undefined;
  const physicalType = getPhysicalType(type);

  if (isConstantSizePhysicalType(physicalType)) {
    const byteLength = physicalTypeSize(physicalType) * count;
    const bytes = reader.readRequiredField(102, () => reader.readBlob());
    if (bytes.byteLength !== byteLength) {
      throw new QuackProtocolError(`Fixed-size vector data has ${bytes.byteLength} bytes, expected ${byteLength}`);
    }
    const values = decodeFixedValues(type, physicalType, bytes, count, validity);
    return { type, vectorType, values };
  }

  switch (physicalType) {
    case PhysicalType.VARCHAR: {
      const rawValues = reader.readRequiredField(102, () => reader.readList(() => reader.readStringBytes()));
      const values = rawValues.map((raw, index) => (isValid(validity, index) ? decodeStringLikeValue(type, raw) : null));
      return { type, vectorType, values };
    }
    case PhysicalType.STRUCT: {
      const children = getStructChildren(type);
      const childVectors = reader.readRequiredField(103, () =>
        reader.readList((index) => {
          const child = children[index];
          if (!child) {
            throw new QuackProtocolError(`STRUCT child vector ${index} has no matching type metadata`);
          }
          return decodeVector(reader, child.type, count);
        })
      );
      const values = Array.from({ length: count }, (_, rowIndex) => {
        if (!isValid(validity, rowIndex)) {
          return null;
        }
        const row: Record<string, QuackValue> = {};
        for (let childIndex = 0; childIndex < children.length; childIndex++) {
          const child = children[childIndex];
          const childVector = childVectors[childIndex];
          if (!child || !childVector) {
            throw new QuackProtocolError(`STRUCT child ${childIndex} is incomplete`);
          }
          row[child.name] = childVector.values[rowIndex] ?? null;
        }
        return row;
      });
      return { type, vectorType, values };
    }
    case PhysicalType.LIST: {
      const listSize = reader.readRequiredField(104, () => reader.readUlebNumber());
      const entries = reader.readRequiredField(105, () => readListEntries(reader, count));
      const childType = getChildType(type);
      const childVector = reader.readRequiredField(106, () => decodeVector(reader, childType, listSize));
      const values = entries.map((entry, rowIndex) => {
        if (!isValid(validity, rowIndex)) {
          return null;
        }
        return childVector.values.slice(entry.offset, entry.offset + entry.length);
      });
      return { type, vectorType, values };
    }
    case PhysicalType.ARRAY: {
      const arraySize = reader.readRequiredField(103, () => reader.readUlebNumber());
      const expectedArraySize = getArraySize(type);
      if (arraySize !== expectedArraySize) {
        throw new QuackProtocolError(`ARRAY vector serialized size ${arraySize}, expected ${expectedArraySize}`);
      }
      const childType = getChildType(type);
      const childVector = reader.readRequiredField(104, () => decodeVector(reader, childType, arraySize * count));
      const values = Array.from({ length: count }, (_, rowIndex) => {
        if (!isValid(validity, rowIndex)) {
          return null;
        }
        const offset = rowIndex * arraySize;
        return childVector.values.slice(offset, offset + arraySize);
      });
      return { type, vectorType, values };
    }
    default:
      throw new QuackUnsupportedTypeError(`Variable-width physical type ${PhysicalType[physicalType] ?? physicalType} is not supported`);
  }
}

function encodeFlatVectorBody(writer: BinaryWriter, type: LogicalType, values: readonly QuackValue[], count: number): void {
  if (values.length !== count) {
    throw new QuackProtocolError(`Vector value count ${values.length} does not match row count ${count}`);
  }
  if (type.id === LogicalTypeId.GEOMETRY) {
    writer.writeField(99, () => writer.writeUleb(1));
  }

  const validity = values.map((value) => value !== null);
  const hasValidityMask = validity.some((valid) => !valid);
  writer.writeField(100, () => writer.writeBool(hasValidityMask));
  if (hasValidityMask) {
    writer.writeField(101, () => writer.writeBlob(writeValidityMask(validity)));
  }

  const physicalType = getPhysicalType(type);
  if (isConstantSizePhysicalType(physicalType)) {
    const data = new BinaryWriter(Math.max(16, physicalTypeSize(physicalType) * count));
    for (const value of values) {
      encodeFixedValue(data, type, physicalType, value);
    }
    writer.writeField(102, () => writer.writeBlob(data.toUint8Array()));
    return;
  }

  switch (physicalType) {
    case PhysicalType.VARCHAR:
      writer.writeField(102, () => writer.writeList(values, (value) => writer.writeStringBytes(encodeStringLikeValue(type, value))));
      return;
    case PhysicalType.STRUCT:
      encodeStructVectorBody(writer, type, values, count);
      return;
    case PhysicalType.LIST:
      encodeListVectorBody(writer, type, values);
      return;
    case PhysicalType.ARRAY:
      encodeArrayVectorBody(writer, type, values);
      return;
    default:
      throw new QuackUnsupportedTypeError(`Cannot encode physical type ${PhysicalType[physicalType] ?? physicalType}`);
  }
}

function decodeFixedValues(
  type: LogicalType,
  physicalType: PhysicalType,
  bytes: Uint8Array,
  count: number,
  validity?: boolean[]
): QuackValue[] {
  const reader = new BinaryReader(bytes);
  const values: QuackValue[] = [];
  for (let index = 0; index < count; index++) {
    const value = decodeFixedValue(reader, type, physicalType);
    values.push(isValid(validity, index) ? value : null);
  }
  reader.assertEof();
  return values;
}

function decodeFixedValue(reader: BinaryReader, type: LogicalType, physicalType: PhysicalType): QuackValue {
  switch (physicalType) {
    case PhysicalType.BOOL:
      return reader.readFixedUint8() !== 0;
    case PhysicalType.INT8:
      return reader.readFixedInt8();
    case PhysicalType.UINT8:
      return decodeEnumOrNumber(type, reader.readFixedUint8());
    case PhysicalType.INT16: {
      const value = reader.readFixedInt16();
      return type.id === LogicalTypeId.DECIMAL ? decimalFromUnscaled(type, BigInt(value)) : value;
    }
    case PhysicalType.UINT16:
      return decodeEnumOrNumber(type, reader.readFixedUint16());
    case PhysicalType.INT32: {
      const value = reader.readFixedInt32();
      if (type.id === LogicalTypeId.DATE) {
        return { kind: "date", days: value };
      }
      return type.id === LogicalTypeId.DECIMAL ? decimalFromUnscaled(type, BigInt(value)) : value;
    }
    case PhysicalType.UINT32:
      return decodeEnumOrNumber(type, reader.readFixedUint32());
    case PhysicalType.INT64: {
      const value = reader.readFixedInt64();
      return decodeInt64LogicalValue(type, value);
    }
    case PhysicalType.UINT64:
      return reader.readFixedUint64();
    case PhysicalType.FLOAT:
      return reader.readFixedFloat32();
    case PhysicalType.DOUBLE:
      return reader.readFixedFloat64();
    case PhysicalType.INT128: {
      const lower = reader.readFixedUint64();
      const upper = reader.readFixedInt64();
      if (type.id === LogicalTypeId.UUID) {
        return uuidFromHugeIntParts(upper, lower);
      }
      const value = combineSignedHugeInt({ upper, lower });
      return type.id === LogicalTypeId.DECIMAL ? decimalFromUnscaled(type, value) : value;
    }
    case PhysicalType.UINT128: {
      const lower = reader.readFixedUint64();
      const upper = reader.readFixedUint64();
      return combineUnsignedHugeInt({ upper, lower });
    }
    case PhysicalType.INTERVAL:
      return {
        kind: "interval",
        months: reader.readFixedInt32(),
        days: reader.readFixedInt32(),
        micros: reader.readFixedInt64()
      };
    default:
      throw new QuackUnsupportedTypeError(`Cannot decode fixed physical type ${PhysicalType[physicalType] ?? physicalType}`);
  }
}

function encodeFixedValue(writer: BinaryWriter, type: LogicalType, physicalType: PhysicalType, value: QuackValue): void {
  if (value === null) {
    writeZeroFixedValue(writer, physicalType);
    return;
  }

  switch (physicalType) {
    case PhysicalType.BOOL:
      writer.writeFixedUint8(value === true ? 1 : 0);
      return;
    case PhysicalType.INT8:
      writer.writeFixedInt8(Number(value));
      return;
    case PhysicalType.UINT8:
      writer.writeFixedUint8(encodeEnumOrNumber(type, value));
      return;
    case PhysicalType.INT16:
      writer.writeFixedInt16(Number(encodeDecimalOrInteger(type, value)));
      return;
    case PhysicalType.UINT16:
      writer.writeFixedUint16(encodeEnumOrNumber(type, value));
      return;
    case PhysicalType.INT32:
      writer.writeFixedInt32(Number(encodeDateDecimalOrInteger(type, value)));
      return;
    case PhysicalType.UINT32:
      writer.writeFixedUint32(encodeEnumOrNumber(type, value));
      return;
    case PhysicalType.INT64:
      writer.writeFixedInt64(encodeInt64LogicalValue(type, value));
      return;
    case PhysicalType.UINT64:
      writer.writeFixedUint64(valueToBigInt(value));
      return;
    case PhysicalType.FLOAT:
      writer.writeFixedFloat32(Number(value));
      return;
    case PhysicalType.DOUBLE:
      writer.writeFixedFloat64(Number(value));
      return;
    case PhysicalType.INT128: {
      const parts = type.id === LogicalTypeId.UUID ? uuidToHugeIntParts(String(value)) : splitSignedHugeInt(encodeInt128LogicalValue(type, value));
      writer.writeFixedUint64(parts.lower);
      writer.writeFixedInt64(parts.upper);
      return;
    }
    case PhysicalType.UINT128: {
      const bigint = valueToBigInt(value);
      writer.writeFixedUint64(BigInt.asUintN(64, bigint));
      writer.writeFixedUint64(BigInt.asUintN(64, bigint >> 64n));
      return;
    }
    case PhysicalType.INTERVAL: {
      const interval = value as IntervalValue;
      writer.writeFixedInt32(interval.months ?? 0);
      writer.writeFixedInt32(interval.days ?? 0);
      writer.writeFixedInt64(interval.micros ?? 0n);
      return;
    }
    default:
      throw new QuackUnsupportedTypeError(`Cannot encode fixed physical type ${PhysicalType[physicalType] ?? physicalType}`);
  }
}

function writeZeroFixedValue(writer: BinaryWriter, physicalType: PhysicalType): void {
  writer.writeBytes(new Uint8Array(physicalTypeSize(physicalType)));
}

function decodeStringLikeValue(type: LogicalType, raw: Uint8Array): QuackValue {
  switch (type.id) {
    case LogicalTypeId.BLOB:
    case LogicalTypeId.GEOMETRY:
    case LogicalTypeId.BIT:
      return raw;
    default:
      return new TextDecoder().decode(raw);
  }
}

function encodeStringLikeValue(type: LogicalType, value: QuackValue): Uint8Array {
  if (value === null) {
    return new Uint8Array();
  }
  switch (type.id) {
    case LogicalTypeId.BLOB:
    case LogicalTypeId.GEOMETRY:
    case LogicalTypeId.BIT:
      if (value instanceof Uint8Array) {
        return value;
      }
      return new TextEncoder().encode(String(value));
    default:
      return new TextEncoder().encode(String(value));
  }
}

function encodeStructVectorBody(writer: BinaryWriter, type: LogicalType, values: readonly QuackValue[], count: number): void {
  const children = getStructChildren(type);
  writer.writeField(103, () =>
    writer.writeList(children, (child) => {
      const childValues = values.map((value) => {
        if (value === null || Array.isArray(value) || typeof value !== "object" || value instanceof Uint8Array) {
          return null;
        }
        return (value as Record<string, QuackValue>)[child.name] ?? null;
      });
      encodeVector(writer, child.type, childValues, count);
    })
  );
}

function encodeListVectorBody(writer: BinaryWriter, type: LogicalType, values: readonly QuackValue[]): void {
  const childType = getChildType(type);
  const entries: ListEntry[] = [];
  const childValues: QuackValue[] = [];
  for (const value of values) {
    if (value === null) {
      entries.push({ offset: 0, length: 0 });
      continue;
    }
    if (!Array.isArray(value)) {
      throw new QuackProtocolError("LIST/MAP values must be arrays");
    }
    const offset = childValues.length;
    childValues.push(...value);
    entries.push({ offset, length: value.length });
  }
  writer.writeField(104, () => writer.writeUleb(childValues.length));
  writer.writeField(105, () => writeListEntries(writer, entries));
  writer.writeField(106, () => encodeVector(writer, childType, childValues, childValues.length));
}

function encodeArrayVectorBody(writer: BinaryWriter, type: LogicalType, values: readonly QuackValue[]): void {
  const childType = getChildType(type);
  const arraySize = getArraySize(type);
  const childValues: QuackValue[] = [];
  for (const value of values) {
    if (value === null) {
      for (let index = 0; index < arraySize; index++) {
        childValues.push(null);
      }
      continue;
    }
    if (!Array.isArray(value) || value.length !== arraySize) {
      throw new QuackProtocolError(`ARRAY values must be arrays of length ${arraySize}`);
    }
    childValues.push(...value);
  }
  writer.writeField(103, () => writer.writeUleb(arraySize));
  writer.writeField(104, () => encodeVector(writer, childType, childValues, childValues.length));
}

function readSelectionVector(reader: BinaryReader, count: number): number[] {
  const expectedBytes = count * 4;
  const bytes = reader.readBlob();
  if (bytes.byteLength !== expectedBytes) {
    throw new QuackProtocolError(`Selection vector has ${bytes.byteLength} bytes, expected ${expectedBytes}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, index) => view.getUint32(index * 4, true));
}

function readValidityMask(reader: BinaryReader, count: number): boolean[] {
  const expectedBytes = validityMaskSize(count);
  const bytes = reader.readBlob();
  if (bytes.byteLength !== expectedBytes) {
    throw new QuackProtocolError(`Validity mask has ${bytes.byteLength} bytes, expected ${expectedBytes}`);
  }
  return Array.from({ length: count }, (_, index) => {
    const byte = bytes[Math.floor(index / 8)] ?? 0;
    return (byte & (1 << (index % 8))) !== 0;
  });
}

function writeValidityMask(validity: readonly boolean[]): Uint8Array {
  const bytes = new Uint8Array(validityMaskSize(validity.length));
  for (let index = 0; index < validity.length; index++) {
    if (validity[index]) {
      const byteIndex = Math.floor(index / 8);
      bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (1 << (index % 8));
    }
  }
  return bytes;
}

function validityMaskSize(count: number): number {
  return Math.ceil(count / 64) * 8;
}

function isValid(validity: readonly boolean[] | undefined, index: number): boolean {
  return validity ? validity[index] === true : true;
}

function readListEntries(reader: BinaryReader, count: number): ListEntry[] {
  const entries = reader.readList(() =>
    reader.readObject((object) => ({
      offset: object.readRequiredField(100, () => object.readUlebNumber()),
      length: object.readRequiredField(101, () => object.readUlebNumber())
    }))
  );
  if (entries.length !== count) {
    throw new QuackProtocolError(`LIST vector serialized ${entries.length} entries for ${count} rows`);
  }
  return entries;
}

function writeListEntries(writer: BinaryWriter, entries: readonly ListEntry[]): void {
  writer.writeList(entries, (entry) => {
    writer.writeObject((object) => {
      object.writeField(100, () => object.writeUleb(entry.offset));
      object.writeField(101, () => object.writeUleb(entry.length));
    });
  });
}

function decodeEnumOrNumber(type: LogicalType, index: number): string | number {
  if (type.id !== LogicalTypeId.ENUM) {
    return index;
  }
  const value = getEnumValues(type)[index];
  if (value === undefined) {
    throw new QuackProtocolError(`ENUM index ${index} is out of range`);
  }
  return value;
}

function encodeEnumOrNumber(type: LogicalType, value: QuackValue): number {
  if (type.id !== LogicalTypeId.ENUM) {
    return Number(value);
  }
  if (typeof value === "number") {
    return value;
  }
  const index = getEnumValues(type).indexOf(String(value));
  if (index < 0) {
    throw new QuackProtocolError(`Unknown ENUM value ${String(value)}`);
  }
  return index;
}

function decodeInt64LogicalValue(type: LogicalType, value: bigint): QuackValue {
  switch (type.id) {
    case LogicalTypeId.TIME:
      return { kind: "time", unit: "micros", value };
    case LogicalTypeId.TIME_NS:
      return { kind: "time", unit: "nanos", value };
    case LogicalTypeId.TIME_TZ:
      return { kind: "time_tz", bits: value };
    case LogicalTypeId.TIMESTAMP_SEC:
      return { kind: "timestamp", unit: "seconds", value };
    case LogicalTypeId.TIMESTAMP_MS:
      return { kind: "timestamp", unit: "millis", value };
    case LogicalTypeId.TIMESTAMP:
      return { kind: "timestamp", unit: "micros", value };
    case LogicalTypeId.TIMESTAMP_NS:
      return { kind: "timestamp", unit: "nanos", value };
    case LogicalTypeId.TIMESTAMP_TZ:
      return { kind: "timestamp", unit: "micros", value, timezone: "utc" };
    case LogicalTypeId.DECIMAL:
      return decimalFromUnscaled(type, value);
    default:
      return value;
  }
}

function encodeInt64LogicalValue(type: LogicalType, value: QuackValue): bigint {
  if (type.id === LogicalTypeId.DECIMAL) {
    return decimalToUnscaled(type, value);
  }
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array) && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.kind === "time" || record.kind === "timestamp") {
      return BigInt(record.value as bigint | number | string);
    }
    if (record.kind === "time_tz") {
      return BigInt(record.bits as bigint | number | string);
    }
  }
  return valueToBigInt(value);
}

function encodeInt128LogicalValue(type: LogicalType, value: QuackValue): bigint {
  if (type.id === LogicalTypeId.DECIMAL) {
    return decimalToUnscaled(type, value);
  }
  return valueToBigInt(value);
}

function encodeDecimalOrInteger(type: LogicalType, value: QuackValue): bigint {
  return type.id === LogicalTypeId.DECIMAL ? decimalToUnscaled(type, value) : valueToBigInt(value);
}

function encodeDateDecimalOrInteger(type: LogicalType, value: QuackValue): bigint {
  if (type.id === LogicalTypeId.DATE) {
    if (typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array)) {
      return BigInt((value as DateValue).days);
    }
    return valueToBigInt(value);
  }
  return encodeDecimalOrInteger(type, value);
}

function decimalFromUnscaled(type: LogicalType, value: bigint): DecimalValue {
  const info = type.typeInfo;
  if (info?.type !== ExtraTypeInfoType.DECIMAL) {
    throw new QuackProtocolError("DECIMAL value is missing DecimalTypeInfo");
  }
  return { kind: "decimal", value, width: info.width, scale: info.scale };
}

function decimalToUnscaled(type: LogicalType, value: QuackValue): bigint {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array)) {
    const record = value as Record<string, unknown>;
    if (record.kind === "decimal") {
      return BigInt(record.value as bigint | number | string);
    }
  }
  if (typeof value === "string") {
    return parseDecimalString(type, value);
  }
  return valueToBigInt(value);
}

function parseDecimalString(type: LogicalType, value: string): bigint {
  const info = type.typeInfo;
  if (info?.type !== ExtraTypeInfoType.DECIMAL) {
    throw new QuackProtocolError("DECIMAL value is missing DecimalTypeInfo");
  }
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const [integer = "0", fraction = ""] = unsigned.split(".");
  const paddedFraction = fraction.padEnd(info.scale, "0").slice(0, info.scale);
  const unscaled = BigInt(`${integer}${paddedFraction}` || "0");
  return negative ? -unscaled : unscaled;
}

function valueToBigInt(value: QuackValue): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return BigInt(value);
  }
  throw new QuackProtocolError(`Cannot convert ${String(value)} to bigint`);
}

function decodeSequenceValue(type: LogicalType, value: bigint): QuackValue {
  switch (type.id) {
    case LogicalTypeId.INTEGER:
    case LogicalTypeId.DATE:
      return type.id === LogicalTypeId.DATE ? { kind: "date", days: Number(value) } : Number(value);
    case LogicalTypeId.BIGINT:
      return value;
    default:
      return decodeInt64LogicalValue(type, value);
  }
}

function uuidFromHugeIntParts(upper: bigint, lower: bigint): string {
  const displayUpper = BigInt.asUintN(64, upper) ^ (1n << 63n);
  const hex = `${displayUpper.toString(16).padStart(16, "0")}${lower.toString(16).padStart(16, "0")}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidToHugeIntParts(uuid: string): { upper: bigint; lower: bigint } {
  const hex = uuid.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new QuackProtocolError(`Invalid UUID string ${uuid}`);
  }
  const displayUpper = BigInt(`0x${hex.slice(0, 16)}`);
  const lower = BigInt(`0x${hex.slice(16)}`);
  const rawUpper = BigInt.asIntN(64, displayUpper ^ (1n << 63n));
  return { upper: rawUpper, lower };
}
