import { describe, expect, it } from "vitest";
import { parseQuackUri } from "../src/client";

describe("Quack URI parsing", () => {
  it("parses documented URI forms", () => {
    expect(parseQuackUri("localhost:9494")).toMatchObject({
      baseUrl: "http://localhost:9494",
      host: "localhost",
      port: 9494,
      ssl: false
    });
    expect(parseQuackUri("localhost")).toMatchObject({
      baseUrl: "http://localhost:9494",
      host: "localhost",
      port: 9494,
      ssl: false
    });
    expect(parseQuackUri("quack:localhost")).toMatchObject({
      baseUrl: "http://localhost:9494",
      host: "localhost",
      port: 9494,
      ssl: false
    });
    expect(parseQuackUri("quack://localhost:9000")).toMatchObject({
      baseUrl: "http://localhost:9000",
      host: "localhost",
      port: 9000
    });
    expect(parseQuackUri("quack:[::1]:9494")).toMatchObject({
      baseUrl: "http://[::1]:9494",
      host: "::1",
      port: 9494
    });
  });
});
