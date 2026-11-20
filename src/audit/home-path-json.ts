import { isProxy, isStringObject } from "node:util/types";
import { mayContainHomePath, redactHomePathsInText } from "./dlp-filter.js";

interface RenamedKey {
  source: string;
  target: string;
}

interface KeySpan {
  start: number;
  end: number;
  quoted: string;
  rename: RenamedKey | undefined;
}

function assignKeyNames(keys: readonly KeySpan[]): void {
  if (!keys.some(({ rename }) => rename)) return;
  const groups = new Map<string, KeySpan[]>();
  for (const key of keys) {
    if (key.rename) key.quoted = JSON.stringify(key.rename.target);
    const group = groups.get(key.quoted);
    if (group) group.push(key);
    else groups.set(key.quoted, [key]);
  }
  const reserved = new Set(groups.keys());
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Unchanged keys keep their names. Renamed keys compete in source order.
    group.sort((a, b) => {
      if (!a.rename) return b.rename ? -1 : 0;
      if (!b.rename) return 1;
      return a.rename.source < b.rename.source ? -1 : 1;
    });
    let suffix = 2;
    for (const key of group.slice(1)) {
      const target = key.rename?.target;
      if (target === undefined) continue;
      let quoted: string;
      do { quoted = JSON.stringify(`${target}#${suffix++}`); } while (reserved.has(quoted));
      reserved.add(quoted);
      key.quoted = quoted;
    }
  }
}

/** Edit only the property-name tokens emitted by the native serializer. */
function replaceSerializedKeys(serialized: string, renames: ReadonlyMap<number, RenamedKey>): string {
  const objects: KeySpan[][] = [];
  const edits: KeySpan[] = [];
  let property = 0;
  for (let cursor = 0; cursor < serialized.length;) {
    const code = serialized.charCodeAt(cursor++);
    if (code === 123) objects.push([]);
    else if (code === 125) {
      const keys = objects.pop();
      if (keys) assignKeyNames(keys);
    } else if (code === 34) {
      const start = cursor - 1;
      // Native JSON guarantees a closing quote. Skip each complete escape
      // iteratively so value length cannot exhaust the regexp stack.
      while (serialized.charCodeAt(cursor) !== 34) {
        cursor += serialized.charCodeAt(cursor) === 92 ? 2 : 1;
      }
      cursor++;
      if (serialized.charCodeAt(cursor) !== 58) continue;
      const rename = renames.get(property++);
      const key = { start, end: cursor, quoted: serialized.slice(start, cursor), rename };
      objects.at(-1)?.push(key);
      if (rename) edits.push(key);
    }
  }
  let output = "";
  let copied = 0;
  for (const { start, end, quoted } of edits) {
    output += serialized.slice(copied, start) + quoted;
    copied = end;
  }
  return output + serialized.slice(copied);
}

function hasRedactableKeys(value: object): boolean {
  // Use the properties emitted by the native serializer for proxies. Inspecting
  // their prototypes would invoke a hook that serialization does not call.
  if (isProxy(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEmittedProperty(value: unknown): boolean {
  return value !== undefined && typeof value !== "function" && typeof value !== "symbol";
}

/** Let native serialization read properties and invoke hooks at their original keys. */
export function stringifyHomeRedacted(value: unknown): string | undefined {
  let root = true;
  let property = 0;
  let renames: Map<number, RenamedKey> | undefined;
  const replace = function (this: object, key: string, current: unknown): unknown {
    if (root) root = false;
    else if (!Array.isArray(this) && isEmittedProperty(current)) {
      if (mayContainHomePath(key)) {
        const target = redactHomePathsInText(key);
        if (key !== target && hasRedactableKeys(this)) {
          renames ??= new Map();
          renames.set(property, { source: key, target });
        }
      }
      property++;
    }
    if (typeof current === "string") return redactHomePathsInText(current);
    // Native serialization unboxes these after calling the replacer.
    if (isStringObject(current)) return redactHomePathsInText(String(current));
    return current;
  };
  const serialized = JSON.stringify(value, replace);
  // Renaming before serialization would change both getter order and the key
  // passed to child toJSON hooks. Raw JSON and value bytes stay native here.
  return serialized !== undefined && renames ? replaceSerializedKeys(serialized, renames) : serialized;
}
