import { field, int32, tableFromIPC, Table, Version, Endianness, runEndEncoded } from "@uwdata/flechette";
import { describe, expect, it } from "vitest";
import {
  arrowIPCFromChunks,
  arrowTableFromDataChunk,
  arrowTableFromChunks,
  column,
  dataChunk,
  dataChunksFromArrowIPC,
  dataChunksFromArrowTable,
  ExtraTypeInfoType,
  LogicalTypeId,
  LogicalTypes,
  logicalType,
  QuackUnsupportedTypeError
} from "../src";

describe("Arrow conversion helpers", () => {
  it("converts Quack chunks to Flechette tables using Flechette extraction options", () => {
    const structType = LogicalTypes.struct([
      { name: "a", type: LogicalTypes.integer() },
      { name: "b", type: LogicalTypes.varchar() }
    ]);
    const mapType = logicalType(LogicalTypeId.MAP, {
      type: ExtraTypeInfoType.LIST,
      childType: LogicalTypes.struct([
        { name: "key", type: LogicalTypes.varchar() },
        { name: "value", type: LogicalTypes.integer() }
      ])
    });
    const chunk = dataChunk([
      column(LogicalTypes.decimal(10, 2), [{ kind: "decimal", value: 1234n, width: 10, scale: 2 }, null], "price"),
      column(LogicalTypes.timestamp(), [{ kind: "timestamp", unit: "micros", value: 1234567n }, null], "ts"),
      column(LogicalTypes.date(), [{ kind: "date", days: 1 }, null], "day"),
      column(LogicalTypes.list(LogicalTypes.integer()), [[1, 2], null], "items"),
      column(structType, [{ a: 1, b: "x" }, null], "item"),
      column(mapType, [[{ key: "k", value: 7 }], null], "attrs"),
      column(LogicalTypes.array(LogicalTypes.varchar(), 2), [["a", "b"], null], "pair")
    ]);

    const defaults = arrowTableFromDataChunk(chunk);
    expect(defaults.numRows).toBe(2);
    expect(defaults.names).toEqual(["price", "ts", "day", "items", "item", "attrs", "pair"]);
    expect(defaults.at(0)).toMatchObject({
      price: 12.34,
      ts: 1234.567,
      day: 86400000,
      item: { a: 1, b: "x" },
      pair: ["a", "b"]
    });
    expect(Array.from(defaults.getChild("items").at(0)!)).toEqual([1, 2]);
    expect(defaults.getChild("attrs").at(0)).toEqual([["k", 7]]);

    const configured = arrowTableFromDataChunk(chunk, undefined, {
      useDate: true,
      useDecimalInt: true,
      useBigIntTimestamp: true,
      useMap: true
    });
    const row = configured.at(0)!;
    expect(row.price).toBe(1234n);
    expect(row.ts).toBe(1234567n);
    expect(row.day).toEqual(new Date("1970-01-02T00:00:00.000Z"));
    expect(row.attrs).toEqual(new Map([["k", 7]]));

    const [roundTripped] = dataChunksFromArrowTable(configured);
    expect(roundTripped?.columns.map((col) => col.values)).toEqual([
      [1234n, null],
      [{ kind: "timestamp", unit: "micros", value: 1234567n }, null],
      [{ kind: "date", days: 1 }, null],
      [[1, 2], null],
      [{ a: 1, b: "x" }, null],
      [[{ key: "k", value: 7 }], null],
      [["a", "b"], null]
    ]);
  });

  it("encodes and decodes Arrow IPC with Quack logical type metadata", () => {
    const chunk = dataChunk([
      column(LogicalTypes.bigint(), [9007199254740993n, null], "id"),
      column(LogicalTypes.timestamp(), [{ kind: "timestamp", unit: "micros", value: 1234567n }, null], "ts")
    ]);

    const ipc = arrowIPCFromChunks([chunk], chunk.columnNames, {
      duckTypes: chunk.types,
      useBigInt: true,
      useBigIntTimestamp: true
    });
    const table = tableFromIPC(ipc, { useBigInt: true, useBigIntTimestamp: true });
    expect(table.toArray()).toEqual([
      { id: 9007199254740993n, ts: 1234567n },
      { id: null, ts: null }
    ]);

    const [roundTripped] = dataChunksFromArrowIPC(ipc, { useBigInt: true, useBigIntTimestamp: true });
    expect(roundTripped?.columns.map((col) => col.values)).toEqual([
      [9007199254740993n, null],
      [{ kind: "timestamp", unit: "micros", value: 1234567n }, null]
    ]);
  });

  it("preserves zero-row Arrow table schemas", () => {
    const table = arrowTableFromChunks(
      [],
      ["id", "label"],
      {
        duckTypes: [LogicalTypes.integer(), LogicalTypes.varchar()]
      }
    );

    expect(table.numRows).toBe(0);
    expect(table.names).toEqual(["id", "label"]);
    expect(table.schema.fields.map((field) => field.type.typeId)).toEqual([2, 5]);

    const [chunk] = dataChunksFromArrowTable(table);
    expect(chunk?.rowCount).toBe(0);
    expect(chunk?.types.map((type) => type.id)).toEqual([LogicalTypeId.INTEGER, LogicalTypeId.VARCHAR]);
    expect(chunk?.columnNames).toEqual(["id", "label"]);
  });

  it("round-trips Arrow IPC file format and special DuckDB scalar metadata", () => {
    const enumType = LogicalTypes.enum(["sad", "ok", "happy"]);
    const chunk = dataChunk([
      column(LogicalTypes.uuid(), ["00112233-4455-6677-8899-aabbccddeeff"], "uuid_v"),
      column(enumType, ["happy"], "enum_v"),
      column(LogicalTypes.blob(), [new Uint8Array([1, 2, 3])], "blob_v"),
      column(LogicalTypes.timeTz(), [{ kind: "time_tz", bits: 123n }], "timetz_v"),
      column(LogicalTypes.decimal(38, 4), [{ kind: "decimal", value: 1234567890123456789012345678901234n, width: 38, scale: 4 }], "huge_dec_v")
    ]);

    const ipc = arrowIPCFromChunks([chunk], chunk.columnNames, {
      duckTypes: chunk.types,
      format: "file",
      useDecimalInt: true,
      useBigInt: true
    });
    const table = tableFromIPC(ipc, { useDecimalInt: true, useBigInt: true });
    expect(table.at(0)).toMatchObject({
      uuid_v: "00112233-4455-6677-8899-aabbccddeeff",
      enum_v: "happy",
      timetz_v: 123n,
      huge_dec_v: 1234567890123456789012345678901234n
    });
    expect(table.getChild("blob_v").at(0)).toEqual(new Uint8Array([1, 2, 3]));

    const [roundTripped] = dataChunksFromArrowIPC(ipc, { useDecimalInt: true, useBigInt: true });
    expect(roundTripped?.types.map((type) => type.id)).toEqual([
      LogicalTypeId.UUID,
      LogicalTypeId.ENUM,
      LogicalTypeId.BLOB,
      LogicalTypeId.TIME_TZ,
      LogicalTypeId.DECIMAL
    ]);
    expect(roundTripped?.columns.map((col) => col.values)).toEqual([
      ["00112233-4455-6677-8899-aabbccddeeff"],
      ["happy"],
      [new Uint8Array([1, 2, 3])],
      [{ kind: "time_tz", bits: 123n }],
      [1234567890123456789012345678901234n]
    ]);
  });

  it("fails clearly for unsupported Arrow types", () => {
    const unsupported = new Table(
      {
        version: Version.V5,
        endianness: Endianness.Little,
        fields: [field("encoded", runEndEncoded(field("run_ends", int32()), field("values", int32())))],
        metadata: null
      },
      []
    );

    expect(() => dataChunksFromArrowTable(unsupported)).toThrow(QuackUnsupportedTypeError);
  });
});
