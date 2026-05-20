import { tableFromIPC } from "@uwdata/flechette";
import { describe, expect, it } from "vitest";
import {
  arrowIPCFromChunks,
  arrowTableFromDataChunk,
  column,
  dataChunk,
  dataChunksFromArrowIPC,
  dataChunksFromArrowTable,
  ExtraTypeInfoType,
  LogicalTypeId,
  LogicalTypes,
  logicalType
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
});
