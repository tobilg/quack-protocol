import { describe, expect, it } from "vitest";
import { LogicalTypeId } from "../../src";
import { integrationUrl, withClient } from "./helpers";

describe.skipIf(!integrationUrl)("Quack nested type decoding", () => {
  it("decodes lists, structs, maps, arrays, empty values, and null nested values", async () => {
    await withClient(async (client) => {
      const result = await client.query(`
        SELECT
          [1, 2, 3]::INTEGER[] AS list_v,
          []::INTEGER[] AS empty_list_v,
          NULL::INTEGER[] AS null_list_v,
          [[1, 2], [3]]::INTEGER[][] AS nested_list_v,
          struct_pack(a := 1, b := 'x') AS struct_v,
          NULL::STRUCT(a INTEGER, b VARCHAR) AS null_struct_v,
          map(['a', 'b'], [1, 2]) AS map_v,
          map([]::VARCHAR[], []::INTEGER[]) AS empty_map_v,
          array_value(1, 2, 3)::INTEGER[3] AS array_v,
          NULL::INTEGER[3] AS null_array_v,
          struct_pack(items := [1, 2]::INTEGER[], nested := struct_pack(flag := TRUE)) AS mixed_v
      `);

      expect(result.rows()).toEqual([
        {
          list_v: [1, 2, 3],
          empty_list_v: [],
          null_list_v: null,
          nested_list_v: [
            [1, 2],
            [3]
          ],
          struct_v: { a: 1, b: "x" },
          null_struct_v: null,
          map_v: [
            { key: "a", value: 1 },
            { key: "b", value: 2 }
          ],
          empty_map_v: [],
          array_v: [1, 2, 3],
          null_array_v: null,
          mixed_v: { items: [1, 2], nested: { flag: true } }
        }
      ]);

      expect(result.types.map((type) => type.id)).toEqual([
        LogicalTypeId.LIST,
        LogicalTypeId.LIST,
        LogicalTypeId.LIST,
        LogicalTypeId.LIST,
        LogicalTypeId.STRUCT,
        LogicalTypeId.STRUCT,
        LogicalTypeId.MAP,
        LogicalTypeId.MAP,
        LogicalTypeId.ARRAY,
        LogicalTypeId.ARRAY,
        LogicalTypeId.STRUCT
      ]);
    });
  });
});
