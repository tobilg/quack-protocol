import { describe, expect, it } from "vitest";
import { QuackClient, QuackServerError } from "../../src";
import { authToken, integrationUrl, withClient } from "./helpers";

describe.skipIf(!integrationUrl)("Quack auth", () => {
  it("accepts the configured token", async () => {
    await withClient(async (client) => {
      const result = await client.query("SELECT 42::INTEGER AS answer");
      expect(result.rows()).toEqual([{ answer: 42 }]);
    });
  });

  it("rejects an incorrect token", async () => {
    await expect(QuackClient.connect(integrationUrl!, { authToken: `${authToken}_wrong` })).rejects.toThrow(
      QuackServerError
    );
  });

  it("rejects a missing token", async () => {
    await expect(QuackClient.connect(integrationUrl!)).rejects.toThrow(QuackServerError);
  });
});
