import { describe, expect, it } from "vitest";
import { dataChunkFromRows, LogicalTypeId, LogicalTypes, rowsFromChunk } from "../src";
import { dateFromISODate, decimalValue } from "../src/values";

describe("friendly DataChunk builders", () => {
  it("builds chunks from rows with explicit column types", () => {
    const chunk = dataChunkFromRows(
      [
        { id: 1, label: "one", amount: "12.34" },
        { id: 2, label: "two", amount: null }
      ],
      {
        columns: {
          id: LogicalTypes.integer(),
          label: LogicalTypes.varchar(),
          amount: LogicalTypes.decimal(10, 2)
        }
      }
    );

    expect(chunk.types.map((type) => type.id)).toEqual([
      LogicalTypeId.INTEGER,
      LogicalTypeId.VARCHAR,
      LogicalTypeId.DECIMAL
    ]);
    expect(rowsFromChunk(chunk)).toEqual([
      { id: 1, label: "one", amount: "12.34" },
      { id: 2, label: "two", amount: null }
    ]);
  });

  it("infers common logical types from rows", () => {
    const chunk = dataChunkFromRows([
      { id: 1, ok: true, label: "one", day: dateFromISODate("2020-01-02"), amount: decimalValue("12.34", 10, 2) }
    ]);

    expect(chunk.types.map((type) => type.id)).toEqual([
      LogicalTypeId.INTEGER,
      LogicalTypeId.BOOLEAN,
      LogicalTypeId.VARCHAR,
      LogicalTypeId.DATE,
      LogicalTypeId.DECIMAL
    ]);
  });
});
