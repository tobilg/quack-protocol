/** Quack protocol version targeted by this SDK. */
export const QUACK_VERSION = 3;
/** Default TCP port used for Quack HTTP transport. */
export const DEFAULT_QUACK_PORT = 9494;
/** HTTP endpoint used by the Quack server. */
export const QUACK_ENDPOINT = "/quack";
/** MIME type used for Quack binary request and response bodies. */
export const DUCKDB_MIME_TYPE = "application/vnd.duckdb";
/** DuckDB BinarySerializer field-id marker indicating end of object. */
export const FIELD_END = 0xffff;
/** DuckDB optional-index sentinel used when an optional index is absent. */
export const OPTIONAL_INDEX_INVALID = 0xffff_ffff_ffff_ffffn;
/** Heartbeat lease timeout in seconds requested when connecting, matching DuckDB's client default. */
export const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 60;
/** Upper bound DuckDB enforces on the heartbeat lease timeout. */
export const MAX_HEARTBEAT_TIMEOUT_SECONDS = 0x7fff_ffff_ffff_ffffn / 1000n;
/** DuckDB's standard vector size; append chunks are split to at most this many rows. */
export const STANDARD_VECTOR_SIZE = 2048;
