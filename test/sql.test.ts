import { describe, expect, it } from "vitest";
import { LogicalTypes } from "../src/logical-types";
import { formatSql, logicalTypeToSql, quoteIdentifier, sqlLiteral } from "../src/sql";
import { dateFromISODate, intervalValue, timestampValue } from "../src/values";

describe("SQL parameter formatting", () => {
  it("formats scalar SQL literals", () => {
    expect(sqlLiteral("can't")).toBe("'can''t'");
    expect(sqlLiteral(true)).toBe("TRUE");
    expect(sqlLiteral(42n)).toBe("42");
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral([1, "two", null])).toBe("[1, 'two', NULL]");
  });

  it("formats DuckDB-specific value objects", () => {
    expect(sqlLiteral(dateFromISODate("2020-01-02"))).toBe("DATE '2020-01-02'");
    expect(sqlLiteral(timestampValue(1n, "seconds"))).toBe("TIMESTAMP '1970-01-01 00:00:01.000'");
    expect(sqlLiteral(intervalValue(1, 2, 3n))).toBe("INTERVAL '1 months 2 days 3 microseconds'");
  });

  it("replaces positional placeholders outside strings and comments", () => {
    expect(formatSql("SELECT '?' AS s, ? AS v -- ?\n", [42])).toBe("SELECT '?' AS s, 42 AS v -- ?\n");
  });

  it("replaces named placeholders without touching casts", () => {
    expect(formatSql("SELECT :id::INTEGER AS id, :label AS label", { id: 7, label: "seven" })).toBe(
      "SELECT 7::INTEGER AS id, 'seven' AS label"
    );
  });

  it("throws for placeholder count mismatches and undefined values", () => {
    expect(() => formatSql("SELECT ?, ?", [1])).toThrow();
    expect(() => formatSql("SELECT ?", [undefined])).toThrow();
  });
});

describe("SQL type rendering", () => {
  it("quotes identifiers", () => {
    expect(quoteIdentifier("items")).toBe('"items"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });

  it("renders DuckDB type text for append prototypes", () => {
    expect(logicalTypeToSql(LogicalTypes.decimal(10, 3))).toBe("DECIMAL(10,3)");
    expect(logicalTypeToSql(LogicalTypes.timestampSeconds())).toBe("TIMESTAMP_S");
    expect(logicalTypeToSql(LogicalTypes.timestampTz())).toBe("TIMESTAMP WITH TIME ZONE");
    expect(logicalTypeToSql(LogicalTypes.timestampTzNanos())).toBe("TIMESTAMPTZ_NS");
    expect(logicalTypeToSql(LogicalTypes.timeTz())).toBe("TIME WITH TIME ZONE");
    expect(logicalTypeToSql(LogicalTypes.null())).toBe('"NULL"');
    expect(logicalTypeToSql(LogicalTypes.array(LogicalTypes.list(LogicalTypes.integer()), 2))).toBe("INTEGER[][2]");
    expect(logicalTypeToSql(LogicalTypes.map(LogicalTypes.varchar(), LogicalTypes.double()))).toBe("MAP(VARCHAR, DOUBLE)");
    expect(logicalTypeToSql(LogicalTypes.enum(["it's", "ok"]))).toBe("ENUM('it''s', 'ok')");
    expect(
      logicalTypeToSql(
        LogicalTypes.struct([
          { name: "a b", type: LogicalTypes.integer() },
          { name: "c", type: LogicalTypes.tuple([LogicalTypes.uuid(), LogicalTypes.blob()]) }
        ])
      )
    ).toBe('STRUCT("a b" INTEGER, "c" TUPLE(UUID, BLOB))');
    expect(logicalTypeToSql(LogicalTypes.geometry({ definition: "EPSG:4326" }))).toBe("GEOMETRY('EPSG:4326')");
  });
});
