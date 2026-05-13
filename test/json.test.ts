import { describe, expect, it } from "vitest";
import {
  dateFromISODate,
  decimalValue,
  intervalValue,
  timeValue,
  timestampValue,
  toJsonRow,
  toJsonRows,
  toJsonValue
} from "../src";

describe("JSON conversion helpers", () => {
  it("converts Quack-specific values to JSON-safe defaults", () => {
    expect(toJsonValue(9007199254740993n)).toBe("9007199254740993");
    expect(toJsonValue(new Uint8Array([104, 105]))).toBe("aGk=");
    expect(toJsonValue(decimalValue("12.34", 10, 2))).toBe("12.34");
    expect(toJsonValue(dateFromISODate("2020-01-02"))).toBe("2020-01-02");
    expect(toJsonValue(timeValue(1234567n))).toBe("00:00:01.234567");
    expect(toJsonValue(timestampValue(1234567n, "micros"))).toBe("1970-01-01T00:00:01.234567Z");
    expect(toJsonValue(intervalValue(1, 2, 3n))).toEqual({
      kind: "interval",
      months: 1,
      days: 2,
      micros: "3"
    });
  });

  it("supports explicit JSON conversion options", () => {
    expect(toJsonValue(new Uint8Array([104, 105]), { bytes: "hex" })).toBe("6869");
    expect(toJsonValue(new Uint8Array([1, 2]), { bytes: "array" })).toEqual([1, 2]);
    expect(toJsonValue(42n, { bigint: "number" })).toBe(42);
    expect(toJsonValue(decimalValue("12.34", 10, 2), { decimal: "tagged" })).toEqual({
      kind: "decimal",
      value: "1234",
      width: 10,
      scale: 2
    });
  });

  it("converts rows recursively", () => {
    const row = toJsonRow({
      id: 1n,
      nested: { payload: new Uint8Array([1, 2]), values: [1n, null] }
    });
    expect(row).toEqual({
      id: "1",
      nested: { payload: "AQI=", values: ["1", null] }
    });

    expect(toJsonRows([{ id: 1n }, { id: 2n }])).toEqual([{ id: "1" }, { id: "2" }]);
  });

  it("rejects unsafe bigint-to-number conversions", () => {
    expect(() => toJsonValue(9007199254740993n, { bigint: "number" })).toThrow();
  });
});
