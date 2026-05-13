#!/usr/bin/env bash
set -euo pipefail

DUCKDB_BIN="${DUCKDB_BIN:-duckdb}"
QUACK_SERVER_URI="${1:-${QUACK_SERVER_URI:-quack:localhost}}"
QUACK_AUTH_TOKEN="${QUACK_AUTH_TOKEN:-super_secret}"
QUACK_EXTENSION_REPOSITORY="${QUACK_EXTENSION_REPOSITORY:-core_nightly}"
DUCKDB_DATABASE="${DUCKDB_DATABASE:-}"

if [ "${#QUACK_AUTH_TOKEN}" -lt 4 ]; then
  echo "QUACK_AUTH_TOKEN must be at least 4 characters long." >&2
  exit 1
fi

if [ -n "${QUACK_EXTENSION_REPOSITORY}" ]; then
  case "${QUACK_EXTENSION_REPOSITORY}" in
    *[!A-Za-z0-9_]*)
      echo "QUACK_EXTENSION_REPOSITORY must contain only letters, numbers, and underscores." >&2
      exit 1
      ;;
  esac
fi

sql_quote() {
  local escaped
  escaped="$(printf "%s" "$1" | sed "s/'/''/g")"
  printf "'%s'" "${escaped}"
}

uri_sql="$(sql_quote "${QUACK_SERVER_URI}")"
token_sql="$(sql_quote "${QUACK_AUTH_TOKEN}")"

if [ -n "${QUACK_EXTENSION_REPOSITORY}" ]; then
  install_sql="INSTALL quack FROM ${QUACK_EXTENSION_REPOSITORY};"
else
  install_sql="INSTALL quack;"
fi

startup_sql="${install_sql} LOAD quack; CALL quack_serve(${uri_sql}, token = ${token_sql});"

echo "Starting DuckDB Quack server at ${QUACK_SERVER_URI}" >&2
echo "Using DuckDB binary: ${DUCKDB_BIN}" >&2

args=(-init /dev/null -cmd "${startup_sql}")
if [ -n "${DUCKDB_DATABASE}" ]; then
  args+=("${DUCKDB_DATABASE}")
fi

# Keep the DuckDB CLI process alive after -cmd starts the in-process Quack server.
tail -f /dev/null | "${DUCKDB_BIN}" "${args[@]}"
