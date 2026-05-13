import { execFileSync } from "node:child_process";

const minimum = [1, 5, 2];

try {
  const output = execFileSync("duckdb", ["--version"], { encoding: "utf8" }).trim();
  const match = output.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Could not parse DuckDB version from: ${output}`);
  }
  const version = match.slice(1, 4).map(Number);
  const ok = version[0] > minimum[0]
    || (version[0] === minimum[0] && version[1] > minimum[1])
    || (version[0] === minimum[0] && version[1] === minimum[1] && version[2] >= minimum[2]);
  if (!ok) {
    throw new Error(`DuckDB ${minimum.join(".")} or newer is required; found ${version.join(".")}`);
  }
  console.log(output);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
