import { describe, expect, it } from "vitest";
import { BinaryReader, BinaryWriter } from "../src/binary";
import { column, dataChunk } from "../src/builders";
import { LogicalTypes } from "../src/logical-types";
import { decodeDataChunk, decimalToString, encodeDataChunk, rowsFromChunk } from "../src/vector";
import type { DecimalValue } from "../src/vector";

describe("DataChunk and vector codecs", () => {
  it("round-trips primitive, decimal, list, array, and struct values", () => {
    const structType = LogicalTypes.struct([
      { name: "x", type: LogicalTypes.integer() },
      { name: "y", type: LogicalTypes.varchar() }
    ]);
    const chunk = dataChunk([
      column(LogicalTypes.boolean(), [true, false, null], "flag"),
      column(LogicalTypes.bigint(), [1n, 2n, null], "amount"),
      column(LogicalTypes.decimal(10, 2), ["12.34", { kind: "decimal", value: -500n, width: 10, scale: 2 }, null], "price"),
      column(LogicalTypes.list(LogicalTypes.integer()), [[1, 2], null, []], "items"),
      column(LogicalTypes.array(LogicalTypes.varchar(), 2), [["a", "b"], null, ["c", "d"]], "pair"),
      column(structType, [{ x: 1, y: "a" }, null, { x: 3, y: null }], "point")
    ]);

    const writer = new BinaryWriter();
    encodeDataChunk(writer, chunk);
    const decoded = decodeDataChunk(new BinaryReader(writer.toUint8Array()));
    const rows = rowsFromChunk(decoded, chunk.columnNames);

    expect(rows[0]?.flag).toBe(true);
    expect(rows[1]?.flag).toBe(false);
    expect(rows[2]?.flag).toBeNull();
    expect(rows[0]?.amount).toBe(1n);
    expect(decimalToString(rows[0]?.price as DecimalValue)).toBe("12.34");
    expect(decimalToString(rows[1]?.price as DecimalValue)).toBe("-5.00");
    expect(rows[0]?.items).toEqual([1, 2]);
    expect(rows[1]?.items).toBeNull();
    expect(rows[2]?.pair).toEqual(["c", "d"]);
    expect(rows[0]?.point).toEqual({ x: 1, y: "a" });
    expect(rows[2]?.point).toEqual({ x: 3, y: null });
  });
});
