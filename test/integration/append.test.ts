import { describe, expect, it } from "vitest";
import {
  column,
  dataChunk,
  decimalToString,
  logicalType,
  LogicalTypeId,
  LogicalTypes,
  ExtraTypeInfoType
} from "../../src";
import type { DecimalValue } from "../../src";
import { bytes, daysSinceEpoch, integrationUrl, uniqueName, withClient } from "./helpers";

describe.skipIf(!integrationUrl)("Quack append round trips", () => {
  it("appends primitive, string/blob, decimal, date, timestamp, and interval columns", async () => {
    await withClient(async (client) => {
      const table = uniqueName("quack_ts_append_scalar");
      await client.query(`
        CREATE TEMP TABLE ${table} (
          id INTEGER,
          ok BOOLEAN,
          amount BIGINT,
          price DECIMAL(10, 2),
          label VARCHAR,
          payload BLOB,
          day DATE,
          ts TIMESTAMP,
          span INTERVAL
        )
      `);

      await client.append(
        table,
        dataChunk([
          column(LogicalTypes.integer(), [2, 1, null], "id"),
          column(LogicalTypes.boolean(), [false, true, null], "ok"),
          column(LogicalTypes.bigint(), [20n, 10n, null], "amount"),
          column(LogicalTypes.decimal(10, 2), ["12.34", "56.78", null], "price"),
          column(LogicalTypes.varchar(), ["two", "one", null], "label"),
          column(LogicalTypes.blob(), [bytes([2]), bytes([1]), null], "payload"),
          column(LogicalTypes.date(), [{ kind: "date", days: daysSinceEpoch("2020-01-02") }, 0, null], "day"),
          column(
            LogicalTypes.timestamp(),
            [
              { kind: "timestamp", unit: "micros", value: 2000000n },
              { kind: "timestamp", unit: "micros", value: 1000000n },
              null
            ],
            "ts"
          ),
          column(
            logicalType(LogicalTypeId.INTERVAL),
            [
              { kind: "interval", months: 1, days: 2, micros: 3n },
              { kind: "interval", months: 0, days: 1, micros: 1000n },
              null
            ],
            "span"
          )
        ])
      );

      const rows = (await client.query(`SELECT * FROM ${table} ORDER BY id NULLS LAST`)).rows();
      expect(rows[0]).toMatchObject({
        id: 1,
        ok: true,
        amount: 10n,
        label: "one",
        payload: bytes([1]),
        day: { kind: "date", days: 0 },
        ts: { kind: "timestamp", unit: "micros", value: 1000000n },
        span: { kind: "interval", months: 0, days: 1, micros: 1000n }
      });
      expect(decimalToString(rows[0]?.price as DecimalValue)).toBe("56.78");
      expect(rows[1]).toMatchObject({
        id: 2,
        ok: false,
        amount: 20n,
        label: "two",
        payload: bytes([2]),
        day: { kind: "date", days: daysSinceEpoch("2020-01-02") },
        ts: { kind: "timestamp", unit: "micros", value: 2000000n },
        span: { kind: "interval", months: 1, days: 2, micros: 3n }
      });
      expect(decimalToString(rows[1]?.price as DecimalValue)).toBe("12.34");
      expect(rows[2]).toEqual({
        id: null,
        ok: null,
        amount: null,
        price: null,
        label: null,
        payload: null,
        day: null,
        ts: null,
        span: null
      });
    });
  });

  it("appends nested list, struct, map, and array columns", async () => {
    await withClient(async (client) => {
      const table = uniqueName("quack_ts_append_nested");
      await client.query(`
        CREATE TEMP TABLE ${table} (
          id INTEGER,
          ints INTEGER[],
          item STRUCT(a INTEGER, b VARCHAR),
          attrs MAP(VARCHAR, INTEGER),
          fixed INTEGER[3]
        )
      `);

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

      await client.append(
        table,
        dataChunk([
          column(LogicalTypes.integer(), [1, 2, 3], "id"),
          column(LogicalTypes.list(LogicalTypes.integer()), [[1, 2], [], null], "ints"),
          column(structType, [{ a: 1, b: "x" }, { a: 2, b: null }, null], "item"),
          column(
            mapType,
            [
              [
                { key: "a", value: 1 },
                { key: "b", value: 2 }
              ],
              [],
              null
            ],
            "attrs"
          ),
          column(LogicalTypes.array(LogicalTypes.integer(), 3), [[1, 2, 3], [4, 5, 6], null], "fixed")
        ])
      );

      expect((await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows()).toEqual([
        {
          id: 1,
          ints: [1, 2],
          item: { a: 1, b: "x" },
          attrs: [
            { key: "a", value: 1 },
            { key: "b", value: 2 }
          ],
          fixed: [1, 2, 3]
        },
        {
          id: 2,
          ints: [],
          item: { a: 2, b: null },
          attrs: [],
          fixed: [4, 5, 6]
        },
        {
          id: 3,
          ints: null,
          item: null,
          attrs: null,
          fixed: null
        }
      ]);
    });
  });

  it("appends the remaining scalar encoder families", async () => {
    await withClient(async (client) => {
      const enumName = uniqueName("quack_ts_append_mood");
      const table = uniqueName("quack_ts_append_full_scalar");
      await client.query(`CREATE TYPE ${enumName} AS ENUM ('sad', 'ok', 'happy')`);
      const timetz = (await client.query("SELECT CAST('00:00:01+00' AS TIME WITH TIME ZONE) AS v")).rows()[0]?.v;

      await client.query(`
        CREATE TEMP TABLE ${table} (
          tiny_v TINYINT,
          small_v SMALLINT,
          int_v INTEGER,
          big_v BIGINT,
          utiny_v UTINYINT,
          usmall_v USMALLINT,
          uint_v UINTEGER,
          ubig_v UBIGINT,
          huge_v HUGEINT,
          uhuge_v UHUGEINT,
          float_v FLOAT,
          double_v DOUBLE,
          dec16_v DECIMAL(4, 2),
          dec32_v DECIMAL(9, 2),
          dec64_v DECIMAL(18, 2),
          dec128_v DECIMAL(38, 4),
          uuid_v UUID,
          time_v TIME,
          time_ns_v TIME_NS,
          timetz_v TIME WITH TIME ZONE,
          ts_s_v TIMESTAMP_S,
          ts_ms_v TIMESTAMP_MS,
          ts_ns_v TIMESTAMP_NS,
          tstz_v TIMESTAMPTZ,
          enum_v ${enumName}
        )
      `);

      await client.append(
        table,
        dataChunk([
          column(LogicalTypes.tinyint(), [127], "tiny_v"),
          column(LogicalTypes.smallint(), [32767], "small_v"),
          column(LogicalTypes.integer(), [2147483647], "int_v"),
          column(LogicalTypes.bigint(), [9007199254740993n], "big_v"),
          column(logicalType(LogicalTypeId.UTINYINT), [255], "utiny_v"),
          column(logicalType(LogicalTypeId.USMALLINT), [65535], "usmall_v"),
          column(logicalType(LogicalTypeId.UINTEGER), [4294967295], "uint_v"),
          column(logicalType(LogicalTypeId.UBIGINT), [18446744073709551615n], "ubig_v"),
          column(logicalType(LogicalTypeId.HUGEINT), [123456789012345678901234567890n], "huge_v"),
          column(logicalType(LogicalTypeId.UHUGEINT), [123456789012345678901234567890n], "uhuge_v"),
          column(LogicalTypes.float(), [1.5], "float_v"),
          column(LogicalTypes.double(), [2.25], "double_v"),
          column(LogicalTypes.decimal(4, 2), ["12.34"], "dec16_v"),
          column(LogicalTypes.decimal(9, 2), ["1234567.89"], "dec32_v"),
          column(LogicalTypes.decimal(18, 2), ["1234567890123456.78"], "dec64_v"),
          column(LogicalTypes.decimal(38, 4), ["123456789012345678901234567890.1234"], "dec128_v"),
          column(LogicalTypes.uuid(), ["00112233-4455-6677-8899-aabbccddeeff"], "uuid_v"),
          column(logicalType(LogicalTypeId.TIME), [{ kind: "time", unit: "micros", value: 1234567n }], "time_v"),
          column(logicalType(LogicalTypeId.TIME_NS), [{ kind: "time", unit: "nanos", value: 1234567890n }], "time_ns_v"),
          column(logicalType(LogicalTypeId.TIME_TZ), [timetz ?? { kind: "time_tz", bits: 0n }], "timetz_v"),
          column(
            logicalType(LogicalTypeId.TIMESTAMP_SEC),
            [{ kind: "timestamp", unit: "seconds", value: 1n }],
            "ts_s_v"
          ),
          column(
            logicalType(LogicalTypeId.TIMESTAMP_MS),
            [{ kind: "timestamp", unit: "millis", value: 1234n }],
            "ts_ms_v"
          ),
          column(
            logicalType(LogicalTypeId.TIMESTAMP_NS),
            [{ kind: "timestamp", unit: "nanos", value: 1234567890n }],
            "ts_ns_v"
          ),
          column(
            logicalType(LogicalTypeId.TIMESTAMP_TZ),
            [{ kind: "timestamp", unit: "micros", value: 1000000n, timezone: "utc" }],
            "tstz_v"
          ),
          column(LogicalTypes.enum(["sad", "ok", "happy"]), ["happy"], "enum_v")
        ])
      );

      const row = (await client.query(`SELECT * FROM ${table}`)).rows()[0]!;
      expect(row.tiny_v).toBe(127);
      expect(row.small_v).toBe(32767);
      expect(row.int_v).toBe(2147483647);
      expect(row.big_v).toBe(9007199254740993n);
      expect(row.utiny_v).toBe(255);
      expect(row.usmall_v).toBe(65535);
      expect(row.uint_v).toBe(4294967295);
      expect(row.ubig_v).toBe(18446744073709551615n);
      expect(row.huge_v).toBe(123456789012345678901234567890n);
      expect(row.uhuge_v).toBe(123456789012345678901234567890n);
      expect(row.float_v as number).toBeCloseTo(1.5);
      expect(row.double_v).toBe(2.25);
      expect(decimalToString(row.dec16_v as DecimalValue)).toBe("12.34");
      expect(decimalToString(row.dec32_v as DecimalValue)).toBe("1234567.89");
      expect(decimalToString(row.dec64_v as DecimalValue)).toBe("1234567890123456.78");
      expect(decimalToString(row.dec128_v as DecimalValue)).toBe("123456789012345678901234567890.1234");
      expect(row.uuid_v).toBe("00112233-4455-6677-8899-aabbccddeeff");
      expect(row.time_v).toEqual({ kind: "time", unit: "micros", value: 1234567n });
      expect(row.time_ns_v).toEqual({ kind: "time", unit: "nanos", value: 1234567890n });
      expect(row.timetz_v).toEqual(timetz);
      expect(row.ts_s_v).toEqual({ kind: "timestamp", unit: "seconds", value: 1n });
      expect(row.ts_ms_v).toEqual({ kind: "timestamp", unit: "millis", value: 1234n });
      expect(row.ts_ns_v).toEqual({ kind: "timestamp", unit: "nanos", value: 1234567890n });
      expect(row.tstz_v).toEqual({ kind: "timestamp", unit: "micros", value: 1000000n, timezone: "utc" });
      expect(row.enum_v).toBe("happy");
    });
  });

  it("appends into a schema-qualified table", async () => {
    await withClient(async (client) => {
      const schema = uniqueName("quack_ts_schema");
      const table = uniqueName("items");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`CREATE TABLE ${schema}.${table} (id INTEGER, label VARCHAR)`);

      await client.append(
        table,
        dataChunk([
          column(LogicalTypes.integer(), [1, 2], "id"),
          column(LogicalTypes.varchar(), ["one", "two"], "label")
        ]),
        schema
      );

      expect((await client.query(`SELECT * FROM ${schema}.${table} ORDER BY id`)).rows()).toEqual([
        { id: 1, label: "one" },
        { id: 2, label: "two" }
      ]);
    });
  });

  it("appends rows with the friendly row API", async () => {
    await withClient(async (client) => {
      const schema = uniqueName("quack_ts_append_rows_schema");
      const table = uniqueName("items");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`CREATE TABLE ${schema}.${table} (id INTEGER, label VARCHAR, amount DECIMAL(10, 2))`);

      await client.appendRows(
        { schema, table },
        [
          { id: 1, label: "one", amount: "12.34" },
          { id: 2, label: "two", amount: null }
        ],
        {
          columns: {
            id: LogicalTypes.integer(),
            label: LogicalTypes.varchar(),
            amount: LogicalTypes.decimal(10, 2)
          },
          batchSize: 1
        }
      );

      const rows = (await client.query(`SELECT * FROM ${schema}.${table} ORDER BY id`)).rows();
      expect(rows[0]).toMatchObject({ id: 1, label: "one" });
      expect(decimalToString(rows[0]?.amount as DecimalValue)).toBe("12.34");
      expect(rows[1]).toEqual({ id: 2, label: "two", amount: null });
    });
  });

  it("appends zero rows with the friendly row API when columns are explicit", async () => {
    await withClient(async (client) => {
      const table = uniqueName("quack_ts_append_rows_empty");
      await client.query(`CREATE TEMP TABLE ${table} (id INTEGER, label VARCHAR)`);

      await client.appendRows(
        table,
        [],
        {
          columns: {
            id: LogicalTypes.integer(),
            label: LogicalTypes.varchar()
          }
        }
      );

      expect((await client.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows()).toEqual([{ count: 0n }]);
    });
  });

  it("surfaces server append errors", async () => {
    await withClient(async (client) => {
      await expect(client.append("definitely_missing_table", dataChunk([column(LogicalTypes.integer(), [1])]))).rejects.toThrow();
    });
  });

  it("accepts zero-row append chunks", async () => {
    await withClient(async (client) => {
      const table = uniqueName("quack_ts_append_empty");
      await client.query(`CREATE TEMP TABLE ${table} (id INTEGER, label VARCHAR)`);

      await client.append(
        table,
        dataChunk([
          column(LogicalTypes.integer(), [], "id"),
          column(LogicalTypes.varchar(), [], "label")
        ])
      );

      expect((await client.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows()).toEqual([{ count: 0n }]);
    });
  });
});
