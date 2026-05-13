import { describe, expect, it } from "vitest";
import { parseQuackUri, QuackClient } from "../../src";
import { authToken, integrationUrl } from "./helpers";

describe.skipIf(!integrationUrl)("Quack URI integration", () => {
  it("connects with a quack URI", async () => {
    const client = await QuackClient.connect(integrationUrl!, { authToken });
    try {
      expect((await client.query("SELECT 7::INTEGER AS v")).rows()).toEqual([{ v: 7 }]);
    } finally {
      await client.disconnect();
    }
  });

  it("connects with the equivalent HTTP URL", async () => {
    const parsed = parseQuackUri(integrationUrl!);
    const client = await QuackClient.connect(parsed.baseUrl, { authToken });
    try {
      expect((await client.query("SELECT 8::INTEGER AS v")).rows()).toEqual([{ v: 8 }]);
    } finally {
      await client.disconnect();
    }
  });
});
