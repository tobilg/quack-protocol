import type {
  DateValue,
  DecimalValue,
  IntervalValue,
  QuackValue,
  TimeTzValue,
  TimeValue,
  TimestampValue
} from "./vector";
import { decimalToString } from "./vector";
import { QuackUnsupportedTypeError } from "./errors";
import {
  ExtraTypeInfoType,
  getArraySize,
  getChildType,
  getEnumValues,
  getStructChildren,
  LogicalTypeId
} from "./logical-types";
import type { LogicalType } from "./logical-types";

/** Scalar value accepted by the client-side SQL literal formatter. */
export type SqlParameterValue = QuackValue | Date | undefined;
/** SQL parameter value, including list literals represented as arrays. */
export type SqlParameter = SqlParameterValue | readonly SqlParameterValue[];
/** Positional SQL parameters used to replace `?` placeholders. */
export type PositionalSqlParameters = readonly SqlParameter[];
/** Named SQL parameters used to replace `:name` placeholders. */
export type NamedSqlParameters = Record<string, SqlParameter>;
/** Positional or named SQL parameters. */
export type SqlParameters = PositionalSqlParameters | NamedSqlParameters;

/**
 * Format SQL by replacing positional or named placeholders with SQL literals.
 *
 * This is a client-side formatter, not a server-side prepared statement bind.
 * Placeholders inside quoted strings and comments are ignored.
 */
export function formatSql(sql: string, params?: SqlParameters): string {
  if (params === undefined) {
    return sql;
  }
  return isPositionalSqlParameters(params) ? formatPositionalSql(sql, params) : formatNamedSql(sql, params);
}

/** Convert a JavaScript/Quack value to a DuckDB SQL literal. */
export function sqlLiteral(value: SqlParameter): string {
  if (value === undefined) {
    throw new TypeError("SQL parameter value is undefined; use null for SQL NULL");
  }
  if (value === null) {
    return "NULL";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => sqlLiteral(item)).join(", ")}]`;
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot encode non-finite SQL number ${value}`);
    }
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (value instanceof Uint8Array) {
    return `from_hex('${bytesToHex(value)}')`;
  }
  if (value instanceof Date) {
    return `TIMESTAMP '${formatDateTime(value, "millis")}'`;
  }
  if (isDecimalValue(value)) {
    return decimalToString(value);
  }
  if (isDateValue(value)) {
    return `DATE '${dateFromDays(value.days)}'`;
  }
  if (isTimeValue(value)) {
    return `TIME '${formatTime(value.value, value.unit)}'`;
  }
  if (isTimeTzValue(value)) {
    throw new TypeError("TIME WITH TIME ZONE parameters are not supported as SQL literals");
  }
  if (isTimestampValue(value)) {
    const keyword = value.timezone === "utc" ? "TIMESTAMPTZ" : "TIMESTAMP";
    return `${keyword} '${formatTimestamp(value)}'`;
  }
  if (isIntervalValue(value)) {
    return `INTERVAL '${value.months} months ${value.days} days ${value.micros.toString()} microseconds'`;
  }
  if (typeof value === "object") {
    throw new TypeError("Object SQL parameters are not supported; pass scalar values or arrays");
  }
  return String(value);
}

/** Quote a SQL identifier with double quotes, escaping embedded quotes. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Render a DuckDB logical type as SQL type text, for example `DECIMAL(10,2)` or
 * `STRUCT("a" INTEGER, "b" VARCHAR[])`.
 *
 * Type aliases are ignored so the result does not depend on user-defined types
 * being visible to the statement.
 */
export function logicalTypeToSql(type: LogicalType): string {
  switch (type.id) {
    case LogicalTypeId.SQLNULL:
      return '"NULL"';
    case LogicalTypeId.BOOLEAN:
    case LogicalTypeId.TINYINT:
    case LogicalTypeId.SMALLINT:
    case LogicalTypeId.INTEGER:
    case LogicalTypeId.BIGINT:
    case LogicalTypeId.UTINYINT:
    case LogicalTypeId.USMALLINT:
    case LogicalTypeId.UINTEGER:
    case LogicalTypeId.UBIGINT:
    case LogicalTypeId.HUGEINT:
    case LogicalTypeId.UHUGEINT:
    case LogicalTypeId.FLOAT:
    case LogicalTypeId.DOUBLE:
    case LogicalTypeId.VARCHAR:
    case LogicalTypeId.BLOB:
    case LogicalTypeId.BIT:
    case LogicalTypeId.BIGNUM:
    case LogicalTypeId.UUID:
    case LogicalTypeId.DATE:
    case LogicalTypeId.TIME:
    case LogicalTypeId.TIME_NS:
    case LogicalTypeId.TIMESTAMP:
    case LogicalTypeId.TIMESTAMP_MS:
    case LogicalTypeId.TIMESTAMP_NS:
    case LogicalTypeId.INTERVAL:
    case LogicalTypeId.VARIANT:
      return LogicalTypeId[type.id];
    case LogicalTypeId.CHAR:
      return "VARCHAR";
    case LogicalTypeId.TIMESTAMP_SEC:
      return "TIMESTAMP_S";
    case LogicalTypeId.TIMESTAMP_TZ:
      return "TIMESTAMP WITH TIME ZONE";
    case LogicalTypeId.TIMESTAMP_TZ_NS:
      return "TIMESTAMPTZ_NS";
    case LogicalTypeId.TIME_TZ:
      return "TIME WITH TIME ZONE";
    case LogicalTypeId.DECIMAL: {
      const info = type.typeInfo;
      if (info?.type !== ExtraTypeInfoType.DECIMAL) {
        return "DECIMAL";
      }
      return `DECIMAL(${info.width},${info.scale})`;
    }
    case LogicalTypeId.ENUM:
      return `ENUM(${getEnumValues(type).map((value) => sqlLiteral(value)).join(", ")})`;
    case LogicalTypeId.LIST:
      return `${logicalTypeToSql(getChildType(type))}[]`;
    case LogicalTypeId.ARRAY:
      return `${logicalTypeToSql(getChildType(type))}[${getArraySize(type)}]`;
    case LogicalTypeId.MAP: {
      const [key, value] = getStructChildren(getChildType(type));
      if (!key || !value) {
        throw new QuackUnsupportedTypeError("MAP type is missing key/value children");
      }
      return `MAP(${logicalTypeToSql(key.type)}, ${logicalTypeToSql(value.type)})`;
    }
    case LogicalTypeId.STRUCT:
      return `STRUCT(${getStructChildren(type)
        .map((child) => `${quoteIdentifier(child.name)} ${logicalTypeToSql(child.type)}`)
        .join(", ")})`;
    case LogicalTypeId.TUPLE:
      return `TUPLE(${getStructChildren(type).map((child) => logicalTypeToSql(child.type)).join(", ")})`;
    case LogicalTypeId.GEOMETRY: {
      const definition = type.typeInfo?.type === ExtraTypeInfoType.GEO ? type.typeInfo.crs?.definition : undefined;
      return definition ? `GEOMETRY(${sqlLiteral(definition)})` : "GEOMETRY";
    }
    default:
      throw new QuackUnsupportedTypeError(`Cannot render DuckDB logical type ${LogicalTypeId[type.id] ?? type.id} as SQL`);
  }
}

function formatPositionalSql(sql: string, params: PositionalSqlParameters): string {
  let index = 0;
  const formatted = scanSql(sql, (token) => {
    if (token !== "?") {
      return token;
    }
    const value = params[index];
    if (index >= params.length) {
      throw new Error("SQL has more positional placeholders than parameters");
    }
    index++;
    return sqlLiteral(value);
  });
  if (index !== params.length) {
    throw new Error(`SQL has ${index} positional placeholders but ${params.length} parameters were provided`);
  }
  return formatted;
}

function formatNamedSql(sql: string, params: NamedSqlParameters): string {
  return scanSql(sql, (token) => {
    if (!token.startsWith(":")) {
      return token;
    }
    const name = token.slice(1);
    if (!(name in params)) {
      throw new Error(`Missing SQL parameter :${name}`);
    }
    return sqlLiteral(params[name]);
  });
}

function scanSql(sql: string, replaceToken: (token: string) => string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "'") {
      const { text, end } = readSingleQuoted(sql, index);
      output += text;
      index = end;
      continue;
    }
    if (char === '"') {
      const { text, end } = readDoubleQuoted(sql, index);
      output += text;
      index = end;
      continue;
    }
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index + 2);
      const commentEnd = end < 0 ? sql.length : end;
      output += sql.slice(index, commentEnd);
      index = commentEnd;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      const commentEnd = end < 0 ? sql.length : end + 2;
      output += sql.slice(index, commentEnd);
      index = commentEnd;
      continue;
    }
    if (char === "?") {
      output += replaceToken("?");
      index++;
      continue;
    }
    if (char === ":" && sql[index - 1] !== ":" && next !== ":" && isIdentifierStart(next ?? "")) {
      const start = index + 1;
      let end = start + 1;
      while (end < sql.length && isIdentifierPart(sql[end] ?? "")) {
        end++;
      }
      output += replaceToken(`:${sql.slice(start, end)}`);
      index = end;
      continue;
    }

    output += char;
    index++;
  }
  return output;
}

function readSingleQuoted(sql: string, start: number): { text: string; end: number } {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === "'" && sql[index + 1] === "'") {
      index += 2;
      continue;
    }
    if (sql[index] === "'") {
      index++;
      break;
    }
    index++;
  }
  return { text: sql.slice(start, index), end: index };
}

function readDoubleQuoted(sql: string, start: number): { text: string; end: number } {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === '"' && sql[index + 1] === '"') {
      index += 2;
      continue;
    }
    if (sql[index] === '"') {
      index++;
      break;
    }
    index++;
  }
  return { text: sql.slice(start, index), end: index };
}

function isIdentifierStart(char: string): boolean {
  return /^[A-Za-z_]$/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /^[A-Za-z0-9_]$/.test(char);
}

function isPositionalSqlParameters(params: SqlParameters): params is PositionalSqlParameters {
  return Array.isArray(params);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dateFromDays(days: number): string {
  return new Date(days * 86_400_000).toISOString().slice(0, 10);
}

function formatTimestamp(value: TimestampValue): string {
  const micros =
    value.unit === "seconds"
      ? value.value * 1_000_000n
      : value.unit === "millis"
        ? value.value * 1_000n
        : value.unit === "nanos"
          ? value.value / 1_000n
          : value.value;
  const date = new Date(Number(micros / 1_000n));
  const base = date.toISOString().replace("T", " ").replace("Z", "");
  return `${base}${value.timezone === "utc" ? "+00" : ""}`;
}

function formatDateTime(value: Date, unit: "millis"): string {
  void unit;
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function formatTime(value: bigint, unit: "micros" | "nanos"): string {
  const nanos = unit === "nanos" ? value : value * 1_000n;
  const totalSeconds = nanos / 1_000_000_000n;
  const fraction = nanos % 1_000_000_000n;
  const hours = totalSeconds / 3600n;
  const minutes = (totalSeconds % 3600n) / 60n;
  const seconds = totalSeconds % 60n;
  const fractionText = fraction === 0n ? "" : `.${fraction.toString().padStart(9, "0").replace(/0+$/, "")}`;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}${fractionText}`;
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
