/** Quack protocol version targeted by this SDK. */
export const QUACK_VERSION = 1;
/** Default TCP port used for Quack HTTP transport. */
export const DEFAULT_QUACK_PORT = 9494;
/** HTTP endpoint used by the Quack server. */
export const QUACK_ENDPOINT = "/quack";
/** MIME type used for Quack binary request and response bodies. */
export const DUCKDB_MIME_TYPE = "application/duckdb";
/** DuckDB BinarySerializer field-id marker indicating end of object. */
export const FIELD_END = 0xffff;
/** DuckDB optional-index sentinel used when an optional index is absent. */
export const OPTIONAL_INDEX_INVALID = 0xffff_ffff_ffff_ffffn;
