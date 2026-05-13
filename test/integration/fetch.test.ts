import { describe, expect, it } from "vitest";
import { integrationUrl, withClient } from "./helpers";

describe.skipIf(!integrationUrl)("Quack fetch behavior", () => {
  it("collects a large result without missing or duplicating rows", async () => {
    await withClient(async (client) => {
      const result = await client.query("SELECT i::BIGINT AS i FROM range(10000) t(i) ORDER BY i");
      const values = result.rows().map((row) => row.i);
      expect(values).toHaveLength(10000);
      expect(values[0]).toBe(0n);
      expect(values[9999]).toBe(9999n);
      expect(values.reduce<bigint>((sum, value) => sum + (value as bigint), 0n)).toBe(49_995_000n);
      expect(result.chunks.length).toBeGreaterThan(0);
    });
  });

  it("streams chunks incrementally", async () => {
    await withClient(async (client) => {
      let count = 0;
      let sum = 0n;
      let chunks = 0;
      for await (const chunk of client.stream("SELECT i::BIGINT AS i FROM range(5000) t(i) ORDER BY i")) {
        chunks++;
        for (const row of chunk.columns[0]?.values ?? []) {
          count++;
          sum += row as bigint;
        }
      }
      expect(count).toBe(5000);
      expect(sum).toBe(12_497_500n);
      expect(chunks).toBeGreaterThan(0);
    });
  });
});
