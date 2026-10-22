import { describe, expect, it } from "vitest";
import { column, dataChunk } from "../src/builders";
import { decodeMessage, encodeMessage, MessageType } from "../src/messages";
import type { PrepareResponseMessage, QuackMessage } from "../src/messages";
import { LogicalTypes } from "../src/logical-types";
import { chunksToRows, rowsFromChunk } from "../src/vector";
import { fromHex, quackV3Wire, toHex } from "./fixtures/quack-v3-wire";

const expectedRows = [{ s: "hello", n: null, i: 42, b: new Uint8Array([0x78]) }];

function decodeFixture<T extends MessageType>(hex: string, type: T): Extract<QuackMessage, { type: T }> {
  const message = decodeMessage(fromHex(hex));
  expect(message.type).toBe(type);
  return message as Extract<QuackMessage, { type: T }>;
}

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
      queryUuid: { upper: 123n, lower: 456n }
    };

    const decoded = decodeMessage(encodeMessage(message));

    expect(decoded.type).toBe(MessageType.PREPARE_RESPONSE);
    if (decoded.type !== MessageType.PREPARE_RESPONSE) {
      throw new Error("unexpected message type");
    }
    expect(decoded.connectionId).toBe("conn-1");
    expect(decoded.clientQueryId).toBe(7n);
    expect(decoded.resultNames).toEqual(["id", "label"]);
    expect(decoded.queryUuid).toEqual({ upper: 123n, lower: 456n });
    expect(rowsFromChunk(decoded.results[0]!, decoded.resultNames)).toEqual([
      { id: 1, label: "one" },
      { id: null, label: null },
      { id: 3, label: "three" }
    ]);
  });

  it("round-trips send-data requests with their trailing chunk blob", () => {
    const chunks = [
      dataChunk([column(LogicalTypes.integer(), [1, 2], "id"), column(LogicalTypes.varchar(), ["a", null], "label")]),
      dataChunk([column(LogicalTypes.integer(), [3], "id"), column(LogicalTypes.varchar(), ["c"], "label")])
    ];
    const decoded = decodeMessage(
      encodeMessage({
        type: MessageType.SEND_DATA_REQUEST,
        connectionId: "conn-1",
        clientQueryId: 9n,
        streamId: "stream-1",
        chunks,
        batchIndex: 2
      })
    );
    if (decoded.type !== MessageType.SEND_DATA_REQUEST) {
      throw new Error("unexpected message type");
    }
    expect(decoded.streamId).toBe("stream-1");
    expect(decoded.batchIndex).toBe(2n);
    expect(decoded.totalBatches).toBeUndefined();
    expect(chunksToRows(decoded.chunks, ["id", "label"])).toEqual([
      { id: 1, label: "a" },
      { id: 2, label: null },
      { id: 3, label: "c" }
    ]);

    const terminal = decodeMessage(
      encodeMessage({ type: MessageType.SEND_DATA_REQUEST, connectionId: "conn-1", streamId: "stream-1", chunks: [], totalBatches: 2 })
    );
    expect(terminal).toMatchObject({ type: MessageType.SEND_DATA_REQUEST, chunks: [], totalBatches: 2n });
  });

  it("round-trips cancel, acknowledgement, heartbeat, and error messages", () => {
    const uuid = { upper: -5n, lower: 17n };
    expect(decodeMessage(encodeMessage({ type: MessageType.CANCEL_REQUEST, connectionId: "c", queryUuid: uuid }))).toMatchObject({
      type: MessageType.CANCEL_REQUEST,
      queryUuid: uuid
    });
    expect(decodeMessage(encodeMessage({ type: MessageType.ACKNOWLEDGEMENT, connectionId: "c", queryUuid: uuid }))).toMatchObject({
      type: MessageType.ACKNOWLEDGEMENT,
      queryUuid: uuid
    });
    expect(decodeMessage(encodeMessage({ type: MessageType.HEARTBEAT_REQUEST, connectionId: "c" }))).toMatchObject({
      type: MessageType.HEARTBEAT_REQUEST,
      connectionId: "c"
    });
    expect(
      decodeMessage(
        encodeMessage({
          type: MessageType.ERROR_RESPONSE,
          message: "boom",
          exceptionType: "Catalog",
          extraInfo: { name: "t" },
          mustInvalidate: true
        })
      )
    ).toEqual({ type: MessageType.ERROR_RESPONSE, message: "boom", exceptionType: "Catalog", extraInfo: { name: "t" }, mustInvalidate: true });
  });
});

describe("Quack v3 wire fixtures from DuckDB v2.0.0", () => {
  it("decodes the connection response", () => {
    const message = decodeFixture(quackV3Wire.connectionResponse, MessageType.CONNECTION_RESPONSE);
    expect(message.connectionId).toMatch(/^[0-9A-F]{32}$/);
    expect(message.serverDuckdbVersion).toBe("v2.0.0");
    expect(message.serverPlatform).toBe("osx_arm64");
    expect(message.quackVersion).toBe(3n);
    expect(message.heartbeatTimeoutSeconds).toBe(60n);
  });

  it("decodes inline prepare results with DuckDB 2.0 string vectors", () => {
    const message = decodeFixture(quackV3Wire.prepareInline, MessageType.PREPARE_RESPONSE);
    expect(message.resultNames).toEqual(["s", "n", "i", "b"]);
    expect(message.needsMoreFetch).toBe(false);
    expect(message.queryUuid).toEqual({ upper: 7n, lower: 11n });
    expect(chunksToRows(message.results, message.resultNames)).toEqual(expectedRows);
    expect(toHex(encodeMessage(message))).toBe(quackV3Wire.prepareInline);
  });

  it("decodes a deferred prepare and the fetch batches that follow", () => {
    const prepare = decodeFixture(quackV3Wire.prepareDeferred, MessageType.PREPARE_RESPONSE);
    expect(prepare.needsMoreFetch).toBe(true);
    expect(prepare.results).toEqual([]);
    expect(prepare.queryUuid).toEqual({ upper: 0n, lower: 99n });

    const data = decodeFixture(quackV3Wire.fetchData, MessageType.FETCH_RESPONSE);
    expect(data.batchIndex).toBe(1n);
    expect(data.totalBatches).toBeUndefined();
    expect(chunksToRows(data.results, prepare.resultNames)).toEqual(expectedRows);
    expect(toHex(encodeMessage(data))).toBe(quackV3Wire.fetchData);

    const terminal = decodeFixture(quackV3Wire.fetchTerminal, MessageType.FETCH_RESPONSE);
    expect(terminal.results).toEqual([]);
    expect(terminal.totalBatches).toBe(1n);
    expect(toHex(encodeMessage(terminal))).toBe(quackV3Wire.fetchTerminal);
  });

  it("decodes typed error responses", () => {
    const message = decodeFixture(quackV3Wire.catalogError, MessageType.ERROR_RESPONSE);
    expect(message.exceptionType).toBe("Catalog");
    expect(message.message).toMatch(/^Table with name quack_ts_missing_table does not exist!/);
    expect(message.extraInfo).toMatchObject({ name: "quack_ts_missing_table", type: "Table", error_subtype: "MISSING_ENTRY" });
    expect(message.mustInvalidate).toBeUndefined();
  });

  it("decodes success responses", () => {
    expect(decodeFixture(quackV3Wire.heartbeat, MessageType.SUCCESS_RESPONSE)).toEqual({ type: MessageType.SUCCESS_RESPONSE });
  });
});
