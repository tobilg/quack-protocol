import { BinaryReader, BinaryWriter } from "./binary";
import { QuackProtocolError, QuackUnsupportedTypeError } from "./errors";

/** DuckDB physical storage types used by vectors. */
export enum PhysicalType {
  BOOL = 1,
  UINT8 = 2,
  INT8 = 3,
  UINT16 = 4,
  INT16 = 5,
  UINT32 = 6,
  INT32 = 7,
  UINT64 = 8,
  INT64 = 9,
  FLOAT = 11,
  DOUBLE = 12,
  INTERVAL = 21,
  LIST = 23,
  STRUCT = 24,
  ARRAY = 29,
  VARCHAR = 200,
  UINT128 = 203,
  INT128 = 204,
  UNKNOWN = 205,
  BIT = 206,
  INVALID = 255
}

/** DuckDB logical type ids serialized in Quack result schemas. */
export enum LogicalTypeId {
  INVALID = 0,
  SQLNULL = 1,
  UNKNOWN = 2,
  ANY = 3,
  UNBOUND = 4,
  TEMPLATE = 5,
  TYPE = 6,
  BOOLEAN = 10,
  TINYINT = 11,
  SMALLINT = 12,
  INTEGER = 13,
  BIGINT = 14,
  DATE = 15,
  TIME = 16,
  TIMESTAMP_SEC = 17,
  TIMESTAMP_MS = 18,
  TIMESTAMP = 19,
  TIMESTAMP_NS = 20,
  DECIMAL = 21,
  FLOAT = 22,
  DOUBLE = 23,
  CHAR = 24,
  VARCHAR = 25,
  BLOB = 26,
  INTERVAL = 27,
  UTINYINT = 28,
  USMALLINT = 29,
  UINTEGER = 30,
  UBIGINT = 31,
  TIMESTAMP_TZ = 32,
  TIME_TZ = 34,
  TIME_NS = 35,
  BIT = 36,
  STRING_LITERAL = 37,
  INTEGER_LITERAL = 38,
  BIGNUM = 39,
  UHUGEINT = 49,
  HUGEINT = 50,
  POINTER = 51,
  VALIDITY = 53,
  UUID = 54,
  GEOMETRY = 60,
  STRUCT = 100,
  LIST = 101,
  MAP = 102,
  TABLE = 103,
  ENUM = 104,
  AGGREGATE_STATE = 105,
  LAMBDA = 106,
  UNION = 107,
  ARRAY = 108,
  VARIANT = 109
}

/** DuckDB ExtraTypeInfo discriminator values. */
export enum ExtraTypeInfoType {
  INVALID = 0,
  GENERIC = 1,
  DECIMAL = 2,
  STRING = 3,
  LIST = 4,
  STRUCT = 5,
  ENUM = 6,
  UNBOUND = 7,
  AGGREGATE_STATE = 8,
  ARRAY = 9,
  ANY = 10,
  INTEGER_LITERAL = 11,
  TEMPLATE = 12,
  GEO = 13
}

/** DuckDB logical type plus optional type-specific metadata. */
export interface LogicalType {
  /** Logical type id. */
  id: LogicalTypeId;
  /** Optional metadata for nested, decimal, enum, and other logical types. */
  typeInfo?: ExtraTypeInfo;
}

/** Named child type used by STRUCT and related logical types. */
export interface ChildType {
  /** Child field name. */
  name: string;
  /** Child logical type. */
  type: LogicalType;
}

/** Coordinate reference system metadata for GEOMETRY logical types. */
export interface CoordinateReferenceSystem {
  /** CRS definition string as serialized by DuckDB. */
  definition?: string;
}

interface BaseExtraTypeInfo {
  type: ExtraTypeInfoType;
  alias?: string;
}

/** Generic or invalid type metadata. */
export interface GenericTypeInfo extends BaseExtraTypeInfo {
  type: ExtraTypeInfoType.GENERIC | ExtraTypeInfoType.INVALID;
}

/** DECIMAL type metadata. */
export interface DecimalTypeInfo extends BaseExtraTypeInfo {
  type: ExtraTypeInfoType.DECIMAL;
  /** Decimal width. */
  width: number;
  /** Decimal scale. */
  scale: number;
}

/** String collation metadata. */
export interface StringTypeInfo extends BaseExtraTypeInfo {
  type: ExtraTypeInfoType.STRING;
  /** Optional DuckDB collation name. */
  collation?: string;
}

/** LIST or MAP child-type metadata. */
export interface ListTypeInfo extends BaseExtraTypeInfo {
  type: ExtraTypeInfoType.LIST;
  /** Child logical type. */
  childType: LogicalType;
}

/** STRUCT child metadata. */
export interface StructTypeInfo extends BaseExtraTypeInfo {
  type: ExtraTypeInfoType.STRUCT;
  /** Named child fields. */
  childTypes: ChildType[];
}

/** ENUM value metadata. */
export interface EnumTypeInfo extends BaseExtraTypeInfo {
  type: ExtraTypeInfoType.ENUM;
  /** Ordered enum values. */
  values: string[];
}

/** AGGREGATE_STATE metadata. */
export interface AggregateStateTypeInfo extends BaseExtraTypeInfo {
  type: ExtraTypeInfoType.AGGREGATE_STATE;
  /** Aggregate function name. */
  functionName: string;
  /** Aggregate return type. */
  returnType: LogicalType;
  /** Bound argument types. */
  boundArgumentTypes: LogicalType[];
}

/** ARRAY child type and fixed size metadata. */
export interface ArrayTypeInfo extends BaseExtraTypeInfo {
  type: ExtraTypeInfoType.ARRAY;
  /** Array element logical type. */
  childType: LogicalType;
  /** Fixed number of elements per array value. */
  size: number;
}

/** ANY type metadata. */
export interface AnyTypeInfo extends BaseExtraTypeInfo {
  type: ExtraTypeInfoType.ANY;
  /** Target type. */
  targetType: LogicalType;
  /** DuckDB cast score. */
  castScore: bigint;
}

/** TEMPLATE type metadata. */
export interface TemplateTypeInfo extends BaseExtraTypeInfo {
  type: ExtraTypeInfoType.TEMPLATE;
  /** Template type name. */
  name: string;
}

/** INTEGER_LITERAL metadata marker. */
export interface IntegerLiteralTypeInfo extends BaseExtraTypeInfo {
  type: ExtraTypeInfoType.INTEGER_LITERAL;
}

/** GEOMETRY CRS metadata. */
export interface GeoTypeInfo extends BaseExtraTypeInfo {
  type: ExtraTypeInfoType.GEO;
  /** Optional coordinate reference system. */
  crs?: CoordinateReferenceSystem;
}

/** UNBOUND type metadata. */
export interface UnboundTypeInfo extends BaseExtraTypeInfo {
  type: ExtraTypeInfoType.UNBOUND;
  /** Unbound type name. */
  name?: string;
  /** Optional catalog name. */
  catalog?: string;
  /** Optional schema name. */
  schema?: string;
}

/** Union of DuckDB logical type metadata variants supported by the SDK. */
export type ExtraTypeInfo =
  | GenericTypeInfo
  | DecimalTypeInfo
  | StringTypeInfo
  | ListTypeInfo
  | StructTypeInfo
  | EnumTypeInfo
  | AggregateStateTypeInfo
  | ArrayTypeInfo
  | AnyTypeInfo
  | TemplateTypeInfo
  | IntegerLiteralTypeInfo
  | GeoTypeInfo
  | UnboundTypeInfo;

/** Create a logical type object from a DuckDB logical type id and metadata. */
export function logicalType(id: LogicalTypeId, typeInfo?: ExtraTypeInfo): LogicalType {
  return typeInfo ? { id, typeInfo } : { id };
}

/** Convenience constructors for common DuckDB logical types. */
export const LogicalTypes = {
  /** SQL NULL logical type. */
  null: () => logicalType(LogicalTypeId.SQLNULL),
  /** BOOLEAN logical type. */
  boolean: () => logicalType(LogicalTypeId.BOOLEAN),
  /** TINYINT logical type. */
  tinyint: () => logicalType(LogicalTypeId.TINYINT),
  /** SMALLINT logical type. */
  smallint: () => logicalType(LogicalTypeId.SMALLINT),
  /** INTEGER logical type. */
  integer: () => logicalType(LogicalTypeId.INTEGER),
  /** BIGINT logical type. */
  bigint: () => logicalType(LogicalTypeId.BIGINT),
  /** UTINYINT logical type. */
  utinyint: () => logicalType(LogicalTypeId.UTINYINT),
  /** USMALLINT logical type. */
  usmallint: () => logicalType(LogicalTypeId.USMALLINT),
  /** UINTEGER logical type. */
  uinteger: () => logicalType(LogicalTypeId.UINTEGER),
  /** UBIGINT logical type. */
  ubigint: () => logicalType(LogicalTypeId.UBIGINT),
  /** HUGEINT logical type. */
  hugeint: () => logicalType(LogicalTypeId.HUGEINT),
  /** UHUGEINT logical type. */
  uhugeint: () => logicalType(LogicalTypeId.UHUGEINT),
  /** FLOAT logical type. */
  float: () => logicalType(LogicalTypeId.FLOAT),
  /** DOUBLE logical type. */
  double: () => logicalType(LogicalTypeId.DOUBLE),
  /** CHAR logical type with optional collation metadata. */
  char: (collation?: string) =>
    collation
      ? logicalType(LogicalTypeId.CHAR, { type: ExtraTypeInfoType.STRING, collation })
      : logicalType(LogicalTypeId.CHAR),
  /** VARCHAR logical type with optional collation metadata. */
  varchar: (collation?: string) =>
    collation
      ? logicalType(LogicalTypeId.VARCHAR, { type: ExtraTypeInfoType.STRING, collation })
      : logicalType(LogicalTypeId.VARCHAR),
  /** BLOB logical type. */
  blob: () => logicalType(LogicalTypeId.BLOB),
  /** BIT logical type. */
  bit: () => logicalType(LogicalTypeId.BIT),
  /** UUID logical type. */
  uuid: () => logicalType(LogicalTypeId.UUID),
  /** DATE logical type. */
  date: () => logicalType(LogicalTypeId.DATE),
  /** TIME logical type. */
  time: () => logicalType(LogicalTypeId.TIME),
  /** TIME_NS logical type. */
  timeNs: () => logicalType(LogicalTypeId.TIME_NS),
  /** TIME WITH TIME ZONE logical type. */
  timeTz: () => logicalType(LogicalTypeId.TIME_TZ),
  /** TIMESTAMP logical type in microseconds. */
  timestamp: () => logicalType(LogicalTypeId.TIMESTAMP),
  /** TIMESTAMP_S logical type. */
  timestampSeconds: () => logicalType(LogicalTypeId.TIMESTAMP_SEC),
  /** TIMESTAMP_MS logical type. */
  timestampMillis: () => logicalType(LogicalTypeId.TIMESTAMP_MS),
  /** TIMESTAMP_NS logical type. */
  timestampNanos: () => logicalType(LogicalTypeId.TIMESTAMP_NS),
  /** TIMESTAMP WITH TIME ZONE logical type. */
  timestampTz: () => logicalType(LogicalTypeId.TIMESTAMP_TZ),
  /** INTERVAL logical type. */
  interval: () => logicalType(LogicalTypeId.INTERVAL),
  /** DECIMAL logical type with width and scale metadata. */
  decimal: (width: number, scale: number) =>
    logicalType(LogicalTypeId.DECIMAL, { type: ExtraTypeInfoType.DECIMAL, width, scale }),
  /** LIST logical type with a child type. */
  list: (childType: LogicalType) => logicalType(LogicalTypeId.LIST, { type: ExtraTypeInfoType.LIST, childType }),
  /** MAP logical type with key and value child types. */
  map: (keyType: LogicalType, valueType: LogicalType) =>
    logicalType(LogicalTypeId.MAP, {
      type: ExtraTypeInfoType.LIST,
      childType: logicalType(LogicalTypeId.STRUCT, {
        type: ExtraTypeInfoType.STRUCT,
        childTypes: [
          { name: "key", type: keyType },
          { name: "value", type: valueType }
        ]
      })
    }),
  /** STRUCT logical type with named child fields. */
  struct: (childTypes: ChildType[]) =>
    logicalType(LogicalTypeId.STRUCT, { type: ExtraTypeInfoType.STRUCT, childTypes }),
  /** ARRAY logical type with child type and fixed size. */
  array: (childType: LogicalType, size: number) =>
    logicalType(LogicalTypeId.ARRAY, { type: ExtraTypeInfoType.ARRAY, childType, size }),
  /** ENUM logical type with ordered values. */
  enum: (values: string[]) => logicalType(LogicalTypeId.ENUM, { type: ExtraTypeInfoType.ENUM, values }),
  /** GEOMETRY logical type with optional CRS metadata. */
  geometry: (crs?: CoordinateReferenceSystem) =>
    crs ? logicalType(LogicalTypeId.GEOMETRY, { type: ExtraTypeInfoType.GEO, crs }) : logicalType(LogicalTypeId.GEOMETRY)
} as const;

/** Encode a DuckDB logical type. */
export function encodeLogicalType(writer: BinaryWriter, type: LogicalType): void {
  writer.writeObject((object) => {
    object.writeField(100, () => object.writeUleb(type.id));
    if (type.typeInfo) {
      object.writeField(101, () => object.writeNullable(type.typeInfo, (typeInfo) => encodeExtraTypeInfo(object, typeInfo)));
    }
  });
}

/** Decode a DuckDB logical type. */
export function decodeLogicalType(reader: BinaryReader): LogicalType {
  return reader.readObject((object) => {
    const id = object.readRequiredField(100, () => object.readUlebNumber()) as LogicalTypeId;
    const typeInfo = object.readOptionalField(101, () => object.readNullable(() => decodeExtraTypeInfo(object)), undefined);
    return typeInfo ? { id, typeInfo } : { id };
  });
}

/** Encode DuckDB ExtraTypeInfo metadata. */
export function encodeExtraTypeInfo(writer: BinaryWriter, info: ExtraTypeInfo): void {
  writer.writeObject((object) => {
    object.writeField(100, () => object.writeUleb(info.type));
    if (info.alias) {
      object.writeField(101, () => object.writeString(info.alias as string));
    }

    switch (info.type) {
      case ExtraTypeInfoType.INVALID:
      case ExtraTypeInfoType.GENERIC:
        break;
      case ExtraTypeInfoType.DECIMAL:
        object.writeField(200, () => object.writeUleb(info.width));
        object.writeField(201, () => object.writeUleb(info.scale));
        break;
      case ExtraTypeInfoType.STRING:
        object.writeField(200, () => object.writeString(info.collation ?? ""));
        break;
      case ExtraTypeInfoType.LIST:
        object.writeField(200, () => encodeLogicalType(object, info.childType));
        break;
      case ExtraTypeInfoType.STRUCT:
        object.writeField(200, () => encodeChildTypes(object, info.childTypes));
        break;
      case ExtraTypeInfoType.ENUM:
        object.writeField(200, () => object.writeUleb(info.values.length));
        object.writeField(201, () => object.writeList(info.values, (value) => object.writeString(value)));
        break;
      case ExtraTypeInfoType.AGGREGATE_STATE:
        object.writeField(200, () => object.writeString(info.functionName));
        object.writeField(201, () => encodeLogicalType(object, info.returnType));
        object.writeField(202, () => object.writeList(info.boundArgumentTypes, (type) => encodeLogicalType(object, type)));
        break;
      case ExtraTypeInfoType.ARRAY:
        object.writeField(200, () => encodeLogicalType(object, info.childType));
        object.writeField(201, () => object.writeUleb(info.size));
        break;
      case ExtraTypeInfoType.ANY:
        object.writeField(200, () => encodeLogicalType(object, info.targetType));
        object.writeField(201, () => object.writeUleb(info.castScore));
        break;
      case ExtraTypeInfoType.TEMPLATE:
        object.writeField(200, () => object.writeString(info.name));
        break;
      case ExtraTypeInfoType.INTEGER_LITERAL:
        throw new QuackUnsupportedTypeError("Encoding INTEGER_LITERAL type metadata is not supported");
      case ExtraTypeInfoType.GEO:
        object.writeField(200, () => encodeCoordinateReferenceSystem(object, info.crs ?? {}));
        break;
      case ExtraTypeInfoType.UNBOUND:
        if (info.name) {
          object.writeField(200, () => object.writeString(info.name as string));
        }
        if (info.catalog) {
          object.writeField(201, () => object.writeString(info.catalog as string));
        }
        if (info.schema) {
          object.writeField(202, () => object.writeString(info.schema as string));
        }
        break;
      default:
        assertNever(info);
    }
  });
}

/** Decode DuckDB ExtraTypeInfo metadata. */
export function decodeExtraTypeInfo(reader: BinaryReader): ExtraTypeInfo {
  return reader.readObject((object) => {
    const type = object.readRequiredField(100, () => object.readUlebNumber()) as ExtraTypeInfoType;
    const alias = object.readOptionalField(101, () => object.readString(), undefined);
    object.readOptionalField(103, () => object.readNullable(() => {
      throw new QuackUnsupportedTypeError("Extension type metadata is not supported by quack-ts");
    }), undefined);

    const base = alias ? { alias } : {};
    switch (type) {
      case ExtraTypeInfoType.INVALID:
      case ExtraTypeInfoType.GENERIC:
        return { ...base, type };
      case ExtraTypeInfoType.DECIMAL:
        return {
          ...base,
          type,
          width: object.readOptionalField(200, () => object.readUlebNumber(), 0),
          scale: object.readOptionalField(201, () => object.readUlebNumber(), 0)
        };
      case ExtraTypeInfoType.STRING:
        return {
          ...base,
          type,
          collation: object.readOptionalField(200, () => object.readString(), "")
        };
      case ExtraTypeInfoType.LIST:
        return {
          ...base,
          type,
          childType: object.readRequiredField(200, () => decodeLogicalType(object))
        };
      case ExtraTypeInfoType.STRUCT:
        return {
          ...base,
          type,
          childTypes: object.readOptionalField(200, () => decodeChildTypes(object), [])
        };
      case ExtraTypeInfoType.ENUM: {
        const valuesCount = object.readRequiredField(200, () => object.readUlebNumber());
        const values = object.readRequiredField(201, () => object.readList(() => object.readString()));
        if (values.length !== valuesCount) {
          throw new QuackProtocolError(`ENUM metadata declared ${valuesCount} values but serialized ${values.length}`);
        }
        return { ...base, type, values };
      }
      case ExtraTypeInfoType.AGGREGATE_STATE:
        return {
          ...base,
          type,
          functionName: object.readRequiredField(200, () => object.readString()),
          returnType: object.readRequiredField(201, () => decodeLogicalType(object)),
          boundArgumentTypes: object.readRequiredField(202, () => object.readList(() => decodeLogicalType(object)))
        };
      case ExtraTypeInfoType.ARRAY:
        return {
          ...base,
          type,
          childType: object.readRequiredField(200, () => decodeLogicalType(object)),
          size: object.readRequiredField(201, () => object.readUlebNumber())
        };
      case ExtraTypeInfoType.ANY:
        return {
          ...base,
          type,
          targetType: object.readRequiredField(200, () => decodeLogicalType(object)),
          castScore: object.readRequiredField(201, () => object.readUlebBigInt())
        };
      case ExtraTypeInfoType.INTEGER_LITERAL:
        if (object.peekFieldId() === 200) {
          throw new QuackUnsupportedTypeError("INTEGER_LITERAL type metadata contains a DuckDB Value, which is not supported");
        }
        return { ...base, type };
      case ExtraTypeInfoType.TEMPLATE:
        return {
          ...base,
          type,
          name: object.readOptionalField(200, () => object.readString(), "")
        };
      case ExtraTypeInfoType.GEO:
        return {
          ...base,
          type,
          crs: object.readOptionalField(200, () => decodeCoordinateReferenceSystem(object), {})
        };
      case ExtraTypeInfoType.UNBOUND:
        if (object.peekFieldId() === 204) {
          throw new QuackUnsupportedTypeError("UNBOUND type metadata contains a ParsedExpression, which is not supported");
        }
        const name = object.readOptionalField(200, () => object.readString(), undefined);
        const catalog = object.readOptionalField(201, () => object.readString(), undefined);
        const schema = object.readOptionalField(202, () => object.readString(), undefined);
        return {
          ...base,
          type,
          ...optionalProp("name", name),
          ...optionalProp("catalog", catalog),
          ...optionalProp("schema", schema)
        };
      default:
        throw new QuackProtocolError(`Unknown ExtraTypeInfoType ${type}`);
    }
  });
}

/** Resolve the physical vector type used for a logical type. */
export function getPhysicalType(type: LogicalType): PhysicalType {
  switch (type.id) {
    case LogicalTypeId.BOOLEAN:
      return PhysicalType.BOOL;
    case LogicalTypeId.TINYINT:
      return PhysicalType.INT8;
    case LogicalTypeId.UTINYINT:
      return PhysicalType.UINT8;
    case LogicalTypeId.SMALLINT:
      return PhysicalType.INT16;
    case LogicalTypeId.USMALLINT:
      return PhysicalType.UINT16;
    case LogicalTypeId.SQLNULL:
    case LogicalTypeId.DATE:
    case LogicalTypeId.INTEGER:
      return PhysicalType.INT32;
    case LogicalTypeId.UINTEGER:
      return PhysicalType.UINT32;
    case LogicalTypeId.BIGINT:
    case LogicalTypeId.TIME:
    case LogicalTypeId.TIME_NS:
    case LogicalTypeId.TIMESTAMP:
    case LogicalTypeId.TIMESTAMP_SEC:
    case LogicalTypeId.TIMESTAMP_NS:
    case LogicalTypeId.TIMESTAMP_MS:
    case LogicalTypeId.TIME_TZ:
    case LogicalTypeId.TIMESTAMP_TZ:
      return PhysicalType.INT64;
    case LogicalTypeId.UBIGINT:
      return PhysicalType.UINT64;
    case LogicalTypeId.UHUGEINT:
      return PhysicalType.UINT128;
    case LogicalTypeId.HUGEINT:
    case LogicalTypeId.UUID:
      return PhysicalType.INT128;
    case LogicalTypeId.FLOAT:
      return PhysicalType.FLOAT;
    case LogicalTypeId.DOUBLE:
      return PhysicalType.DOUBLE;
    case LogicalTypeId.DECIMAL:
      return getDecimalPhysicalType(type);
    case LogicalTypeId.BIGNUM:
    case LogicalTypeId.VARCHAR:
    case LogicalTypeId.CHAR:
    case LogicalTypeId.BLOB:
    case LogicalTypeId.BIT:
    case LogicalTypeId.TYPE:
    case LogicalTypeId.AGGREGATE_STATE:
    case LogicalTypeId.GEOMETRY:
      return PhysicalType.VARCHAR;
    case LogicalTypeId.INTERVAL:
      return PhysicalType.INTERVAL;
    case LogicalTypeId.UNION:
    case LogicalTypeId.VARIANT:
    case LogicalTypeId.STRUCT:
      return PhysicalType.STRUCT;
    case LogicalTypeId.LIST:
    case LogicalTypeId.MAP:
      return PhysicalType.LIST;
    case LogicalTypeId.ARRAY:
      return PhysicalType.ARRAY;
    case LogicalTypeId.POINTER:
      return PhysicalType.UINT64;
    case LogicalTypeId.VALIDITY:
      return PhysicalType.BIT;
    case LogicalTypeId.ENUM:
      return getEnumPhysicalType(type);
    default:
      return PhysicalType.INVALID;
  }
}

/** Whether a physical type has fixed-size values in vector storage. */
export function isConstantSizePhysicalType(type: PhysicalType): boolean {
  switch (type) {
    case PhysicalType.BOOL:
    case PhysicalType.UINT8:
    case PhysicalType.INT8:
    case PhysicalType.UINT16:
    case PhysicalType.INT16:
    case PhysicalType.UINT32:
    case PhysicalType.INT32:
    case PhysicalType.UINT64:
    case PhysicalType.INT64:
    case PhysicalType.FLOAT:
    case PhysicalType.DOUBLE:
    case PhysicalType.INTERVAL:
    case PhysicalType.UINT128:
    case PhysicalType.INT128:
      return true;
    default:
      return false;
  }
}

/** Return the fixed byte width for a constant-size physical type. */
export function physicalTypeSize(type: PhysicalType): number {
  switch (type) {
    case PhysicalType.BOOL:
    case PhysicalType.UINT8:
    case PhysicalType.INT8:
      return 1;
    case PhysicalType.UINT16:
    case PhysicalType.INT16:
      return 2;
    case PhysicalType.UINT32:
    case PhysicalType.INT32:
    case PhysicalType.FLOAT:
      return 4;
    case PhysicalType.UINT64:
    case PhysicalType.INT64:
    case PhysicalType.DOUBLE:
      return 8;
    case PhysicalType.INTERVAL:
    case PhysicalType.UINT128:
    case PhysicalType.INT128:
      return 16;
    default:
      throw new QuackProtocolError(`Physical type ${type} is not fixed size`);
  }
}

/** Return the child type for LIST, MAP, or ARRAY logical types. */
export function getChildType(type: LogicalType): LogicalType {
  const info = type.typeInfo;
  if (info?.type === ExtraTypeInfoType.LIST || info?.type === ExtraTypeInfoType.ARRAY) {
    return info.childType;
  }
  throw new QuackProtocolError(`Logical type ${LogicalTypeId[type.id] ?? type.id} does not have a child type`);
}

/** Return the named child types for STRUCT-like logical types. */
export function getStructChildren(type: LogicalType): ChildType[] {
  const info = type.typeInfo;
  if (info?.type === ExtraTypeInfoType.STRUCT) {
    return info.childTypes;
  }
  if (type.id === LogicalTypeId.VARIANT || type.id === LogicalTypeId.UNION) {
    return [];
  }
  throw new QuackProtocolError(`Logical type ${LogicalTypeId[type.id] ?? type.id} does not have struct children`);
}

/** Return the fixed element count for an ARRAY logical type. */
export function getArraySize(type: LogicalType): number {
  const info = type.typeInfo;
  if (info?.type !== ExtraTypeInfoType.ARRAY) {
    throw new QuackProtocolError(`Logical type ${LogicalTypeId[type.id] ?? type.id} is not an ARRAY`);
  }
  return info.size;
}

/** Return the string values for an ENUM logical type. */
export function getEnumValues(type: LogicalType): string[] {
  const info = type.typeInfo;
  if (info?.type !== ExtraTypeInfoType.ENUM) {
    throw new QuackProtocolError(`Logical type ${LogicalTypeId[type.id] ?? type.id} is not an ENUM`);
  }
  return info.values;
}

function encodeChildTypes(writer: BinaryWriter, children: readonly ChildType[]): void {
  writer.writeList(children, (child) => {
    writer.writeObject((pair) => {
      pair.writeField(0, () => pair.writeString(child.name));
      pair.writeField(1, () => encodeLogicalType(pair, child.type));
    });
  });
}

function decodeChildTypes(reader: BinaryReader): ChildType[] {
  return reader.readList(() =>
    reader.readObject((pair) => ({
      name: pair.readRequiredField(0, () => pair.readString()),
      type: pair.readRequiredField(1, () => decodeLogicalType(pair))
    }))
  );
}

function encodeCoordinateReferenceSystem(writer: BinaryWriter, crs: CoordinateReferenceSystem): void {
  writer.writeObject((object) => {
    if (crs.definition) {
      object.writeField(100, () => object.writeString(crs.definition as string));
    }
  });
}

function decodeCoordinateReferenceSystem(reader: BinaryReader): CoordinateReferenceSystem {
  return reader.readObject((object) => {
    const definition = object.readOptionalField(100, () => object.readString(), undefined);
    return definition === undefined ? {} : { definition };
  });
}

function getDecimalPhysicalType(type: LogicalType): PhysicalType {
  const info = type.typeInfo;
  if (info?.type !== ExtraTypeInfoType.DECIMAL) {
    throw new QuackProtocolError("DECIMAL type is missing DecimalTypeInfo");
  }
  if (info.width <= 4) {
    return PhysicalType.INT16;
  }
  if (info.width <= 9) {
    return PhysicalType.INT32;
  }
  if (info.width <= 18) {
    return PhysicalType.INT64;
  }
  if (info.width <= 38) {
    return PhysicalType.INT128;
  }
  throw new QuackProtocolError(`Unsupported DECIMAL width ${info.width}`);
}

function getEnumPhysicalType(type: LogicalType): PhysicalType {
  const values = getEnumValues(type);
  if (values.length <= 0xff) {
    return PhysicalType.UINT8;
  }
  if (values.length <= 0xffff) {
    return PhysicalType.UINT16;
  }
  return PhysicalType.UINT32;
}

function assertNever(value: never): never {
  throw new QuackProtocolError(`Unhandled value ${String(value)}`);
}

function optionalProp<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: T };
}
