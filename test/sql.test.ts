import { describe, expect, it } from "vitest";
import { formatSql, sqlLiteral } from "../src/sql";
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
