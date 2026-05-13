import { describe, expect, it } from "vitest";
import { BinaryReader, BinaryWriter, combineSignedHugeInt } from "../src/binary";

describe("BinaryReader/BinaryWriter", () => {
  it("round-trips DuckDB-style objects and primitive encodings", () => {
    const writer = new BinaryWriter();
    writer.writeObject((object) => {
      object.writeField(1, () => object.writeString("hello"));
      object.writeField(2, () => object.writeSleb(-12345));
      object.writeField(3, () => object.writeUleb(987654321n));
      object.writeField(4, () => object.writeHugeInt(-42n));
    });

    const reader = new BinaryReader(writer.toUint8Array());
    const decoded = reader.readObject((object) => ({
      string: object.readRequiredField(1, () => object.readString()),
      signed: object.readRequiredField(2, () => object.readSlebNumber()),
      unsigned: object.readRequiredField(3, () => object.readUlebBigInt()),
      huge: object.readRequiredField(4, () => object.readHugeInt())
    }));
    reader.assertEof();

    expect(decoded.string).toBe("hello");
    expect(decoded.signed).toBe(-12345);
    expect(decoded.unsigned).toBe(987654321n);
    expect(combineSignedHugeInt(decoded.huge)).toBe(-42n);
  });
});
