// 依存ライブラリなしの JSON Schema (2020-12) サブセット検証器。
// schema/ で使うキーワードだけを実装し、未対応キーワードを見つけたら例外にする
// （黙って無視して「検証したつもり」になるのを防ぐため）。

import { isIsoWithOffset } from "./time.js";

const SUPPORTED = new Set([
  "$schema", "$id", "$defs", "$comment", "$ref", "title", "description", "default", "examples",
  "type", "properties", "required", "additionalProperties", "items",
  "enum", "const", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minLength", "minItems", "uniqueItems", "format", "allOf",
]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function typeOk(type, v) {
  switch (type) {
    case "null": return v === null;
    case "boolean": return typeof v === "boolean";
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return Number.isInteger(v);
    case "array": return Array.isArray(v);
    case "object": return isPlainObject(v);
    default: throw new Error(`未対応の type: ${type}`);
  }
}

// schemas: { "<$id>": schemaObject, ... }
export function createValidator(schemas) {
  function resolve(ref, root) {
    const [file, pointer = ""] = ref.split("#");
    const target = file ? schemas[file] : root;
    if (!target) throw new Error(`$ref の参照先がありません: ${ref}`);
    let node = target;
    for (const part of pointer.split("/").filter(Boolean)) {
      node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      if (node === undefined) throw new Error(`$ref の参照先がありません: ${ref}`);
    }
    return { schema: node, root: target };
  }

  function check(schema, data, path, root, errors) {
    for (const key of Object.keys(schema)) {
      if (!SUPPORTED.has(key)) throw new Error(`未対応のスキーマキーワード "${key}"（${path}）`);
    }
    if (schema.$ref) {
      const r = resolve(schema.$ref, root);
      check(r.schema, data, path, r.root, errors);
    }
    if (schema.allOf) schema.allOf.forEach(s => check(s, data, path, root, errors));

    if (schema.type !== undefined) {
      const types = [].concat(schema.type);
      if (!types.some(t => typeOk(t, data))) {
        errors.push(`${path}: 型が不正（期待: ${types.join("|")}、実際: ${data === null ? "null" : Array.isArray(data) ? "array" : typeof data}）`);
        return;
      }
    }
    if (Object.hasOwn(schema, "const") && !deepEqual(schema.const, data)) {
      errors.push(`${path}: ${JSON.stringify(schema.const)} である必要があります`);
    }
    if (schema.enum && !schema.enum.some(e => deepEqual(e, data))) {
      errors.push(`${path}: 許可されていない値 ${JSON.stringify(data)}（許可: ${schema.enum.map(e => JSON.stringify(e)).join(", ")}）`);
    }

    if (typeof data === "number") {
      if (schema.minimum !== undefined && data < schema.minimum) errors.push(`${path}: ${schema.minimum} 以上が必要`);
      if (schema.maximum !== undefined && data > schema.maximum) errors.push(`${path}: ${schema.maximum} 以下が必要`);
      if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) errors.push(`${path}: ${schema.exclusiveMinimum} より大きい値が必要`);
      if (schema.exclusiveMaximum !== undefined && data >= schema.exclusiveMaximum) errors.push(`${path}: ${schema.exclusiveMaximum} より小さい値が必要`);
    }

    if (typeof data === "string") {
      if (schema.minLength !== undefined && data.length < schema.minLength) errors.push(`${path}: ${schema.minLength} 文字以上が必要`);
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(data)) errors.push(`${path}: 形式が不正（${schema.pattern}）: ${data}`);
      if (schema.format !== undefined) {
        if (schema.format !== "date-time") throw new Error(`未対応の format: ${schema.format}`);
        if (!isIsoWithOffset(data)) errors.push(`${path}: タイムゾーン付きISO 8601ではありません: ${data}`);
      }
    }

    if (Array.isArray(data)) {
      if (schema.minItems !== undefined && data.length < schema.minItems) errors.push(`${path}: ${schema.minItems} 件以上が必要`);
      if (schema.uniqueItems && data.some((x, i) => data.findIndex(y => deepEqual(x, y)) !== i)) errors.push(`${path}: 重複した要素があります`);
      if (schema.items) data.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, root, errors));
    }

    if (isPlainObject(data)) {
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(data, key)) errors.push(`${path}: 必須項目 "${key}" がありません`);
      }
      const props = schema.properties ?? {};
      for (const [key, value] of Object.entries(data)) {
        if (Object.hasOwn(props, key)) {
          check(props[key], value, `${path}.${key}`, root, errors);
        } else if (schema.additionalProperties === false) {
          errors.push(`${path}: 定義されていない項目 "${key}"`);
        } else if (isPlainObject(schema.additionalProperties)) {
          check(schema.additionalProperties, value, `${path}.${key}`, root, errors);
        }
      }
    }
  }

  return function validate(schemaId, data) {
    const schema = schemas[schemaId];
    if (!schema) throw new Error(`スキーマがありません: ${schemaId}`);
    const errors = [];
    check(schema, data, "$", schema, errors);
    return errors;
  };
}
