import { describe, expect, it } from "vitest";
import { decimalToString, LogicalTypeId } from "../../src";
import type { DecimalValue } from "../../src";
import { bytes, daysSinceEpoch, integrationUrl, uniqueName, withClient } from "./helpers";

describe.skipIf(!integrationUrl)("Quack scalar type decoding", () => {
  it("decodes every supported scalar family from a real server", async () => {
    await withClient(async (client) => {
      const enumName = uniqueName("quack_ts_mood");
      await client.query(`CREATE TYPE ${enumName} AS ENUM ('sad', 'ok', 'happy')`);

      const result = await client.query(`
        SELECT
          TRUE::BOOLEAN AS bool_v,
          127::TINYINT AS tiny_v,
          32767::SMALLINT AS small_v,
          2147483647::INTEGER AS int_v,
          9007199254740993::BIGINT AS big_v,
          255::UTINYINT AS utiny_v,
          65535::USMALLINT AS usmall_v,
          4294967295::UINTEGER AS uint_v,
          18446744073709551615::UBIGINT AS ubig_v,
          123456789012345678901234567890::HUGEINT AS huge_v,
          123456789012345678901234567890::UHUGEINT AS uhuge_v,
          1.5::FLOAT AS float_v,
          2.25::DOUBLE AS double_v,
          12.34::DECIMAL(4, 2) AS dec16_v,
          1234567.89::DECIMAL(9, 2) AS dec32_v,
          1234567890123456.78::DECIMAL(18, 2) AS dec64_v,
          123456789012345678901234567890.1234::DECIMAL(38, 4) AS dec128_v,
          'hello'::VARCHAR AS varchar_v,
          'abc'::CHAR AS char_v,
          'hi'::BLOB AS blob_v,
          UUID '00112233-4455-6677-8899-aabbccddeeff' AS uuid_v,
          DATE '2020-01-02' AS date_v,
          TIME '00:00:01.234567' AS time_v,
          CAST('00:00:01.234567890' AS TIME_NS) AS time_ns_v,
          CAST('00:00:01+00' AS TIME WITH TIME ZONE) AS timetz_v,
          TIMESTAMP '1970-01-01 00:00:01.234567' AS ts_v,
          CAST('1970-01-01 00:00:01' AS TIMESTAMP_S) AS ts_s_v,
          CAST('1970-01-01 00:00:01.234' AS TIMESTAMP_MS) AS ts_ms_v,
          CAST('1970-01-01 00:00:01.234567890' AS TIMESTAMP_NS) AS ts_ns_v,
          TIMESTAMPTZ '1970-01-01 00:00:01+00' AS tstz_v,
          INTERVAL '1 month 2 days 3 microseconds' AS interval_v,
          'ok'::${enumName} AS enum_v
      `);

      const row = result.rows()[0]!;
      expect(row.bool_v).toBe(true);
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
      expect(row.varchar_v).toBe("hello");
      expect(row.char_v).toBe("abc");
      expect(row.blob_v).toEqual(bytes([104, 105]));
      expect(row.uuid_v).toBe("00112233-4455-6677-8899-aabbccddeeff");
      expect(row.date_v).toEqual({ kind: "date", days: daysSinceEpoch("2020-01-02") });
      expect(row.time_v).toEqual({ kind: "time", unit: "micros", value: 1234567n });
      expect(row.time_ns_v).toEqual({ kind: "time", unit: "nanos", value: 1234567890n });
      expect(row.timetz_v).toMatchObject({ kind: "time_tz" });
      expect(row.ts_v).toEqual({ kind: "timestamp", unit: "micros", value: 1234567n });
      expect(row.ts_s_v).toEqual({ kind: "timestamp", unit: "seconds", value: 1n });
      expect(row.ts_ms_v).toEqual({ kind: "timestamp", unit: "millis", value: 1234n });
      expect(row.ts_ns_v).toEqual({ kind: "timestamp", unit: "nanos", value: 1234567890n });
      expect(row.tstz_v).toEqual({ kind: "timestamp", unit: "micros", value: 1000000n, timezone: "utc" });
      expect(row.interval_v).toEqual({ kind: "interval", months: 1, days: 2, micros: 3n });
      expect(row.enum_v).toBe("ok");

      expect(result.types.map((type) => type.id)).toEqual([
        LogicalTypeId.BOOLEAN,
        LogicalTypeId.TINYINT,
        LogicalTypeId.SMALLINT,
        LogicalTypeId.INTEGER,
        LogicalTypeId.BIGINT,
        LogicalTypeId.UTINYINT,
        LogicalTypeId.USMALLINT,
        LogicalTypeId.UINTEGER,
        LogicalTypeId.UBIGINT,
        LogicalTypeId.HUGEINT,
        LogicalTypeId.UHUGEINT,
        LogicalTypeId.FLOAT,
        LogicalTypeId.DOUBLE,
        LogicalTypeId.DECIMAL,
        LogicalTypeId.DECIMAL,
        LogicalTypeId.DECIMAL,
        LogicalTypeId.DECIMAL,
        LogicalTypeId.VARCHAR,
        LogicalTypeId.VARCHAR,
        LogicalTypeId.BLOB,
        LogicalTypeId.UUID,
        LogicalTypeId.DATE,
        LogicalTypeId.TIME,
        LogicalTypeId.TIME_NS,
        LogicalTypeId.TIME_TZ,
        LogicalTypeId.TIMESTAMP,
        LogicalTypeId.TIMESTAMP_SEC,
        LogicalTypeId.TIMESTAMP_MS,
        LogicalTypeId.TIMESTAMP_NS,
        LogicalTypeId.TIMESTAMP_TZ,
        LogicalTypeId.INTERVAL,
        LogicalTypeId.ENUM
      ]);
    });
  });

  it("decodes scalar nulls through validity masks", async () => {
    await withClient(async (client) => {
      const result = await client.query(`
        SELECT
          NULL::BOOLEAN AS bool_v,
          NULL::INTEGER AS int_v,
          NULL::BIGINT AS big_v,
          NULL::DOUBLE AS double_v,
          NULL::DECIMAL(18, 2) AS decimal_v,
          NULL::VARCHAR AS varchar_v,
          NULL::BLOB AS blob_v,
          NULL::DATE AS date_v,
          NULL::TIMESTAMP AS ts_v,
          NULL::INTERVAL AS interval_v
      `);
      expect(result.rows()).toEqual([
        {
          bool_v: null,
          int_v: null,
          big_v: null,
          double_v: null,
          decimal_v: null,
          varchar_v: null,
          blob_v: null,
          date_v: null,
          ts_v: null,
          interval_v: null
        }
      ]);
    });
  });
});
