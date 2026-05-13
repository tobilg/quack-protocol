import { describe, expect, it } from "vitest";
import { column, dataChunk } from "../src/builders";
import { decodeMessage, encodeMessage, MessageType } from "../src/messages";
import type { PrepareResponseMessage } from "../src/messages";
import { LogicalTypes } from "../src/logical-types";
import { rowsFromChunk } from "../src/vector";

describe("Quack messages", () => {
  it("round-trips a prepare response with result chunks", () => {
    const chunk = dataChunk([
      column(LogicalTypes.integer(), [1, null, 3], "id"),
      column(LogicalTypes.varchar(), ["one", null, "three"], "label")
    ]);
    const message: PrepareResponseMessage = {
      type: MessageType.PREPARE_RESPONSE,
      connectionId: "conn-1",
      clientQueryId: 7n,
      resultTypes: chunk.types,
      resultNames: ["id", "label"],
      needsMoreFetch: false,
      results: [chunk],
      resultUuid: { upper: 123n, lower: 456n }
    };

    const decoded = decodeMessage(encodeMessage(message));

    expect(decoded.type).toBe(MessageType.PREPARE_RESPONSE);
    if (decoded.type !== MessageType.PREPARE_RESPONSE) {
      throw new Error("unexpected message type");
    }
    expect(decoded.connectionId).toBe("conn-1");
    expect(decoded.clientQueryId).toBe(7n);
    expect(decoded.resultNames).toEqual(["id", "label"]);
    expect(decoded.resultUuid).toEqual({ upper: 123n, lower: 456n });
    expect(rowsFromChunk(decoded.results[0]!, decoded.resultNames)).toEqual([
      { id: 1, label: "one" },
      { id: null, label: null },
      { id: 3, label: "three" }
    ]);
  });
});
