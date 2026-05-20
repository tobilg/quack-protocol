import { decimal128, int32, tableFromArrays, utf8 } from "@uwdata/flechette";
import { describe, expect, it } from "vitest";
import {
  arrowIPCFromTable,
  dataChunksFromArrowIPC,
  decimalToString,
  LogicalTypes
} from "../../src";
import type { DecimalValue } from "../../src";
import { integrationUrl, uniqueName, withClient } from "./helpers";

describe.skipIf(!integrationUrl)("Quack Arrow integration", () => {
  it("queries results as Flechette Arrow tables and Arrow IPC bytes", async () => {
    await withClient(async (client) => {
      const table = await client.queryArrow(
        `
          SELECT
            1::INTEGER AS id,
            9007199254740993::BIGINT AS big_v,
            12.34::DECIMAL(10, 2) AS amount,
            DATE '1970-01-02' AS day,
            TIMESTAMP '1970-01-01 00:00:01.234567' AS ts,
            [1, 2]::INTEGER[] AS items
        `,
        {
          useBigInt: true,
          useDecimalInt: true,
          useBigIntTimestamp: true,
          useDate: true
        }
      );

      expect(table.numRows).toBe(1);
      expect(table.at(0)).toEqual({
        id: 1,
        big_v: 9007199254740993n,
        amount: 1234n,
        day: new Date("1970-01-02T00:00:00.000Z"),
        ts: 1234567n,
        items: new Int32Array([1, 2])
      });

      const ipc = await client.queryArrowIPC("SELECT 2::INTEGER AS id, 'two'::VARCHAR AS label", {
        useBigInt: true
      });
      const [chunk] = dataChunksFromArrowIPC(ipc, { useBigInt: true });
      expect(chunk?.columns.map((column) => column.values)).toEqual([[2], ["two"]]);
    });
  });

  it("appends Flechette Arrow tables and Arrow IPC bytes", async () => {
    await withClient(async (client) => {
      const tableName = uniqueName("quack_ts_arrow_append");
      await client.query(`CREATE TEMP TABLE ${tableName} (id INTEGER, label VARCHAR, amount DECIMAL(10, 2))`);

      const arrow = tableFromArrays(
        {
          id: [1, 2],
          label: ["one", "two"],
          amount: [1234n, null]
        },
        {
          types: {
            id: int32(),
            label: utf8(),
            amount: decimal128(10, 2)
          },
          useDecimalInt: true
        }
      );

      await client.appendArrow(tableName, arrow, {
        duckTypes: {
          id: LogicalTypes.integer(),
          label: LogicalTypes.varchar(),
          amount: LogicalTypes.decimal(10, 2)
        },
        useDecimalInt: true
      });

      const ipc = arrowIPCFromTable(arrow, { useDecimalInt: true });
      await client.appendArrow(tableName, ipc, {
        duckTypes: {
          id: LogicalTypes.integer(),
          label: LogicalTypes.varchar(),
          amount: LogicalTypes.decimal(10, 2)
        },
        useDecimalInt: true
      });

      const rows = (await client.query(`SELECT * FROM ${tableName} ORDER BY id, label`)).rows();
      expect(rows.map((row) => ({ id: row.id, label: row.label }))).toEqual([
        { id: 1, label: "one" },
        { id: 1, label: "one" },
        { id: 2, label: "two" },
        { id: 2, label: "two" }
      ]);
      expect(decimalToString(rows[0]?.amount as DecimalValue)).toBe("12.34");
      expect(decimalToString(rows[1]?.amount as DecimalValue)).toBe("12.34");
      expect(rows[2]?.amount).toBeNull();
      expect(rows[3]?.amount).toBeNull();
    });
  });
});
