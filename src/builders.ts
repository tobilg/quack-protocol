import { QuackProtocolError } from "./errors";
import {
  getChildType,
  getStructChildren,
  LogicalTypeId,
  LogicalTypes
} from "./logical-types";
import type { ChildType, LogicalType } from "./logical-types";
import { dateFromJSDate, timestampFromJSDate } from "./values";
import { VectorType } from "./vector";
import type { DateValue, DecodedVector, DecimalValue, IntervalValue, QuackDataChunk, QuackValue, TimeTzValue, TimeValue, TimestampValue } from "./vector";

/** Input for one column when building a flat DuckDB DataChunk. */
export interface ColumnInput {
  /** Optional column name kept for local row materialization. */
  name?: string;
  /** DuckDB logical type used to encode the column values. */
  type: LogicalType;
  /** Column values in row order. */
  values: readonly QuackValue[];
}

/** Named logical type used by row-to-chunk helpers. */
export interface ColumnDefinition {
  /** Row property name and resulting chunk column name. */
  name: string;
  /** DuckDB logical type for the column. */
  type: LogicalType;
}

/** Column schema accepted by {@link dataChunkFromRows}. */
export type ColumnSchema<T extends Record<string, unknown>> =
  | Partial<Record<Extract<keyof T, string>, LogicalType>>
  | readonly ColumnDefinition[];

/** Options for building a DataChunk from row objects. */
export interface DataChunkFromRowsOptions<T extends Record<string, unknown>> {
  /** Explicit column types and order. Required for empty rows or all-null columns. */
  columns?: ColumnSchema<T>;
}

/** Create one flat DataChunk column input. */
export function column(type: LogicalType, values: readonly QuackValue[], name?: string): ColumnInput {
  return name ? { name, type, values } : { type, values };
}

/**
 * Build a flat DuckDB DataChunk from column-oriented values.
 *
 * All columns must have the same number of values.
 */
export function dataChunk(columns: readonly ColumnInput[]): QuackDataChunk {
  if (columns.length === 0) {
    throw new QuackProtocolError("A Quack DataChunk must contain at least one column");
  }
  const rowCount = columns[0]?.values.length ?? 0;
  const decodedColumns: DecodedVector[] = [];
  const types: LogicalType[] = [];
  const columnNames: string[] = [];
  for (let index = 0; index < columns.length; index++) {
    const input = columns[index];
    if (!input) {
      throw new QuackProtocolError(`Missing column ${index}`);
    }
    if (input.values.length !== rowCount) {
      throw new QuackProtocolError(`Column ${index} has ${input.values.length} values, expected ${rowCount}`);
    }
    types.push(input.type);
    columnNames.push(input.name ?? `column${index}`);
    decodedColumns.push({
      type: input.type,
      vectorType: VectorType.FLAT,
      values: [...input.values]
    });
  }
  return {
    rowCount,
    types,
    columns: decodedColumns,
    columnNames
  };
}

/**
 * Build a flat DuckDB DataChunk from row objects.
 *
 * When `columns` is omitted, logical types are inferred from the first
 * non-null value in each column. Explicit column schemas are recommended for
 * append workloads.
 */
export function dataChunkFromRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  options: DataChunkFromRowsOptions<T> = {}
): QuackDataChunk {
  const definitions = resolveColumnDefinitions(rows, options.columns);
  return dataChunk(
    definitions.map((definition) =>
      column(
        definition.type,
        rows.map((row) => normalizeAppendValue(row[definition.name], definition.type)),
        definition.name
      )
    )
  );
}

function resolveColumnDefinitions<T extends Record<string, unknown>>(
  rows: readonly T[],
  schema: ColumnSchema<T> | undefined
): ColumnDefinition[] {
  if (Array.isArray(schema)) {
    return schema.map((definition) => ({ name: definition.name, type: definition.type }));
  }
  if (schema) {
    return Object.entries(schema).map(([name, type]) => {
      if (!type) {
        throw new QuackProtocolError(`Column ${name} is missing a logical type`);
      }
      return { name, type };
    });
  }
  const first = rows[0];
  if (!first) {
    throw new QuackProtocolError("Cannot infer append row columns from an empty row set");
  }
  return Object.keys(first).map((name) => ({
    name,
    type: inferLogicalType(rows.map((row) => row[name]))
  }));
}

function inferLogicalType(values: readonly unknown[]): LogicalType {
  const value = values.find((item) => item !== null && item !== undefined);
  if (value === undefined || value === null) {
    throw new QuackProtocolError("Cannot infer logical type from only null values");
  }
  if (typeof value === "boolean") {
    return LogicalTypes.boolean();
  }
  if (typeof value === "bigint") {
    return LogicalTypes.bigint();
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647
      ? LogicalTypes.integer()
      : LogicalTypes.double();
  }
  if (typeof value === "string") {
    return LogicalTypes.varchar();
  }
  if (value instanceof Uint8Array) {
    return LogicalTypes.blob();
  }
  if (value instanceof Date) {
    return LogicalTypes.timestamp();
  }
  if (Array.isArray(value)) {
    const childValues = values.flatMap((item) => (Array.isArray(item) ? item : []));
    return LogicalTypes.list(inferLogicalType(childValues));
  }
  if (isDecimalValue(value)) {
    return LogicalTypes.decimal(value.width, value.scale);
  }
  if (isDateValue(value)) {
    return LogicalTypes.date();
  }
  if (isTimeValue(value)) {
    return value.unit === "nanos" ? LogicalTypes.timeNs() : LogicalTypes.time();
  }
  if (isTimeTzValue(value)) {
    return LogicalTypes.timeTz();
  }
  if (isTimestampValue(value)) {
    switch (value.unit) {
      case "seconds":
        return LogicalTypes.timestampSeconds();
      case "millis":
        return LogicalTypes.timestampMillis();
      case "nanos":
        return LogicalTypes.timestampNanos();
      default:
        return value.timezone === "utc" ? LogicalTypes.timestampTz() : LogicalTypes.timestamp();
    }
  }
  if (isIntervalValue(value)) {
    return LogicalTypes.interval();
  }
  if (typeof value === "object") {
    return LogicalTypes.struct(
      Object.keys(value as Record<string, unknown>).map((name): ChildType => {
        const childValues = values.map((item) =>
          item && typeof item === "object" && !Array.isArray(item) && !(item instanceof Uint8Array)
            ? (item as Record<string, unknown>)[name]
            : null
        );
        return { name, type: inferLogicalType(childValues) };
      })
    );
  }
  throw new QuackProtocolError(`Cannot infer logical type for value ${String(value)}`);
}

function normalizeAppendValue(value: unknown, type: LogicalType): QuackValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (value instanceof Date) {
    if (type.id === LogicalTypeId.DATE) {
      return dateFromJSDate(value);
    }
    if (isTimestampLogicalType(type)) {
      return timestampFromJSDate(value, timestampUnitForType(type), type.id === LogicalTypeId.TIMESTAMP_TZ ? "utc" : undefined);
    }
  }
  if (Array.isArray(value)) {
    const childType = type.id === LogicalTypeId.LIST || type.id === LogicalTypeId.MAP || type.id === LogicalTypeId.ARRAY ? getChildType(type) : undefined;
    return childType ? value.map((item) => normalizeAppendValue(item, childType)) : value.map((item) => normalizeAppendValue(item, LogicalTypes.varchar()));
  }
  if (typeof value === "object" && !(value instanceof Uint8Array)) {
    if (type.id === LogicalTypeId.STRUCT) {
      const children = getStructChildren(type);
      const record = value as Record<string, unknown>;
      const normalized: Record<string, QuackValue> = {};
      for (const child of children) {
        normalized[child.name] = normalizeAppendValue(record[child.name], child.type);
      }
      return normalized;
    }
    if (type.id === LogicalTypeId.MAP && Array.isArray(value)) {
      const childType = getChildType(type);
      return value.map((item) => normalizeAppendValue(item, childType));
    }
  }
  return value as QuackValue;
}

function isTimestampLogicalType(type: LogicalType): boolean {
  return (
    type.id === LogicalTypeId.TIMESTAMP ||
    type.id === LogicalTypeId.TIMESTAMP_SEC ||
    type.id === LogicalTypeId.TIMESTAMP_MS ||
    type.id === LogicalTypeId.TIMESTAMP_NS ||
    type.id === LogicalTypeId.TIMESTAMP_TZ
  );
}

function timestampUnitForType(type: LogicalType): "seconds" | "millis" | "micros" | "nanos" {
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

function isDecimalValue(value: unknown): value is DecimalValue {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "decimal";
}

function isDateValue(value: unknown): value is DateValue {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "date";
}

function isTimeValue(value: unknown): value is TimeValue {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "time";
}

function isTimeTzValue(value: unknown): value is TimeTzValue {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "time_tz";
}

function isTimestampValue(value: unknown): value is TimestampValue {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "timestamp";
}

function isIntervalValue(value: unknown): value is IntervalValue {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "interval";
}
