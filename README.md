# @quack-protocol/sdk

TypeScript client and binary codecs for DuckDB's experimental Quack protocol.

This package implements the Quack HTTP transport, DuckDB `BinarySerializer`
field/object encoding, logical type metadata, `DataChunk` decoding, and flat
`DataChunk` encoding for append workloads. It is ESM-only, depends only on
[`@uwdata/flechette`](https://github.com/uwdata/flechette) for Arrow support,
and uses the standard `fetch` API, so it can run in modern browsers, Node, and
other runtimes with a compatible fetch implementation.

Quack is still experimental upstream. The protocol is tightly coupled to
DuckDB's internal binary serialization format. This SDK speaks **Quack protocol
version 3**, as served by DuckDB **v2.0.0** and later. Servers that only speak
earlier protocol versions (DuckDB 1.5.x) are not supported; use SDK `0.2.x`
for those. The implementation follows the upstream sources pinned as git
submodules under [`references/`](#reference-sources) and the
[Quack protocol analysis](https://gist.github.com/tobilg/9ced9d08f6141b723f26cf205d5b9ece).

## Status

Implemented:

- Connection string parsing for bare hosts like `localhost:9494`, DuckDB-style
  Quack URIs like `quack:host:port`, bracketed IPv6 hosts, and direct
  `http://` or `https://` URLs.
- HTTP `POST /quack` transport with `application/vnd.duckdb` request and
  response bodies.
- All Quack v3 messages: connection, prepare, batch-indexed fetch with
  acknowledgement indices, send-data (client data streams), cancel,
  acknowledgement, heartbeat, disconnect, success, and typed error responses.
- Heartbeat leases, server-side query cancellation, per-client statement
  queueing, and request timeouts that cancel the server statement.
- Typed query rows, row streaming, `first()`, `one()`, `values()`, scoped
  connections, and transactions.
- SQL parameter formatting for positional `?` and named `:name` placeholders.
- DuckDB binary object fields, required/default properties, nullable pointers,
  lists, strings, blobs, signed/unsigned LEB128 integers, and signed/unsigned
  hugeints.
- Logical type metadata for the scalar, decimal, enum, list, struct, map,
  array, aggregate-state, template, generic, string, any, unbound legacy, and
  geometry CRS paths needed for supported Quack traffic.
- Result `DataChunk` decoding for flat, constant, dictionary, and sequence
  vectors, including DuckDB 2.0's length/byte-blob string vector layout.
- Flat append chunk encoding for scalars, decimals, UUIDs, enums, temporal
  values, intervals, strings, blobs, lists/maps, structs, tuples, and arrays.
- Atomic appends through `INSERT … SELECT * FROM scan_data_from_quack_client(…)`
  and `SEND_DATA` batches, returning the inserted row count.
- Row-oriented and Arrow append helpers for common application code, plus
  low-level protocol exports under `@quack-protocol/sdk/protocol`.

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
  range, defaulting to version `3`.
- `heartbeatTimeoutSeconds`: lease timeout requested from the server, default
  `60`. The server drops connections that send no request for this long.
- `heartbeat`: send heartbeat requests while the client is idle, default
  `true`. The timer renews the lease at about a third of the timeout and does
  not keep a Node process alive.
- `clientId`: optional stable client identifier (at least 4 characters) the
  server uses for reconnect bookkeeping.
- `acknowledgeResults`: acknowledge each fully received result so the server
  can release its reconnect cache (only relevant when the server sets
  `quack_enable_reconnects`), default `false`.
- `fetch`: custom fetch implementation.
- `headers`: additional HTTP headers.
- `ssl`: transport for `quack:` and bare-host connection strings. `true`
  forces HTTPS, `false` forces HTTP. By default the client follows DuckDB:
  HTTP for `localhost`, `127.0.0.1`, and `::1`, HTTPS for every other host.
  `http://` and `https://` URLs always keep their scheme.
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

Like DuckDB, `quack:` and bare-host connection strings use HTTPS for every host
other than `localhost`, `127.0.0.1`, and `::1`, matching `quack_serve()`, which
serves HTTPS on non-local addresses by default (and only listens on them when
started with `allow_other_hostname := true`):

```ts
await QuackClient.connect("db.example.com", { authToken }); // https://db.example.com:9494
await QuackClient.connect("quack:10.0.0.5", { authToken, ssl: false }); // http://10.0.0.5:9494
```

The server certificate must be trusted by the runtime's `fetch`. DuckDB
clients can pin a self-signed certificate by fingerprint, but `fetch` cannot,
so serve a certificate from a trusted CA (`quack_serve(…, ssl_cert_file := …,
ssl_key_file := …)`) or put a TLS-terminating proxy in front of the server. A
server started with `disable_ssl := true` needs `ssl: false` on the client.

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
console.log(client.info?.quackVersion); // 3n
console.log(client.info?.heartbeatTimeoutSeconds); // lease accepted by the server
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

Pass `signal` or `timeoutMs` to query, fetch, append, and disconnect calls.
When a request is aborted or times out, the client also cancels the statement
on the server:

```ts
await client.query("SELECT * FROM slow_table", { timeoutMs: 30_000 });
```

`cancel()` interrupts the statement currently running on the client:

```ts
const running = client.query("SELECT * FROM huge_table");
await client.cancel(); // resolves to false when nothing is running
await running; // rejects with QuackServerError "Interrupted: query was cancelled"
```

The server sends up to `quack_prepare_inline_rows` rows (24576 by default) in
the prepare response and the rest in fetch batches. Pass `inlineRows` to
change that per query, for example `{ inlineRows: 0 }` to stream everything
through fetch batches.

A Quack connection runs one statement at a time, and the server cancels a
running statement when the next one starts. The client therefore queues
statements issued concurrently on the same instance, so
`Promise.all([client.query(a), client.query(b)])` is safe. Use separate
clients when statements should actually run in parallel.

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

Breaking out of a stream loop cancels the rest of the result on the server.
Streams release the statement queue between fetch batches, so a statement
started on the same client before a stream is drained interrupts that stream:
its next fetch throws a `QuackProtocolError`.

Transactions use the existing connection and automatically roll back when the
callback throws:

```ts
await client.transaction(async (tx) => {
  await tx.query("INSERT INTO items VALUES (?, ?)", [1, "one"]);
  await tx.query("INSERT INTO items VALUES (?, ?)", [2, "two"]);
});
```

## Arrow Results

The SDK can expose query results as Apache Arrow data through
`@uwdata/flechette`:

```ts
const table = await client.queryArrow(
  "SELECT 1::INTEGER AS id, 12.34::DECIMAL(10, 2) AS amount",
  {
    useDecimalInt: true,
    useBigInt: true,
    useBigIntTimestamp: true
  }
);

console.log(table.numRows);
console.log(table.toColumns());
console.log(table.toArray());
```

`queryArrow()` accepts the same SQL parameter forms as `query()`, plus
Flechette extraction options: `useDate`, `useDecimalInt`, `useBigInt`,
`useBigIntTimestamp`, `useMap`, `useProxy`, and `useGeoJSON`. `GEOMETRY`
columns are tagged as `geoarrow.wkb`, so `useGeoJSON: true` returns GeoJSON
geometry objects instead of WKB bytes.

Use `queryArrowIPC()` to collect results as Arrow IPC bytes:

```ts
const ipc = await client.queryArrowIPC("SELECT * FROM items", {
  format: "stream",
  useBigInt: true
});
```

For chunk-by-chunk Arrow processing, use `streamArrow()`:

```ts
for await (const table of client.streamArrow("SELECT * FROM range(10000)")) {
  console.log(table.numRows, table.names);
}
```

Low-level conversion helpers are exported for callers that already have Quack
chunks or Flechette tables:

```ts
import {
  arrowIPCFromChunks,
  arrowTableFromChunks,
  dataChunksFromArrowIPC,
  dataChunksFromArrowTable
} from "@quack-protocol/sdk";
```

## Appending Data

Quack v3 appends data by running an `INSERT INTO <table> SELECT * FROM
scan_data_from_quack_client(…)` statement and streaming the rows to it in
`SEND_DATA` batches. All append helpers therefore:

- insert everything passed in one call atomically: either all rows are
  inserted or none,
- match columns by position against the target table,
- resolve the target table like SQL does, so `TEMP` tables and the current
  transaction are visible,
- resolve to the number of inserted rows.

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

const inserted = await client.appendRows(
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

Use a table reference object for schema- or catalog-qualified appends:

```ts
await client.appendRows(
  { catalog: "warehouse", schema: "analytics", table: "items" },
  rows,
  { columns, batchSize: 1000 }
);
```

`batchSize` controls how many rows are encoded per local `DataChunk`. On the
wire, chunks are split to at most 2048 rows and grouped into `SEND_DATA`
batches automatically.

For low-level append workloads, build a DuckDB `DataChunk` directly:

```ts
import { column, dataChunk, LogicalTypes } from "@quack-protocol/sdk";

const chunk = dataChunk([
  column(LogicalTypes.integer(), [1, 2, 3], "id"),
  column(LogicalTypes.varchar(), ["a", "b", "c"], "label")
]);

await client.append("target_table", chunk);
```

`append()` also accepts schema-qualified table references and arrays of
chunks with identical column types, which are inserted by one statement:

```ts
await client.append({ schema: "analytics", table: "items" }, chunk);
await client.append("target_table", [chunk1, chunk2]);
```

Arrow tables and Arrow IPC bytes can also be appended:

```ts
import { decimal128, int32, tableFromArrays, utf8 } from "@uwdata/flechette";
import { LogicalTypes } from "@quack-protocol/sdk";

const arrow = tableFromArrays(
  {
    id: [1, 2],
    label: ["one", "two"],
    amount: [1234n, null]
  },
  {
    types: {
      id: int32(),
      label: utf8(),
      amount: decimal128(10, 2)
    },
    useDecimalInt: true
  }
);

await client.appendArrow("target_table", arrow, {
  duckTypes: {
    id: LogicalTypes.integer(),
    label: LogicalTypes.varchar(),
    amount: LogicalTypes.decimal(10, 2)
  },
  useDecimalInt: true
});
```

Arrow data produced by this SDK includes DuckDB logical type metadata, so it can
usually be appended back without `duckTypes`. External Arrow data should provide
`duckTypes` when a DuckDB target type is ambiguous, for example decimals,
enums, UUIDs, or temporal precision.

The builder keeps column names on the local chunk for row materialization, but
Quack append uses the target table schema and column order.

The append statement declares its column types with SQL type text rendered by
`logicalTypeToSql()` (for example `DECIMAL(10,2)` or
`STRUCT("a" INTEGER, "b" VARCHAR[])`), and DuckDB casts them to the table's
column types where needed.

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
LogicalTypes.timestampTzNanos();
LogicalTypes.interval();
LogicalTypes.decimal(18, 2);
LogicalTypes.list(LogicalTypes.integer());
LogicalTypes.map(LogicalTypes.varchar(), LogicalTypes.integer());
LogicalTypes.struct([
  { name: "id", type: LogicalTypes.integer() },
  { name: "label", type: LogicalTypes.varchar() }
]);
LogicalTypes.tuple([LogicalTypes.integer(), LogicalTypes.varchar()]);
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
- `TUPLE` (DuckDB 2.0's unnamed struct, e.g. `(1, 'a')`) becomes an array in
  member order; `STRUCT` becomes an object.
- `VARIANT` is returned in DuckDB's internal storage layout (`keys`,
  `children`, `values`, `data`); cast it to `VARCHAR` or `JSON` in SQL for
  readable values.
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
  timezone?: "utc"; // TIMESTAMPTZ (micros) and TIMESTAMPTZ_NS (nanos)
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
- `QuackServerError`: Quack server returned an error response. It carries
  `serverMessage`, the DuckDB `exceptionType` (for example `Catalog` or
  `Binder`), `extraInfo` metadata, and `mustInvalidate`, which is set when the
  server's database has been invalidated. After such an error the client
  refuses further requests; the server has to be restarted.
- `QuackUnsupportedTypeError`: a known DuckDB serialization path is outside the
  supported implementation surface.

## Unsupported Metadata Paths

The supported protocol surface covers normal query results and append chunks.
Some rare DuckDB-internal serialization paths are intentionally rejected with
`QuackUnsupportedTypeError` because they require additional DuckDB internals
rather than just the Quack envelope:

- `FSST_VECTOR` compressed string vectors.
- `SHREDDED_VECTOR` VARIANT vectors (cast VARIANT values to `VARCHAR` or `JSON`
  in SQL instead).
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
- `QUACK_EXTENSION_REPOSITORY=core`
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
- `npm run check:duckdb`: verifies the local DuckDB CLI (`DUCKDB_BIN`, default
  `duckdb`) is at least `2.0.0`.
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
lifecycle, connection metadata, protocol version and heartbeat negotiation,
heartbeat lease renewal and expiry, query result metadata, parameterized query
helpers, empty result sets, multi-batch fetch, chunk and row streaming, stream
interruption and early exit, query cancellation and timeouts, large results,
transactions, scalar and nested result decoding, scalar, nested, row-oriented,
Arrow, schema-qualified, multi-batch, atomic, transactional, and zero-row
appends, statement queueing, concurrency, and typed server error responses.

CI and release workflows install DuckDB CLI `v2.0.0` from
`https://install.duckdb.org/v2.0.0/duckdb-cli-linux-amd64.tar.gz` and run the
live integration suite before a release is published.

## Reference Sources

The upstream sources this SDK is ported from are pinned as git submodules
under `references/`. They are not built or published:

- `references/duckdb-quack`: the Quack extension (message definitions in
  `src/include/quack_message.hpp`, serialization in
  `src/serialize_quack_message.cpp`, server handling in `src/quack_server.cpp`).
- `references/duckdb`: DuckDB `v2.0-cyanoptera` (vector, `DataChunk`, and
  logical type serialization), cloned shallow.
- `references/flechette`: Flechette `v2.7.0`.

Fetch them after cloning with:

```sh
git submodule update --init
```
