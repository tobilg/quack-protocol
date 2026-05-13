import { FIELD_END } from "./constants";
import { QuackProtocolError } from "./errors";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Lower and upper 64-bit words used to represent DuckDB HUGEINT values. */
export interface HugeIntParts {
  /** Low 64 bits, interpreted as unsigned. */
  lower: bigint;
  /** High 64 bits, interpreted as signed or unsigned depending on context. */
  upper: bigint;
}

/** HUGEINT input accepted by binary encoders. */
export type HugeIntLike = bigint | HugeIntParts;

/** Writer for DuckDB BinarySerializer-compatible primitive values. */
export class BinaryWriter {
  private buffer: Uint8Array;
  private offset = 0;

  /** Create a binary writer with an optional initial buffer capacity. */
  constructor(initialCapacity = 1024) {
    this.buffer = new Uint8Array(initialCapacity);
  }

  /** Return the written bytes. */
  toUint8Array(): Uint8Array {
    return this.buffer.slice(0, this.offset);
  }

  /** Write an object body and its end-of-object marker. */
  writeObject(write: (writer: BinaryWriter) => void): void {
    write(this);
    this.writeFieldId(FIELD_END);
  }

  /** Write a field id followed by its encoded payload. */
  writeField(fieldId: number, write: (writer: BinaryWriter) => void): void {
    this.writeFieldId(fieldId);
    write(this);
  }

  /** Write a raw 16-bit BinarySerializer field id. */
  writeFieldId(fieldId: number): void {
    if (!Number.isInteger(fieldId) || fieldId < 0 || fieldId > 0xffff) {
      throw new QuackProtocolError(`Invalid field id ${fieldId}`);
    }
    this.ensure(2);
    this.buffer[this.offset++] = fieldId & 0xff;
    this.buffer[this.offset++] = (fieldId >>> 8) & 0xff;
  }

  /** Write one unsigned byte. */
  writeByte(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new QuackProtocolError(`Invalid byte ${value}`);
    }
    this.ensure(1);
    this.buffer[this.offset++] = value;
  }

  /** Write raw bytes without a length prefix. */
  writeBytes(value: Uint8Array): void {
    this.ensure(value.byteLength);
    this.buffer.set(value, this.offset);
    this.offset += value.byteLength;
  }

  /** Write a DuckDB boolean byte. */
  writeBool(value: boolean): void {
    this.writeByte(value ? 1 : 0);
  }

  /** Write an unsigned LEB128 integer. */
  writeUleb(value: number | bigint): void {
    let current = toUnsignedBigInt(value);
    while (current >= 0x80n) {
      this.writeByte(Number((current & 0x7fn) | 0x80n));
      current >>= 7n;
    }
    this.writeByte(Number(current));
  }

  /** Write a signed LEB128 integer. */
  writeSleb(value: number | bigint): void {
    let current = BigInt(value);
    let more = true;
    while (more) {
      let byte = Number(current & 0x7fn);
      current >>= 7n;
      const signBitSet = (byte & 0x40) !== 0;
      if ((current === 0n && !signBitSet) || (current === -1n && signBitSet)) {
        more = false;
      } else {
        byte |= 0x80;
      }
      this.writeByte(byte);
    }
  }

  /** Write a UTF-8 string with a length prefix. */
  writeString(value: string): void {
    this.writeStringBytes(textEncoder.encode(value));
  }

  /** Write already-encoded string bytes with a length prefix. */
  writeStringBytes(value: Uint8Array): void {
    this.writeUleb(value.byteLength);
    this.writeBytes(value);
  }

  /** Write a binary blob with a length prefix. */
  writeBlob(value: Uint8Array): void {
    this.writeUleb(BigInt(value.byteLength));
    this.writeBytes(value);
  }

  /** Write a length-prefixed list. */
  writeList<T>(items: readonly T[], writeElement: (item: T, index: number) => void): void {
    this.writeUleb(items.length);
    for (let index = 0; index < items.length; index++) {
      writeElement(items[index] as T, index);
    }
  }

  /** Write a nullable pointer-style value. */
  writeNullable<T>(value: T | null | undefined, writeValue: (value: T) => void): void {
    if (value === null || value === undefined) {
      this.writeBool(false);
      return;
    }
    this.writeBool(true);
    writeValue(value);
  }

  /** Write a DuckDB HugeInt using signed upper and unsigned lower parts. */
  writeHugeInt(value: HugeIntLike): void {
    const parts = typeof value === "bigint" ? splitSignedHugeInt(value) : value;
    this.writeSleb(parts.upper);
    this.writeUleb(parts.lower);
  }

  /** Write a fixed-width signed 8-bit integer. */
  writeFixedInt8(value: number): void {
    this.writeByte(value & 0xff);
  }

  /** Write a fixed-width unsigned 8-bit integer. */
  writeFixedUint8(value: number): void {
    this.writeByte(value);
  }

  /** Write a fixed-width signed 16-bit little-endian integer. */
  writeFixedInt16(value: number): void {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setInt16(0, value, true);
    this.writeBytes(bytes);
  }

  /** Write a fixed-width unsigned 16-bit little-endian integer. */
  writeFixedUint16(value: number): void {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    this.writeBytes(bytes);
  }

  /** Write a fixed-width signed 32-bit little-endian integer. */
  writeFixedInt32(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt32(0, value, true);
    this.writeBytes(bytes);
  }

  /** Write a fixed-width unsigned 32-bit little-endian integer. */
  writeFixedUint32(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    this.writeBytes(bytes);
  }

  /** Write a fixed-width 32-bit little-endian float. */
  writeFixedFloat32(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    this.writeBytes(bytes);
  }

  /** Write a fixed-width 64-bit little-endian float. */
  writeFixedFloat64(value: number): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    this.writeBytes(bytes);
  }

  /** Write a fixed-width signed 64-bit little-endian integer. */
  writeFixedInt64(value: number | bigint): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true);
    this.writeBytes(bytes);
  }

  /** Write a fixed-width unsigned 64-bit little-endian integer. */
  writeFixedUint64(value: number | bigint): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, toUnsignedBigInt(value), true);
    this.writeBytes(bytes);
  }

  private ensure(length: number): void {
    const needed = this.offset + length;
    if (needed <= this.buffer.byteLength) {
      return;
    }
    let nextSize = this.buffer.byteLength;
    while (nextSize < needed) {
      nextSize *= 2;
    }
    const next = new Uint8Array(nextSize);
    next.set(this.buffer);
    this.buffer = next;
  }
}

/** Reader for DuckDB BinarySerializer-compatible primitive values. */
export class BinaryReader {
  private readonly view: DataView;
  private offset = 0;

  /** Create a reader over binary input bytes. */
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Current byte offset in the input. */
  get position(): number {
    return this.offset;
  }

  /** Number of unread bytes remaining. */
  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  /** Whether the reader has consumed all input bytes. */
  eof(): boolean {
    return this.remaining === 0;
  }

  /** Throw if any bytes remain unread. */
  assertEof(): void {
    if (!this.eof()) {
      throw new QuackProtocolError(`Unexpected trailing bytes at offset ${this.offset}`);
    }
  }

  /** Read an object body and require the end-of-object marker. */
  readObject<T>(read: (reader: BinaryReader) => T): T {
    const result = read(this);
    this.readEndObject();
    return result;
  }

  /** Read and validate an end-of-object marker. */
  readEndObject(): void {
    const fieldId = this.readFieldId();
    if (fieldId !== FIELD_END) {
      throw new QuackProtocolError(`Expected end of object at offset ${this.offset - 2}, got field ${fieldId}`);
    }
  }

  /** Read a raw 16-bit BinarySerializer field id. */
  readFieldId(): number {
    this.ensure(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  /** Peek at the next field id without advancing the reader. */
  peekFieldId(): number {
    this.ensure(2);
    return this.view.getUint16(this.offset, true);
  }

  /** Read a required field with the expected field id. */
  readRequiredField<T>(fieldId: number, read: () => T): T {
    const actual = this.readFieldId();
    if (actual !== fieldId) {
      throw new QuackProtocolError(`Expected field ${fieldId} at offset ${this.offset - 2}, got ${actual}`);
    }
    return read();
  }

  /** Read an optional field when the next field id matches. */
  readOptionalField<T>(fieldId: number, read: () => T, defaultValue: T): T {
    if (this.peekFieldId() !== fieldId) {
      return defaultValue;
    }
    this.readFieldId();
    return read();
  }

  /** Read one unsigned byte. */
  readByte(): number {
    this.ensure(1);
    return this.bytes[this.offset++] as number;
  }

  /** Read raw bytes without interpreting a length prefix. */
  readBytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0) {
      throw new QuackProtocolError(`Invalid byte length ${length}`);
    }
    this.ensure(length);
    const start = this.offset;
    this.offset += length;
    return this.bytes.slice(start, this.offset);
  }

  /** Read a DuckDB boolean byte. */
  readBool(): boolean {
    const value = this.readByte();
    if (value !== 0 && value !== 1) {
      throw new QuackProtocolError(`Invalid boolean byte ${value}`);
    }
    return value === 1;
  }

  /** Read an unsigned LEB128 integer as bigint. */
  readUlebBigInt(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = this.readByte();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7n;
    }
    throw new QuackProtocolError("Unsigned LEB128 value is too long");
  }

  /** Read an unsigned LEB128 integer as a safe JavaScript number. */
  readUlebNumber(): number {
    return bigIntToSafeNumber(this.readUlebBigInt(), "unsigned LEB128");
  }

  /** Read a signed LEB128 integer as bigint. */
  readSlebBigInt(): bigint {
    let result = 0n;
    let shift = 0n;
    let byte = 0;
    for (let i = 0; i < 10; i++) {
      byte = this.readByte();
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) {
        if ((byte & 0x40) !== 0) {
          result |= -1n << shift;
        }
        return result;
      }
    }
    throw new QuackProtocolError("Signed LEB128 value is too long");
  }

  /** Read a signed LEB128 integer as a safe JavaScript number. */
  readSlebNumber(): number {
    return bigIntToSafeNumber(this.readSlebBigInt(), "signed LEB128");
  }

  /** Read a UTF-8 string with a length prefix. */
  readString(): string {
    return textDecoder.decode(this.readStringBytes());
  }

  /** Read length-prefixed bytes for a string-like value. */
  readStringBytes(): Uint8Array {
    const length = this.readUlebNumber();
    return this.readBytes(length);
  }

  /** Read a length-prefixed binary blob. */
  readBlob(): Uint8Array {
    const length = this.readUlebNumber();
    return this.readBytes(length);
  }

  /** Read a length-prefixed list. */
  readList<T>(readElement: (index: number) => T): T[] {
    const length = this.readUlebNumber();
    const result: T[] = [];
    for (let index = 0; index < length; index++) {
      result.push(readElement(index));
    }
    return result;
  }

  /** Read a nullable pointer-style value. */
  readNullable<T>(readValue: () => T): T | undefined {
    return this.readBool() ? readValue() : undefined;
  }

  /** Read a DuckDB HugeInt into upper/lower parts. */
  readHugeInt(): HugeIntParts {
    const upper = this.readSlebBigInt();
    const lower = this.readUlebBigInt();
    return { upper, lower };
  }

  /** Read a fixed-width signed 8-bit integer. */
  readFixedInt8(): number {
    return (this.readByte() << 24) >> 24;
  }

  /** Read a fixed-width unsigned 8-bit integer. */
  readFixedUint8(): number {
    return this.readByte();
  }

  /** Read a fixed-width signed 16-bit little-endian integer. */
  readFixedInt16(): number {
    this.ensure(2);
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  /** Read a fixed-width unsigned 16-bit little-endian integer. */
  readFixedUint16(): number {
    this.ensure(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  /** Read a fixed-width signed 32-bit little-endian integer. */
  readFixedInt32(): number {
    this.ensure(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** Read a fixed-width unsigned 32-bit little-endian integer. */
  readFixedUint32(): number {
    this.ensure(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** Read a fixed-width 32-bit little-endian float. */
  readFixedFloat32(): number {
    this.ensure(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** Read a fixed-width 64-bit little-endian float. */
  readFixedFloat64(): number {
    this.ensure(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  /** Read a fixed-width signed 64-bit little-endian integer. */
  readFixedInt64(): bigint {
    this.ensure(8);
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }

  /** Read a fixed-width unsigned 64-bit little-endian integer. */
  readFixedUint64(): bigint {
    this.ensure(8);
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  private ensure(length: number): void {
    if (this.offset + length > this.bytes.byteLength) {
      throw new QuackProtocolError(
        `Unexpected end of input at offset ${this.offset}; needed ${length} byte(s), have ${this.remaining}`
      );
    }
  }
}

/** Concatenate byte arrays into one Uint8Array. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Convert a bigint to number, rejecting values outside the safe integer range. */
export function bigIntToSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new QuackProtocolError(`${label} value ${value.toString()} exceeds JavaScript safe integer range`);
  }
  return Number(value);
}

/** Split a signed 128-bit integer into DuckDB HugeInt upper/lower words. */
export function splitSignedHugeInt(value: bigint): HugeIntParts {
  const lower = BigInt.asUintN(64, value);
  const upper = BigInt.asIntN(64, value >> 64n);
  return { lower, upper };
}

/** Combine DuckDB HugeInt parts into a signed bigint. */
export function combineSignedHugeInt(parts: HugeIntParts): bigint {
  return (BigInt.asIntN(64, parts.upper) << 64n) | BigInt.asUintN(64, parts.lower);
}

/** Combine DuckDB HugeInt parts into an unsigned bigint. */
export function combineUnsignedHugeInt(parts: HugeIntParts): bigint {
  return (BigInt.asUintN(64, parts.upper) << 64n) | BigInt.asUintN(64, parts.lower);
}

function toUnsignedBigInt(value: number | bigint): bigint {
  const result = BigInt(value);
  if (result < 0n) {
    throw new QuackProtocolError(`Expected unsigned integer, got ${value.toString()}`);
  }
  return result;
}
