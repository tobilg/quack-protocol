import { describe, expect, it } from "vitest";
import { MessageType, QuackClient, QuackProtocolError, QuackServerError } from "../../src";
import { authToken, connect, integrationUrl, withClient } from "./helpers";

describe.skipIf(!integrationUrl)("Quack connection lifecycle", () => {
  it("connects, disconnects, and rejects use after disconnect", async () => {
    const client = await connect();
    expect(client.isConnected).toBe(true);
    await client.disconnect();
    expect(client.isConnected).toBe(false);
    await client.disconnect();
    await expect(client.query("SELECT 1")).rejects.toThrow(QuackProtocolError);
  });

  it("runs multiple sequential queries on one connection", async () => {
    await withClient(async (client) => {
      expect((await client.query("SELECT 1::INTEGER AS x")).rows()).toEqual([{ x: 1 }]);
      expect((await client.query("SELECT 2::INTEGER AS x")).rows()).toEqual([{ x: 2 }]);
    });
  });

  it("runs scoped connection and transaction helpers", async () => {
    const committed = await QuackClient.withConnection(integrationUrl!, { authToken }, async (client) => {
      const table = `tx_items_${Date.now().toString().replaceAll("-", "_")}`;
      await client.query(`CREATE TEMP TABLE ${table} (id INTEGER)`);
      await client.transaction(async (tx) => {
        await tx.query(`INSERT INTO ${table} VALUES (1)`);
      });
      return client.values<number>(`SELECT id FROM ${table}`);
    });
    expect(committed).toEqual([1]);
  });

  it("rolls back failed transactions", async () => {
    await withClient(async (client) => {
      const table = `quack_ts_tx_${Date.now()}`;
      await client.query(`CREATE TEMP TABLE ${table} (id INTEGER)`);

      await expect(
        client.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${table} VALUES (1)`);
          throw new Error("rollback");
        })
      ).rejects.toThrow("rollback");

      expect(await client.values<bigint>(`SELECT COUNT(*) FROM ${table}`)).toEqual([0n]);
    });
  });

  it("exposes server connection metadata", async () => {
    await withClient(async (client) => {
      expect(client.info?.quackVersion).toBeDefined();
      expect(client.info?.serverDuckdbVersion).toBeDefined();
    });
  });

  it("rejects fetches for a result that has been replaced", async () => {
    await withClient(async (client) => {
      const first = await client.send({
        type: MessageType.PREPARE_REQUEST,
        connectionId: (client as unknown as { connectionId: string }).connectionId,
        clientQueryId: 100n,
        sql: "SELECT * FROM range(10) t(i)"
      });
      expect(first.type).toBe(MessageType.PREPARE_RESPONSE);

      await client.query("SELECT 99::INTEGER AS replacement");

      if (first.type !== MessageType.PREPARE_RESPONSE) {
        throw new Error("unexpected response");
      }
      await expect(
        client.send({
          type: MessageType.FETCH_REQUEST,
          connectionId: (client as unknown as { connectionId: string }).connectionId,
          clientQueryId: 101n,
          resultUuid: first.resultUuid
        })
      ).rejects.toThrow(QuackServerError);
    });
  });
});
