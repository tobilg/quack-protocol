import { describe, expect, it } from "vitest";
import { MessageType, QuackClient, QuackProtocolError, QuackServerError } from "../../src";
import { authToken, integrationUrl, withClient } from "./helpers";

describe.skipIf(!integrationUrl)("Quack error handling", () => {
  it("turns SQL errors into QuackServerError", async () => {
    await withClient(async (client) => {
      await expect(client.query("SELECT definitely_missing_column")).rejects.toThrow(QuackServerError);
    });
  });

  it("reports HTTP endpoint failures", async () => {
    await expect(QuackClient.connect("quack:127.0.0.1:1", { authToken })).rejects.toThrow();
  });

  it("rejects client API use after disconnect through protocol errors", async () => {
    await withClient(async (client) => {
      await client.disconnect();
      await expect(client.append("missing", { rowCount: 0, types: [], columns: [] })).rejects.toThrow(
        QuackProtocolError
      );
    });
  });

  it("returns server errors for unsupported request message types", async () => {
    await withClient(async (client) => {
      await expect(
        client.send({
          type: MessageType.SUCCESS_RESPONSE,
          connectionId: (client as unknown as { connectionId: string }).connectionId,
          clientQueryId: 201n
        })
      ).rejects.toThrow(QuackServerError);
    });
  });

  it("returns server errors for unknown connection ids", async () => {
    await withClient(async (client) => {
      await expect(
        client.send({
          type: MessageType.PREPARE_REQUEST,
          connectionId: "definitely_not_a_connection",
          clientQueryId: 202n,
          sql: "SELECT 1"
        })
      ).rejects.toThrow(QuackServerError);
    });
  });
});
