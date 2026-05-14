# @quack-protocol/sdk

TypeScript client and binary codecs for DuckDB's experimental Quack protocol.

This package implements the Quack HTTP transport, DuckDB `BinarySerializer`
field/object encoding, logical type metadata, `DataChunk` decoding, and flat
`DataChunk` encoding for append workloads. It is ESM-only, has no runtime
dependencies, and uses the standard `fetch` API, so it can run in modern
browsers, Node, and other runtimes with a compatible fetch implementation.

Quack is still experimental upstream. The protocol is tightly coupled to
DuckDB's internal binary serialization format. The implementation here targets
the wire format documented in
[Quack protocol analysis](https://gist.github.com/tobilg/9ced9d08f6141b723f26cf205d5b9ece).

## Status

Implemented:

- Connection string parsing for bare hosts like `localhost:9494`, DuckDB-style
  Quack URIs like `quack:host:port`, bracketed IPv6 hosts, and direct
  `http://` or `https://` URLs.
- HTTP `POST /quack` transport with `application/duckdb` request and response
  bodies.
- Connection, prepare/query, fetch, append, disconnect, success, and error
  messages.
- Typed query rows, row streaming, `first()`, `one()`, `values()`, scoped
  connections, transactions, request cancellation, and request timeouts.
- SQL parameter formatting for positional `?` and named `:name` placeholders.
- DuckDB binary object fields, required/default properties, nullable pointers,
  lists, strings, blobs, signed/unsigned LEB128 integers, and signed/unsigned
  hugeints.
- Logical type metadata for the scalar, decimal, enum, list, struct, map,
  array, aggregate-state, template, generic, string, any, unbound legacy, and
  geometry CRS paths needed for supported Quack traffic.
- Result `DataChunk` decoding for flat, constant, dictionary, and sequence
  vectors.
- Flat append chunk encoding for scalars, decimals, UUIDs, enums, temporal
  values, intervals, strings, blobs, lists/maps, structs, and arrays.
- Row-oriented append helpers for common application code, plus low-level
  protocol exports under `@quack-protocol/sdk/protocol`.

## Installation

```sh
npm install @quack-protocol/sdk
```

For local development from this repository:

```sh
npm install
npm run build
```

## Connecting

```ts
import { QuackClient } from "@quack-protocol/sdk";

const client = await QuackClient.connect("localhost:9494", {
  authToken: "super_secret"
});

try {
  const result = await client.query("SELECT 42 AS answer");
  console.log(result.rows());
} finally {
  await client.disconnect();
}
```

`QuackClient.connect()` accepts:

- `authToken`: token sent in the connection request.
- `clientDuckdbVersion`: optional client DuckDB version metadata.
- `clientPlatform`: optional platform string; defaults to the runtime user
  agent or `quack-ts`.
- `minSupportedQuackVersion` and `maxSupportedQuackVersion`: protocol version
  range, defaulting to version `1`.
- `fetch`: custom fetch implementation.
- `headers`: additional HTTP headers.
- `ssl`: force non-HTTP connection strings to resolve to `https://`.
- `signal`: abort signal used by the initial connection request.
- `timeoutMs`: timeout in milliseconds for the initial connection request.

Because this SDK only speaks Quack, the preferred form is a bare host string:
`localhost:9494` or `localhost`. The default port is `9494`. DuckDB-style
`quack:` URIs remain supported for compatibility with `quack_serve()` output and
configuration.

Supported connection string forms include:

```ts
await QuackClient.connect("localhost:9494", { authToken: "super_secret" });
await QuackClient.connect("localhost", { authToken: "super_secret" });
await QuackClient.connect("quack:localhost:9494", { authToken: "super_secret" });
await QuackClient.connect("quack://localhost:9494", { authToken: "super_secret" });
await QuackClient.connect("http://localhost:9494", { authToken: "super_secret" });
```

Use `withConnection()` when a connection should be scoped to one operation:

```ts
const rows = await QuackClient.withConnection(
  "localhost:9494",
  { authToken: "super_secret" },
  async (client) => {
    return (await client.query("SELECT 1 AS value")).rows();
  }
);
```

After connecting, server metadata is available as `client.info`:

```ts
console.log(client.info?.serverDuckdbVersion);
console.log(client.info?.serverPlatform);
console.log(client.info?.quackVersion);
```

## Query Results

`query()` prepares the SQL, fetches all available result chunks, and returns a
materialized result object:

```ts
type ItemRow = { id: number; label: string };

const result = await client.query<ItemRow>(`
  SELECT 1::INTEGER AS id, 'one'::VARCHAR AS label
`);

console.log(result.names); // ["id", "label"]
console.log(result.types); // decoded DuckDB logical types
console.log(result.chunks); // decoded DuckDB DataChunks
console.log(result.rows()); // [{ id: 1, label: "one" }]
console.log(result.jsonRows()); // JSON-safe row objects
```

Queries accept positional or named parameters. Parameters are formatted as SQL
literals on the client side because the current Quack wire protocol does not
provide a separate bind-parameter message.

```ts
const row = await client.one<ItemRow>(
  "SELECT ?::INTEGER AS id, ?::VARCHAR AS label",
  [1, "one"]
);

const named = await client.first<ItemRow>(
  "SELECT :id::INTEGER AS id, :label::VARCHAR AS label",
  { id: 2, label: "two" }
);
```

Convenience query methods:

```ts
await client.first<ItemRow>("SELECT * FROM items ORDER BY id"); // ItemRow | null
await client.one<ItemRow>("SELECT * FROM items WHERE id = ?", [1]); // exactly one row
await client.values<bigint>("SELECT i FROM range(10) t(i)"); // first-column values
```

Pass `signal` or `timeoutMs` to query, fetch, append, and disconnect calls:

```ts
await client.query("SELECT * FROM slow_table", { timeoutMs: 30_000 });
```

For chunk-by-chunk processing, use `stream()`. For row-by-row processing, use
`streamRows()`:

```ts
for await (const chunk of client.stream("SELECT * FROM range(10000)")) {
  console.log(chunk.rowCount, chunk.columns.length);
}

for await (const row of client.streamRows<{ id: bigint }>("SELECT i AS id FROM range(10000) t(i)")) {
  console.log(row.id);
}
```

Transactions use the existing connection and automatically roll back when the
callback throws:

```ts
await client.transaction(async (tx) => {
  await tx.query("INSERT INTO items VALUES (?, ?)", [1, "one"]);
  await tx.query("INSERT INTO items VALUES (?, ?)", [2, "two"]);
});
```

## Appending Data

For application code, `appendRows()` is the most convenient append API:

```ts
import {
  LogicalTypes,
  QuackClient
} from "@quack-protocol/sdk";

const client = await QuackClient.connect("localhost:9494", {
  authToken: "super_secret"
});

await client.query(`
  CREATE TABLE target_table (
    id INTEGER,
    label VARCHAR,
    amount DECIMAL(10, 2)
  )
`);

await client.appendRows(
  "target_table",
  [
    { id: 1, label: "a", amount: "12.34" },
    { id: 2, label: "b", amount: "56.78" },
    { id: 3, label: "c", amount: null }
  ],
  {
    columns: {
      id: LogicalTypes.integer(),
      label: LogicalTypes.varchar(),
      amount: LogicalTypes.decimal(10, 2)
    }
  }
);
```

Use a table reference object for schema-qualified appends:

```ts
await client.appendRows(
  { schema: "analytics", table: "items" },
  rows,
  { columns, batchSize: 1000 }
);
```

For low-level append workloads, build a DuckDB `DataChunk` directly:

```ts
import { column, dataChunk, LogicalTypes } from "@quack-protocol/sdk";

const chunk = dataChunk([
  column(LogicalTypes.integer(), [1, 2, 3], "id"),
  column(LogicalTypes.varchar(), ["a", "b", "c"], "label")
]);

await client.append("target_table", chunk);
```

`append()` also accepts schema-qualified table references:

```ts
await client.append({ schema: "analytics", table: "items" }, chunk);
```

The builder keeps column names on the local chunk for row materialization, but
Quack append uses the target table schema and column order.

## Logical Types

Common helpers are available through `LogicalTypes`:

```ts
LogicalTypes.boolean();
LogicalTypes.tinyint();
LogicalTypes.smallint();
LogicalTypes.integer();
LogicalTypes.bigint();
LogicalTypes.utinyint();
LogicalTypes.usmallint();
LogicalTypes.uinteger();
LogicalTypes.ubigint();
LogicalTypes.hugeint();
LogicalTypes.uhugeint();
LogicalTypes.float();
LogicalTypes.double();
LogicalTypes.char();
LogicalTypes.varchar();
LogicalTypes.blob();
LogicalTypes.bit();
LogicalTypes.uuid();
LogicalTypes.date();
LogicalTypes.time();
LogicalTypes.timeNs();
LogicalTypes.timeTz();
LogicalTypes.timestamp();
LogicalTypes.timestampSeconds();
LogicalTypes.timestampMillis();
LogicalTypes.timestampNanos();
LogicalTypes.timestampTz();
LogicalTypes.interval();
LogicalTypes.decimal(18, 2);
LogicalTypes.list(LogicalTypes.integer());
LogicalTypes.map(LogicalTypes.varchar(), LogicalTypes.integer());
LogicalTypes.struct([
  { name: "id", type: LogicalTypes.integer() },
  { name: "label", type: LogicalTypes.varchar() }
]);
LogicalTypes.array(LogicalTypes.integer(), 3);
LogicalTypes.enum(["sad", "ok", "happy"]);
LogicalTypes.geometry();
```

For less common DuckDB logical types, use `logicalType()` and `LogicalTypeId`:

```ts
import { logicalType, LogicalTypeId } from "@quack-protocol/sdk";

const timeType = logicalType(LogicalTypeId.TIME);
const timestampNsType = logicalType(LogicalTypeId.TIMESTAMP_NS);
```

## Value Representation

Decoded rows use JavaScript primitives where they are lossless:

- `BOOLEAN` becomes `boolean`.
- Integer widths up to 32-bit become `number`.
- 64-bit and 128-bit integers become `bigint`.
- `FLOAT` and `DOUBLE` become `number`.
- `VARCHAR`, `CHAR`, and `ENUM` become `string`.
- `BLOB`, `BIT`, and `GEOMETRY` become `Uint8Array`.
- `UUID` becomes a canonical UUID string.
- `NULL` becomes `null`.

DuckDB-specific values are represented as tagged objects:

```ts
type DecimalValue = {
  kind: "decimal";
  value: bigint; // unscaled integer
  width: number;
  scale: number;
};

type DateValue = {
  kind: "date";
  days: number; // days since 1970-01-01
};

type TimeValue = {
  kind: "time";
  unit: "micros" | "nanos";
  value: bigint;
};

type TimeTzValue = {
  kind: "time_tz";
  bits: bigint; // DuckDB packed TIME WITH TIME ZONE value
};

type TimestampValue = {
  kind: "timestamp";
  unit: "seconds" | "millis" | "micros" | "nanos";
  value: bigint;
  timezone?: "utc";
};

type IntervalValue = {
  kind: "interval";
  months: number;
  days: number;
  micros: bigint;
};
```

Because `rows()` can contain `bigint`, `Uint8Array`, and tagged values with
`bigint` fields, its output is not guaranteed to be directly
`JSON.stringify()`-safe. Use `jsonRows()` when you want JSON-safe row objects:

```ts
const result = await client.query(`
  SELECT
    9007199254740993::BIGINT AS id,
    12.34::DECIMAL(4, 2) AS amount,
    'hi'::BLOB AS payload,
    TIMESTAMP '1970-01-01 00:00:01.234567' AS ts
`);

console.log(result.jsonRows());
// [{
//   id: "9007199254740993",
//   amount: "12.34",
//   payload: "aGk=",
//   ts: "1970-01-01T00:00:01.234567Z"
// }]
```

Default JSON conversions:

- `bigint` becomes a string.
- `Uint8Array` becomes a base64 string.
- `DECIMAL` becomes a scaled decimal string.
- `DATE` becomes an ISO `YYYY-MM-DD` string.
- `TIME` becomes an `HH:MM:SS.fraction` string.
- `TIMESTAMP` becomes an ISO timestamp string.
- `TIME WITH TIME ZONE` remains tagged with its packed bits as a string.
- `INTERVAL` remains tagged with `micros` as a string.
- Lists and structs are converted recursively.

You can also convert individual values or rows:

```ts
import {
  dateFromISODate,
  dateFromJSDate,
  decimalToString,
  decimalValue,
  intervalValue,
  toJsonRow,
  toJsonRows,
  toJsonValue,
  timeTzValue,
  timeValue,
  timestampFromJSDate,
  timestampValue
} from "@quack-protocol/sdk";

console.log(decimalToString(row.amount));

const amount = decimalValue("12.34", 10, 2);
const day = dateFromISODate("2020-01-02");
const timestamp = timestampFromJSDate(new Date(), "micros");
const interval = intervalValue(1, 2, 3n);

const jsonValue = toJsonValue(9007199254740993n);
const jsonRow = toJsonRow(row);
const jsonRows = toJsonRows(result.rows());
```

JSON conversion options let you choose a few alternate encodings:

```ts
result.jsonRows({
  bigint: "string", // or "number" for safe integers only
  bytes: "base64", // or "hex" or "array"
  decimal: "string", // or "tagged"
  date: "iso", // or "tagged"
  time: "string", // or "tagged"
  timestamp: "iso" // or "tagged"
});
```

## Package Exports

The root package exports the friendly client API, builders, logical types,
value helpers, errors, and codec types. Low-level protocol and binary codec
exports are also available through a dedicated subpath:

```ts
import { QuackClient, LogicalTypes } from "@quack-protocol/sdk";
import { BinaryReader, decodeMessage } from "@quack-protocol/sdk/protocol";
```

## Errors

The public error hierarchy is:

- `QuackError`: base class.
- `QuackProtocolError`: local transport, URI, codec, or client-state problem.
- `QuackServerError`: Quack server returned an error response.
- `QuackUnsupportedTypeError`: a known DuckDB serialization path is outside the
  supported implementation surface.

## Unsupported Metadata Paths

The supported protocol surface covers normal query results and append chunks.
Some rare DuckDB-internal serialization paths are intentionally rejected with
`QuackUnsupportedTypeError` because they require additional DuckDB internals
rather than just the Quack envelope:

- `FSST_VECTOR` compressed string vectors.
- `ExtensionTypeInfo` metadata attached to logical types.
- `UNBOUND_TYPE_INFO` when serialized with a `ParsedExpression` field.
- `INTEGER_LITERAL_TYPE_INFO` when serialized with a DuckDB `Value` field.
- Encoding integer literal metadata back to DuckDB.

These are explicit failures, not silent lossy decodes. Standard SQL result
types, nested result vectors, and flat append chunks do not normally require
these paths.

## Local Quack Server

The repository includes a helper script that starts DuckDB, installs and loads
the Quack extension, and calls `quack_serve()`:

```sh
npm run serve:quack
```

Defaults:

- `QUACK_SERVER_URI=quack:localhost`
- `QUACK_AUTH_TOKEN=super_secret`
- `QUACK_EXTENSION_REPOSITORY=core_nightly`
- `DUCKDB_BIN=duckdb`

Override them as needed:

```sh
QUACK_SERVER_URI=quack:localhost:9494 \
QUACK_AUTH_TOKEN=my_secret \
DUCKDB_BIN=/path/to/duckdb \
npm run serve:quack
```

The script also accepts the URI as its first argument:

```sh
bash scripts/start-quack-server.sh quack:localhost:9494
```

Additional server environment variables:

- `DUCKDB_DATABASE`: optional database path passed to the DuckDB CLI.
- `QUACK_EXTENSION_REPOSITORY`: extension repository name. Set it to an empty
  value to run `INSTALL quack;` without an explicit repository.

## Scripts

- `npm run build`: type-checks with TypeScript and bundles the ESM library with
  Vite.
- `npm run test`: runs unit tests for URI parsing, binary codecs, message
  codecs, logical type handling, and chunk encoding/decoding.
- `npm run test:watch`: runs Vitest in watch mode.
- `npm run check:duckdb`: verifies the local DuckDB CLI is at least `1.5.2`.
- `npm run serve:quack`: starts a local DuckDB Quack server.
- `npm run test:integration`: runs the live integration suite through
  `vitest.integration.config.ts`.

## Integration Tests

The integration tests run against a real DuckDB Quack server. If
`QUACK_INTEGRATION_URL` is set, the suite uses that server:

```sh
QUACK_INTEGRATION_URL=localhost:9494 \
QUACK_AUTH_TOKEN=super_secret \
npm run test:integration
```

If `QUACK_INTEGRATION_URL` is not set, Vitest global setup starts a temporary
local server with `scripts/start-quack-server.sh`, waits for it to become ready,
and tears it down after the suite.

Integration environment variables:

- `QUACK_INTEGRATION_URL`: use an already-running server instead of starting
  one.
- `QUACK_AUTH_TOKEN`: token used by the integration client. Defaults to
  `super_secret` when using an external server, and to a generated token when
  global setup starts the server.
- `QUACK_START_LOCAL_SERVER=0`: disable automatic local server startup.
- `QUACK_SERVER_URI`: URI used by the startup script when global setup starts a
  server.
- `QUACK_SERVER_START_TIMEOUT_MS`: readiness timeout, defaulting to `30000`.

Current integration coverage includes authentication, URI handling, connection
lifecycle, connection metadata, query result metadata, parameterized query
helpers, empty result sets, fetch pagination, chunk and row streaming, large
results, transactions, scalar result decoding, nested result decoding, scalar
append, nested append, row-oriented append, schema-qualified append, zero-row
append chunks, concurrency, and server error responses.

CI and release workflows install DuckDB CLI `v1.5.2` from
`https://install.duckdb.org/v1.5.2/duckdb_cli-linux-amd64.zip` and run the live
integration suite before a release is published.
