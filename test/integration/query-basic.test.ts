import { describe, expect, it } from "vitest";
import { LogicalTypeId } from "../../src";
import { integrationUrl, withClient } from "./helpers";

describe.skipIf(!integrationUrl)("Quack basic query behavior", () => {
  it("preserves column names, order, and mixed row values", async () => {
    await withClient(async (client) => {
      const result = await client.query(`
        SELECT *
        FROM (
          VALUES
            (1::INTEGER, 'one'::VARCHAR),
            (2::INTEGER, 'two'::VARCHAR)
        ) AS t(id, label)
        ORDER BY id
      `);

      expect(result.names).toEqual(["id", "label"]);
      expect(result.types.map((type) => type.id)).toEqual([LogicalTypeId.INTEGER, LogicalTypeId.VARCHAR]);
      expect(result.rows()).toEqual([
        { id: 1, label: "one" },
        { id: 2, label: "two" }
      ]);
    });
  });

  it("returns schema information for empty result sets", async () => {
    await withClient(async (client) => {
      const result = await client.query("SELECT 1::INTEGER AS id, 'x'::VARCHAR AS label WHERE FALSE");
      expect(result.names).toEqual(["id", "label"]);
      expect(result.types.map((type) => type.id)).toEqual([LogicalTypeId.INTEGER, LogicalTypeId.VARCHAR]);
      expect(result.rows()).toEqual([]);
    });
  });

  it("materializes JSON-safe rows", async () => {
    await withClient(async (client) => {
      const result = await client.query(`
        SELECT
          9007199254740993::BIGINT AS big_v,
          12.34::DECIMAL(4, 2) AS decimal_v,
          'hi'::BLOB AS blob_v,
          TIMESTAMP '1970-01-01 00:00:01.234567' AS ts_v
      `);

      expect(result.jsonRows()).toEqual([
        {
          big_v: "9007199254740993",
          decimal_v: "12.34",
          blob_v: "aGk=",
          ts_v: "1970-01-01T00:00:01.234567Z"
        }
      ]);
    });
  });

  it("supports parameterized query helpers", async () => {
    await withClient(async (client) => {
      type ItemRow = { id: number; label: string };

      const first = await client.first<ItemRow>(
        "SELECT ?::INTEGER AS id, ?::VARCHAR AS label",
        [7, "seven"]
      );
      expect(first).toEqual({ id: 7, label: "seven" });

      const one = await client.one<ItemRow>(
        "SELECT :id::INTEGER AS id, :label::VARCHAR AS label",
        { id: 8, label: "eight" }
      );
      expect(one.label).toBe("eight");

      await expect(client.one("SELECT * FROM range(2)")).rejects.toThrow();
      expect(await client.first("SELECT 1 AS id WHERE FALSE")).toBeNull();
      expect(await client.values<bigint>("SELECT i FROM range(3) t(i) ORDER BY i")).toEqual([0n, 1n, 2n]);
    });
  });

  it("streams materialized rows", async () => {
    await withClient(async (client) => {
      const rows = [];
      for await (const row of client.streamRows<{ id: bigint }>("SELECT i AS id FROM range(?) t(i) ORDER BY i", [3])) {
        rows.push(row);
      }
      expect(rows).toEqual([{ id: 0n }, { id: 1n }, { id: 2n }]);
    });
  });
});
