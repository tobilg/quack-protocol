import { describe, expect, it } from "vitest";
import { column, dataChunk, LogicalTypes, QuackClient, QuackProtocolError, QuackServerError } from "../../src";
import { authToken, connect, integrationUrl, uniqueName, withClient } from "./helpers";

// keeps the server busy until cancelled
const SLOW_QUERY = "SELECT count(*) AS n FROM range(1000000000) a(i), range(1000) b(j) WHERE (i * j) % 7 = 3";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!integrationUrl)("Quack v3 protocol behavior", () => {
  it("negotiates protocol version 3 and a heartbeat lease", async () => {
    const client = await QuackClient.connect(integrationUrl!, { authToken, heartbeatTimeoutSeconds: 30, clientId: "quack-ts-tests" });
    try {
      expect(client.info?.quackVersion).toBe(3n);
      expect(client.info?.heartbeatTimeoutSeconds).toBe(30);
    } finally {
      await client.disconnect();
    }
  });

  it("rejects invalid connection options before contacting the server", async () => {
    await expect(QuackClient.connect(integrationUrl!, { authToken, heartbeatTimeoutSeconds: 0 })).rejects.toThrow(QuackProtocolError);
    await expect(QuackClient.connect(integrationUrl!, { authToken, clientId: "abc" })).rejects.toThrow(QuackProtocolError);
  });

  it("keeps an idle connection alive with heartbeats", async () => {
    const client = await QuackClient.connect(integrationUrl!, { authToken, heartbeatTimeoutSeconds: 1 });
    try {
      await sleep(2_500);
      expect(await client.values("SELECT 1::INTEGER")).toEqual([1]);
    } finally {
      await client.disconnect();
    }
  });

  it("lets the lease expire when heartbeats are disabled", async () => {
    const client = await QuackClient.connect(integrationUrl!, { authToken, heartbeatTimeoutSeconds: 1, heartbeat: false });
    try {
      await sleep(2_500);
      await expect(client.query("SELECT 1")).rejects.toThrow(/lease expired/);
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  });

  it("fetches multi-batch results by batch index", async () => {
    await withClient(async (client) => {
      await client.query("SET quack_target_batch_bytes = 1024");
      const result = await client.query("SELECT i::BIGINT AS i FROM range(20000) t(i) ORDER BY i", { inlineRows: 0 });
      const values = result.rows().map((row) => row.i as bigint);
      expect(values).toHaveLength(20000);
      expect(values[0]).toBe(0n);
      expect(values[19999]).toBe(19999n);
      expect(result.chunks.length).toBeGreaterThan(1);
    });
  });

  it("queues concurrent statements on one client", async () => {
    await withClient(async (client) => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) => client.values<number>(`SELECT ${index}::INTEGER FROM range(3000)`))
      );
      results.forEach((values, index) => {
        expect(values).toHaveLength(3000);
        expect(values.every((value) => value === index)).toBe(true);
      });
    });
  });

  it("interrupts a stream when another statement runs on the same client", async () => {
    await withClient(async (client) => {
      await client.query("SET quack_target_batch_bytes = 1024");
      const iterator = client.stream("SELECT i::BIGINT AS i FROM range(50000) t(i)", { inlineRows: 0 })[Symbol.asyncIterator]();
      expect((await iterator.next()).done).toBe(false);
      await client.query("SELECT 1");
      const drain = async () => {
        for (let result = await iterator.next(); !result.done; result = await iterator.next()) {
          // buffered chunks of the current batch are still delivered
        }
      };
      await expect(drain()).rejects.toThrow(/interrupted by another statement/);
      expect(await client.values("SELECT 2::INTEGER")).toEqual([2]);
    });
  });

  it("cancels the remaining result when a stream loop exits early", async () => {
    await withClient(async (client) => {
      await client.query("SET quack_target_batch_bytes = 1024");
      let rows = 0;
      for await (const row of client.streamRows("SELECT i FROM range(50000) t(i)", { inlineRows: 0 })) {
        void row;
        if (++rows === 10) {
          break;
        }
      }
      expect(rows).toBe(10);
      expect(await client.values("SELECT 3::INTEGER")).toEqual([3]);
    });
  });

  it("cancels a running query", async () => {
    await withClient(async (client) => {
      const running = client.query(SLOW_QUERY).catch((error: unknown) => error);
      await sleep(300);
      expect(await client.cancel()).toBe(true);
      const error = await running;
      expect(error).toBeInstanceOf(QuackServerError);
      expect((error as QuackServerError).message).toMatch(/Interrupted: query was cancelled/);
      expect(await client.cancel()).toBe(false);
      expect(await client.values("SELECT 4::INTEGER")).toEqual([4]);
    });
  });

  it("cancels the server statement when a request times out", async () => {
    await withClient(async (client) => {
      await expect(client.query(SLOW_QUERY, { timeoutMs: 300 })).rejects.toThrow(/timed out/);
      expect(await client.values("SELECT 5::INTEGER")).toEqual([5]);
    });
  });

  it("exposes typed server errors", async () => {
    await withClient(async (client) => {
      const error = await client.query("SELECT * FROM quack_ts_definitely_missing").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(QuackServerError);
      expect((error as QuackServerError).exceptionType).toBe("Catalog");
      expect((error as QuackServerError).extraInfo.name).toBe("quack_ts_definitely_missing");
      expect((error as QuackServerError).mustInvalidate).toBe(false);
      expect((error as QuackServerError).message).toMatch(/^Catalog Error: Table with name/);
    });
  });

  it("acknowledges results when requested", async () => {
    const client = await QuackClient.connect(integrationUrl!, { authToken, acknowledgeResults: true });
    try {
      expect(await client.values("SELECT 6::INTEGER")).toEqual([6]);
      const streamed = [];
      for await (const row of client.streamRows("SELECT 7::INTEGER AS v")) {
        streamed.push(row);
      }
      expect(streamed).toEqual([{ v: 7 }]);
    } finally {
      await client.disconnect();
    }
  });

  it("decodes DuckDB 2.0 TUPLE and TIMESTAMPTZ_NS values", async () => {
    await withClient(async (client) => {
      const row = await client.one("SELECT (1, 'a') AS t, TIMESTAMPTZ_NS '2020-01-01 00:00:00.123456789+00' AS ts");
      expect(row.t).toEqual([1, "a"]);
      expect(row.ts).toEqual({ kind: "timestamp", unit: "nanos", value: 1577836800123456789n, timezone: "utc" });
    });
  });
});

describe.skipIf(!integrationUrl)("Quack v3 appends", () => {
  it("returns the inserted row count and splits large appends into batches", async () => {
    await withClient(async (client) => {
      const table = uniqueName("quack_ts_append_large");
      await client.query(`CREATE TEMP TABLE ${table} (id INTEGER, label VARCHAR)`);
      const ids = Array.from({ length: 40_000 }, (_, index) => index);
      const inserted = await client.append(
        table,
        dataChunk([
          column(LogicalTypes.integer(), ids, "id"),
          column(LogicalTypes.varchar(), ids.map((id) => `row-${id}`), "label")
        ])
      );
      expect(inserted).toBe(40_000);
      expect(await client.one(`SELECT count(*) AS n, sum(id) AS s, max(label) AS m FROM ${table}`)).toEqual({
        n: 40_000n,
        s: 799_980_000n,
        m: "row-9999"
      });
    });
  });

  it("appends several chunks atomically", async () => {
    await withClient(async (client) => {
      const table = uniqueName("quack_ts_append_atomic");
      await client.query(`CREATE TEMP TABLE ${table} (id INTEGER NOT NULL)`);
      const good = dataChunk([column(LogicalTypes.integer(), [1, 2, 3], "id")]);
      const bad = dataChunk([column(LogicalTypes.integer(), [4, null], "id")]);
      await expect(client.append(table, [good, bad])).rejects.toThrow(QuackServerError);
      expect(await client.values(`SELECT count(*) FROM ${table}`)).toEqual([0n]);
      expect(await client.append(table, [good, good])).toBe(6);
    });
  });

  it("appends rows and Arrow data with row counts", async () => {
    await withClient(async (client) => {
      const table = uniqueName("quack_ts_append_counts");
      await client.query(`CREATE TEMP TABLE ${table} (id INTEGER, label VARCHAR)`);
      const rows = Array.from({ length: 5000 }, (_, id) => ({ id, label: `l${id}` }));
      expect(
        await client.appendRows(table, rows, {
          columns: { id: LogicalTypes.integer(), label: LogicalTypes.varchar() },
          batchSize: 999
        })
      ).toBe(5000);
      const arrow = await client.queryArrow(`SELECT id + 5000 AS id, label FROM ${table}`);
      expect(await client.appendArrow(table, arrow)).toBe(5000);
      expect(await client.values(`SELECT count(DISTINCT id) FROM ${table}`)).toEqual([10_000n]);
    });
  });

  it("appends TUPLE and TIMESTAMPTZ_NS columns", async () => {
    await withClient(async (client) => {
      const table = uniqueName("quack_ts_append_v2_types");
      await client.query(`CREATE TEMP TABLE ${table} (t TUPLE(INTEGER, VARCHAR), ts TIMESTAMPTZ_NS)`);
      await client.append(
        table,
        dataChunk([
          column(LogicalTypes.tuple([LogicalTypes.integer(), LogicalTypes.varchar()]), [[1, "a"], null], "t"),
          column(
            LogicalTypes.timestampTzNanos(),
            [{ kind: "timestamp", unit: "nanos", value: 1577836800123456789n, timezone: "utc" }, null],
            "ts"
          )
        ])
      );
      expect((await client.query(`SELECT * FROM ${table} ORDER BY t NULLS LAST`)).rows()).toEqual([
        { t: [1, "a"], ts: { kind: "timestamp", unit: "nanos", value: 1577836800123456789n, timezone: "utc" } },
        { t: null, ts: null }
      ]);
    });
  });

  it("appends inside a transaction and rolls back with it", async () => {
    await withClient(async (client) => {
      const table = uniqueName("quack_ts_append_tx");
      await client.query(`CREATE TEMP TABLE ${table} (id INTEGER)`);
      await expect(
        client.transaction(async (tx) => {
          await tx.append(table, dataChunk([column(LogicalTypes.integer(), [1, 2], "id")]));
          expect(await tx.values(`SELECT count(*) FROM ${table}`)).toEqual([2n]);
          throw new Error("rollback");
        })
      ).rejects.toThrow("rollback");
      expect(await client.values(`SELECT count(*) FROM ${table}`)).toEqual([0n]);
    });
  });

  it("leaves the client usable after a failed append", async () => {
    const client = await connect();
    try {
      await expect(client.append("quack_ts_missing_table", dataChunk([column(LogicalTypes.integer(), [1])]))).rejects.toThrow(
        /quack_ts_missing_table/
      );
      expect(await client.values("SELECT 8::INTEGER")).toEqual([8]);
    } finally {
      await client.disconnect();
    }
  });
});
