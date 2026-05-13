import { QuackProtocolError } from "./errors";
import type { DateValue, DecimalValue, IntervalValue, TimeTzValue, TimeValue, TimestampValue } from "./vector";

/** Create a tagged DuckDB DECIMAL value from a scaled decimal literal. */
export function decimalValue(value: string | number | bigint, width: number, scale: number): DecimalValue {
  return {
    kind: "decimal",
    value: parseDecimalValue(value, scale),
    width,
    scale
  };
}

/** Create a tagged DuckDB DATE value from days since 1970-01-01. */
export function dateValue(days: number): DateValue {
  return { kind: "date", days };
}

/** Convert a JavaScript Date to a DuckDB DATE value using UTC date fields. */
export function dateFromJSDate(value: Date): DateValue {
  return dateValue(Math.trunc(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) / 86_400_000));
}

/** Create a DuckDB DATE value from an ISO `YYYY-MM-DD` string. */
export function dateFromISODate(value: string): DateValue {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time)) {
    throw new QuackProtocolError(`Invalid ISO date ${value}`);
  }
  return dateValue(Math.trunc(time / 86_400_000));
}

/** Convert a DuckDB DATE value to a JavaScript Date at UTC midnight. */
export function dateValueToJSDate(value: DateValue): Date {
  return new Date(value.days * 86_400_000);
}

/** Create a tagged DuckDB TIME or TIME_NS value. */
export function timeValue(value: bigint | number | string, unit: "micros" | "nanos" = "micros"): TimeValue {
  return { kind: "time", unit, value: BigInt(value) };
}

/** Create a tagged DuckDB TIME WITH TIME ZONE value from DuckDB's packed bits. */
export function timeTzValue(bits: bigint | number | string): TimeTzValue {
  return { kind: "time_tz", bits: BigInt(bits) };
}

/** Create a tagged DuckDB TIMESTAMP value in the specified unit. */
export function timestampValue(
  value: bigint | number | string,
  unit: "seconds" | "millis" | "micros" | "nanos" = "micros",
  timezone?: "utc"
): TimestampValue {
  return timezone === undefined
    ? { kind: "timestamp", unit, value: BigInt(value) }
    : { kind: "timestamp", unit, value: BigInt(value), timezone };
}

/** Convert a JavaScript Date to a tagged DuckDB TIMESTAMP value. */
export function timestampFromJSDate(
  value: Date,
  unit: "seconds" | "millis" | "micros" | "nanos" = "micros",
  timezone?: "utc"
): TimestampValue {
  const millis = BigInt(value.getTime());
  const encoded =
    unit === "seconds" ? millis / 1_000n : unit === "millis" ? millis : unit === "nanos" ? millis * 1_000_000n : millis * 1_000n;
  return timestampValue(encoded, unit, timezone);
}

/** Convert a tagged DuckDB TIMESTAMP value to a JavaScript Date. */
export function timestampValueToJSDate(value: TimestampValue): Date {
  const millis =
    value.unit === "seconds"
      ? value.value * 1_000n
      : value.unit === "millis"
        ? value.value
        : value.unit === "nanos"
          ? value.value / 1_000_000n
          : value.value / 1_000n;
  return new Date(Number(millis));
}

/** Create a tagged DuckDB INTERVAL value. */
export function intervalValue(months = 0, days = 0, micros: bigint | number | string = 0n): IntervalValue {
  return { kind: "interval", months, days, micros: BigInt(micros) };
}

function parseDecimalValue(value: string | number | bigint, scale: number): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  const text = String(value).trim();
  const negative = text.startsWith("-");
  const unsigned = negative || text.startsWith("+") ? text.slice(1) : text;
  const [integer = "0", fraction = ""] = unsigned.split(".");
  if (!/^\d+$/.test(integer || "0") || !/^\d*$/.test(fraction)) {
    throw new QuackProtocolError(`Invalid decimal value ${String(value)}`);
  }
  const paddedFraction = fraction.padEnd(scale, "0").slice(0, scale);
  const unscaled = BigInt(`${integer || "0"}${paddedFraction}` || "0");
  return negative ? -unscaled : unscaled;
}
