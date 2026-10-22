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

  it("uses HTTP for local hosts and HTTPS for every other host, like DuckDB", () => {
    expect(parseQuackUri("LocalHost:9494")).toMatchObject({ baseUrl: "http://LocalHost:9494", ssl: false });
    expect(parseQuackUri("quack:127.0.0.1")).toMatchObject({ baseUrl: "http://127.0.0.1:9494", ssl: false });
    expect(parseQuackUri("quack:myhost:9000")).toMatchObject({ baseUrl: "https://myhost:9000", ssl: true });
    expect(parseQuackUri("db.example.com")).toMatchObject({ baseUrl: "https://db.example.com:9494", ssl: true });
    expect(parseQuackUri("quack:0.0.0.0")).toMatchObject({ baseUrl: "https://0.0.0.0:9494", ssl: true });
    expect(parseQuackUri("quack:[2001:db8::1]:9494")).toMatchObject({ baseUrl: "https://[2001:db8::1]:9494", ssl: true });
  });

  it("lets the ssl option override the default in both directions", () => {
    expect(parseQuackUri("quack:myhost", false)).toMatchObject({ baseUrl: "http://myhost:9494", ssl: false });
    expect(parseQuackUri("localhost", true)).toMatchObject({ baseUrl: "https://localhost:9494", ssl: true });
  });

  it("keeps the scheme of direct HTTP(S) URLs", () => {
    expect(parseQuackUri("http://myhost:9494", true)).toMatchObject({ baseUrl: "http://myhost:9494", ssl: false });
    expect(parseQuackUri("https://localhost:9494")).toMatchObject({ baseUrl: "https://localhost:9494", ssl: true });
  });
});
