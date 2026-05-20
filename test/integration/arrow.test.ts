import { decimal128, int32, tableFromArrays, utf8 } from "@uwdata/flechette";
import { describe, expect, it } from "vitest";
import {
  arrowIPCFromTable,
  dataChunksFromArrowIPC,
  decimalToString,
  LogicalTypeId,
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

  it("supports Arrow query parameters, streaming, zero-row results, and IPC file format", async () => {
    await withClient(async (client) => {
      const positional = await client.queryArrow(
        "SELECT ?::INTEGER AS id, ?::VARCHAR AS label",
        [7, "seven"]
      );
      expect(positional.toArray()).toEqual([{ id: 7, label: "seven" }]);

      const named = await client.queryArrowIPC(
        "SELECT :id::INTEGER AS id, :label::VARCHAR AS label",
        { id: 8, label: "eight" },
        { format: "file" }
      );
      const [namedChunk] = dataChunksFromArrowIPC(named);
      expect(namedChunk?.columns.map((column) => column.values)).toEqual([[8], ["eight"]]);

      const streamed = [];
      for await (const table of client.streamArrow("SELECT i::INTEGER AS id FROM range(3) t(i) ORDER BY i")) {
        streamed.push(...table.toArray());
      }
      expect(streamed).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);

      const empty = await client.queryArrow("SELECT 1::INTEGER AS id, 'x'::VARCHAR AS label WHERE FALSE");
      expect(empty.numRows).toBe(0);
      expect(empty.names).toEqual(["id", "label"]);
      expect(empty.schema.fields.map((field) => field.type.typeId)).toEqual([2, 5]);
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

  it("appends multi-batch Arrow tables and SDK-produced Arrow without explicit duckTypes", async () => {
    await withClient(async (client) => {
      const tableName = uniqueName("quack_ts_arrow_append_metadata");
      await client.query(`CREATE TEMP TABLE ${tableName} (id INTEGER, label VARCHAR, amount DECIMAL(10, 2))`);

      const multiBatch = tableFromArrays(
        {
          id: [1, 2, 3],
          label: ["one", "two", "three"],
          amount: [1234n, 5678n, null]
        },
        {
          maxBatchRows: 1,
          types: {
            id: int32(),
            label: utf8(),
            amount: decimal128(10, 2)
          },
          useDecimalInt: true
        }
      );

      await client.appendArrow(tableName, multiBatch, {
        duckTypes: {
          id: LogicalTypes.integer(),
          label: LogicalTypes.varchar(),
          amount: LogicalTypes.decimal(10, 2)
        },
        useDecimalInt: true
      });

      const sdkProduced = await client.queryArrow(
        "SELECT 4::INTEGER AS id, 'four'::VARCHAR AS label, 90.12::DECIMAL(10, 2) AS amount",
        { useDecimalInt: true }
      );
      expect(sdkProduced.schema.fields.map((field) => field.metadata.get("quack:logicalType") ? "metadata" : "missing")).toEqual([
        "metadata",
        "metadata",
        "metadata"
      ]);
      await client.appendArrow(tableName, sdkProduced, { useDecimalInt: true });

      const rows = (await client.query(`SELECT * FROM ${tableName} ORDER BY id`)).rows();
      expect(rows.map((row) => ({ id: row.id, label: row.label }))).toEqual([
        { id: 1, label: "one" },
        { id: 2, label: "two" },
        { id: 3, label: "three" },
        { id: 4, label: "four" }
      ]);
      expect(decimalToString(rows[0]?.amount as DecimalValue)).toBe("12.34");
      expect(decimalToString(rows[1]?.amount as DecimalValue)).toBe("56.78");
      expect(rows[2]?.amount).toBeNull();
      expect(decimalToString(rows[3]?.amount as DecimalValue)).toBe("90.12");
    });
  });

  it("round-trips Arrow results for special scalar families", async () => {
    await withClient(async (client) => {
      const enumName = uniqueName("quack_ts_arrow_mood");
      await client.query(`CREATE TYPE ${enumName} AS ENUM ('sad', 'ok', 'happy')`);

      const table = await client.queryArrow(
        `
          SELECT
            UUID '00112233-4455-6677-8899-aabbccddeeff' AS uuid_v,
            'hi'::BLOB AS blob_v,
            CAST('00:00:01+00' AS TIME WITH TIME ZONE) AS timetz_v,
            123456789012345678901234567890.1234::DECIMAL(38, 4) AS dec128_v,
            'ok'::${enumName} AS enum_v
        `,
        {
          useBigInt: true,
          useDecimalInt: true
        }
      );

      expect(table.at(0)).toMatchObject({
        uuid_v: "00112233-4455-6677-8899-aabbccddeeff",
        dec128_v: 1234567890123456789012345678901234n,
        enum_v: "ok"
      });
      expect(table.getChild("blob_v").at(0)).toEqual(new TextEncoder().encode("hi"));
      expect(typeof table.at(0)?.timetz_v).toBe("bigint");

      const [chunk] = dataChunksFromArrowIPC(arrowIPCFromTable(table, { useBigInt: true, useDecimalInt: true }), {
        useBigInt: true,
        useDecimalInt: true
      });
      expect(chunk?.types.map((type) => type.id)).toEqual([
        LogicalTypeId.UUID,
        LogicalTypeId.BLOB,
        LogicalTypeId.TIME_TZ,
        LogicalTypeId.DECIMAL,
        LogicalTypeId.ENUM
      ]);
    });
  });
});
