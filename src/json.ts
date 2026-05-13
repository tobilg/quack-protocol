import { QuackProtocolError } from "./errors";
import { decimalToString } from "./vector";
import type {
  DateValue,
  DecimalValue,
  IntervalValue,
  QuackRow,
  QuackValue,
  TimeTzValue,
  TimeValue,
  TimestampValue
} from "./vector";

/** JSON-safe representation of a Quack value. */
export type QuackJsonValue =
  | null
  | boolean
  | number
  | string
  | QuackJsonValue[]
  | { [key: string]: QuackJsonValue };

/** JSON-safe row object keyed by column name. */
export type QuackJsonRow = Record<string, QuackJsonValue>;

/** Options controlling how Quack-specific values are converted to JSON. */
export interface QuackJsonOptions {
  /** How bigint values are converted. Defaults to `string`. */
  bigint?: "string" | "number";
  /** How binary values are converted. Defaults to `base64`. */
  bytes?: "base64" | "hex" | "array";
  /** How DECIMAL values are converted. Defaults to `string`. */
  decimal?: "string" | "tagged";
  /** How DATE values are converted. Defaults to `iso`. */
  date?: "iso" | "tagged";
  /** How TIME values are converted. Defaults to `string`. */
  time?: "string" | "tagged";
  /** How TIMESTAMP values are converted. Defaults to `iso`. */
  timestamp?: "iso" | "tagged";
  /** How INTERVAL values are converted. Defaults to `tagged`. */
  interval?: "tagged";
}

/** Convert any Quack value to a JSON-safe value. */
export function toJsonValue(value: QuackValue, options: QuackJsonOptions = {}): QuackJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (typeof value === "bigint") {
    return bigintToJson(value, options);
  }
  if (value instanceof Uint8Array) {
    return bytesToJson(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item, options));
  }
  if (isDecimalValue(value)) {
    return options.decimal === "tagged"
      ? { kind: "decimal", value: value.value.toString(), width: value.width, scale: value.scale }
      : decimalToString(value);
  }
  if (isDateValue(value)) {
    return options.date === "tagged" ? { kind: "date", days: value.days } : dateToIso(value);
  }
  if (isTimeValue(value)) {
    return options.time === "tagged"
      ? { kind: "time", unit: value.unit, value: value.value.toString() }
      : timeToString(value);
  }
  if (isTimeTzValue(value)) {
    return { kind: "time_tz", bits: value.bits.toString() };
  }
  if (isTimestampValue(value)) {
    return options.timestamp === "tagged"
      ? {
          kind: "timestamp",
          unit: value.unit,
          value: value.value.toString(),
          ...(value.timezone === undefined ? {} : { timezone: value.timezone })
        }
      : timestampToIso(value);
  }
  if (isIntervalValue(value)) {
    return {
      kind: "interval",
      months: value.months,
      days: value.days,
      micros: value.micros.toString()
    };
  }

  const row: QuackJsonRow = {};
  for (const [key, nested] of Object.entries(value)) {
    row[key] = toJsonValue(nested, options);
  }
  return row;
}

/** Convert one materialized Quack row to a JSON-safe row. */
export function toJsonRow(row: QuackRow, options: QuackJsonOptions = {}): QuackJsonRow {
  return toJsonValue(row, options) as QuackJsonRow;
}

/** Convert materialized Quack rows to JSON-safe row objects. */
export function toJsonRows(rows: readonly QuackRow[], options: QuackJsonOptions = {}): QuackJsonRow[] {
  return rows.map((row) => toJsonRow(row, options));
}

function bigintToJson(value: bigint, options: QuackJsonOptions): string | number {
  if (options.bigint !== "number") {
    return value.toString();
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new QuackProtocolError(`bigint value ${value.toString()} exceeds JavaScript safe integer range`);
  }
  return Number(value);
}

function bytesToJson(value: Uint8Array, options: QuackJsonOptions): string | number[] {
  switch (options.bytes ?? "base64") {
    case "array":
      return [...value];
    case "hex":
      return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    case "base64":
      return bytesToBase64(value);
    default:
      throw new QuackProtocolError(`Unhandled JSON bytes conversion option ${String(options.bytes)}`);
  }
}

function dateToIso(value: DateValue): string {
  return new Date(value.days * 86_400_000).toISOString().slice(0, 10);
}

function timeToString(value: TimeValue): string {
  const nanos = value.unit === "nanos" ? value.value : value.value * 1_000n;
  const totalSeconds = floorDiv(nanos, 1_000_000_000n);
  const fraction = nanos - totalSeconds * 1_000_000_000n;
  const hours = totalSeconds / 3_600n;
  const minutes = (totalSeconds % 3_600n) / 60n;
  const seconds = totalSeconds % 60n;
  const fractionText = fraction === 0n ? "" : `.${fraction.toString().padStart(9, "0").replace(/0+$/, "")}`;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}${fractionText}`;
}

function timestampToIso(value: TimestampValue): string {
  const nanos =
    value.unit === "seconds"
      ? value.value * 1_000_000_000n
      : value.unit === "millis"
        ? value.value * 1_000_000n
        : value.unit === "micros"
          ? value.value * 1_000n
          : value.value;
  const seconds = floorDiv(nanos, 1_000_000_000n);
  const fraction = nanos - seconds * 1_000_000_000n;
  const millis = seconds * 1_000n;
  if (millis > BigInt(Number.MAX_SAFE_INTEGER) || millis < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new QuackProtocolError(`timestamp value ${value.value.toString()} is outside JavaScript Date range`);
  }
  const base = new Date(Number(millis)).toISOString().replace(".000Z", "");
  const fractionText = fraction === 0n ? "" : `.${fraction.toString().padStart(9, "0").replace(/0+$/, "")}`;
  return `${base}${fractionText}Z`;
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder < 0n ? quotient - 1n : quotient;
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const combined = (first << 16) | (second << 8) | third;
    output += alphabet[(combined >> 18) & 0x3f];
    output += alphabet[(combined >> 12) & 0x3f];
    output += index + 1 < bytes.length ? alphabet[(combined >> 6) & 0x3f] : "=";
    output += index + 2 < bytes.length ? alphabet[combined & 0x3f] : "=";
  }
  return output;
}

function isDecimalValue(value: object): value is DecimalValue {
  return (value as { kind?: unknown }).kind === "decimal";
}

function isDateValue(value: object): value is DateValue {
  return (value as { kind?: unknown }).kind === "date";
}

function isTimeValue(value: object): value is TimeValue {
  return (value as { kind?: unknown }).kind === "time";
}

function isTimeTzValue(value: object): value is TimeTzValue {
  return (value as { kind?: unknown }).kind === "time_tz";
}

function isTimestampValue(value: object): value is TimestampValue {
  return (value as { kind?: unknown }).kind === "timestamp";
}

function isIntervalValue(value: object): value is IntervalValue {
  return (value as { kind?: unknown }).kind === "interval";
}
