import { describe, expect, it } from "vitest";
import { connect, integrationUrl } from "./helpers";

describe.skipIf(!integrationUrl)("Quack concurrency and session isolation", () => {
  it("handles multiple clients in parallel", async () => {
    const clients = await Promise.all([connect(), connect(), connect()]);
    try {
      const results = await Promise.all(
        clients.map((client, index) => client.query(`SELECT ${index}::INTEGER AS client_id`))
      );
      expect(results.map((result) => result.rows()[0])).toEqual([
        { client_id: 0 },
        { client_id: 1 },
        { client_id: 2 }
      ]);
    } finally {
      await Promise.all(clients.map((client) => client.disconnect()));
    }
  });

  it("keeps temporary tables isolated per connection", async () => {
    const left = await connect();
    const right = await connect();
    try {
      await left.query("CREATE TEMP TABLE quack_ts_isolation(v INTEGER)");
      await left.query("INSERT INTO quack_ts_isolation VALUES (1)");
      await expect(right.query("SELECT * FROM quack_ts_isolation")).rejects.toThrow();
      expect((await left.query("SELECT * FROM quack_ts_isolation")).rows()).toEqual([{ v: 1 }]);
    } finally {
      await Promise.all([left.disconnect(), right.disconnect()]);
    }
  });
});
