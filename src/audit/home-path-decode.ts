import { HOME_NAMED_ENTITIES } from "./home-named-entities.js";

const HEX_VALUES = new Int16Array(128).fill(-1);
for (let digit = 0; digit < 16; digit++) {
  const character = digit.toString(16);
  HEX_VALUES[character.charCodeAt(0)] = digit;
  HEX_VALUES[character.toUpperCase().charCodeAt(0)] = digit;
}
const SINGLE_ESCAPES = new Int16Array(128).fill(-1);
for (const [character, value] of [[34, 34], [39, 39], [47, 47], [92, 92], [98, 8], [102, 12], [110, 10], [114, 13], [116, 9]]) SINGLE_ESCAPES[character] = value;

// The bounded trie avoids allocating a substring or result object for each escape attempt.
const entityTrie: { value: number; next: Map<number, number> }[] = [{ value: -1, next: new Map() }];
for (const [name, value] of Object.entries(HOME_NAMED_ENTITIES)) {
  let node = 0;
  for (const character of name) {
    const code = character.charCodeAt(0);
    let next = entityTrie[node].next.get(code);
    if (next === undefined) {
      next = entityTrie.length;
      entityTrie[node].next.set(code, next);
      entityTrie.push({ value: -1, next: new Map() });
    }
    node = next;
  }
  entityTrie[node].value = value;
}

function hexValue(code: number): number {
  return code < 128 ? HEX_VALUES[code] : -1;
}

function escapedByte(text: string, index: number, width: number): number {
  if (width === 3 ? text.charCodeAt(index) !== 37 : text.charCodeAt(index) !== 92 || text.charCodeAt(index + 1) !== 120) return -1;
  const high = hexValue(text.charCodeAt(index + width - 2));
  const low = hexValue(text.charCodeAt(index + width - 1));
  return high < 0 || low < 0 ? -1 : high * 16 + low;
}

interface EscapeValue {
  value: number;
}

function setEscapeValue(output: EscapeValue, value: number, width: number): number {
  output.value = value;
  return width;
}

/** UTF-8 is decoded only across adjacent escapes from the same byte family. */
function readByteEscape(text: string, index: number, width: number, output: EscapeValue): number {
  const first = escapedByte(text, index, width);
  if (first < 0) return -1;
  let count = 1;
  let value = first;
  let minimum = 0x80;
  let maximum = 0xbf;
  if (first >= 0xc2 && first <= 0xdf) { count = 2; value = first & 31; }
  else if (first >= 0xe0 && first <= 0xef) {
    count = 3; value = first & 15;
    if (first === 0xe0) minimum = 0xa0;
    if (first === 0xed) maximum = 0x9f;
  } else if (first >= 0xf0 && first <= 0xf4) {
    count = 4; value = first & 7;
    if (first === 0xf0) minimum = 0x90;
    if (first === 0xf4) maximum = 0x8f;
  }
  for (let offset = 1; offset < count; offset++) {
    const byte = escapedByte(text, index + offset * width, width);
    if (byte < (offset === 1 ? minimum : 0x80) || byte > (offset === 1 ? maximum : 0xbf)) return setEscapeValue(output, first, width);
    value = value * 64 + (byte & 63);
  }
  return setEscapeValue(output, value, width * count);
}

/** Reuse the caller’s single value slot for escape recognition. */
function readHomeEscape(text: string, index: number, output: EscapeValue): number {
  const code = text.charCodeAt(index);
  if (code === 37) return readByteEscape(text, index, 3, output);
  if (code === 92) {
    const next = text.charCodeAt(index + 1);
    if (next === 120) return readByteEscape(text, index, 4, output);
    if (next === 117) {
      let value = 0;
      for (let offset = 2; offset < 6; offset++) {
        const digit = hexValue(text.charCodeAt(index + offset));
        if (digit < 0) return -1;
        value = value * 16 + digit;
      }
      return setEscapeValue(output, value, 6);
    }
    const value = next < 128 ? SINGLE_ESCAPES[next] : -1;
    return value >= 0 ? setEscapeValue(output, value, 2) : -1;
  }
  if (code !== 38) return -1;
  if (text.charCodeAt(index + 1) === 35) {
    let cursor = index + 2;
    const radix = text.charCodeAt(cursor) === 120 || text.charCodeAt(cursor) === 88 ? 16 : 10;
    if (radix === 16) cursor++;
    const digitsStart = cursor;
    // Only this introducer visits these zeros, even for a malformed numeric reference.
    while (text.charCodeAt(cursor) === 48) cursor++;
    let value = 0;
    let significant = 0;
    while (significant < 8) {
      const digit = hexValue(text.charCodeAt(cursor));
      if (digit < 0 || digit >= radix) break;
      value = value * radix + digit;
      significant++;
      cursor++;
    }
    if (cursor === digitsStart || text.charCodeAt(cursor) !== 59 || value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return -1;
    return setEscapeValue(output, value, cursor - index + 1);
  }
  let node = 0;
  for (let cursor = index + 1; cursor <= index + 18; cursor++) {
    const character = text.charCodeAt(cursor);
    if (character === 59) return entityTrie[node].value < 0 ? -1 : setEscapeValue(output, entityTrie[node].value, cursor - index + 1);
    const next = entityTrie[node].next.get(character);
    if (next === undefined) return -1;
    node = next;
  }
  return -1;
}


export type HomeEscapeFamily = "full" | "backslash" | "percent-entity";

/** Apply one faithful decoding layer. Escape output is never scanned again in this layer. */
export function decodeHomeEscapes(text: string, family: HomeEscapeFamily): string {
  const backslashes = family !== "percent-entity";
  const percentEntities = family !== "backslash";
  const output: EscapeValue = { value: 0 };
  let units: Uint16Array | undefined;
  let prefix = 0;
  let length = 0;
  const write = (index: number): Uint16Array => {
    if (!units) {
      prefix = index;
      units = new Uint16Array(text.length - index);
    }
    return units;
  };
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    if (backslashes && code === 92 && text.charCodeAt(index + 1) === 92) {
      let end = index + 2;
      while (text.charCodeAt(end) === 92) end++;
      const pairs = Math.floor((end - index) / 2);
      write(index).fill(92, length, length + pairs);
      length += pairs;
      index += pairs * 2;
      continue;
    }
    const width = (backslashes && code === 92 || percentEntities && (code === 37 || code === 38))
      ? readHomeEscape(text, index, output) : -1;
    if (width < 0) {
      if (units) units[length++] = code;
      index++;
      continue;
    }
    const buffer = write(index);
    if (output.value <= 0xffff) {
      buffer[length++] = output.value;
    } else {
      const pair = output.value - 0x10000;
      buffer[length++] = 0xd800 + (pair >> 10);
      buffer[length++] = 0xdc00 + (pair & 0x3ff);
    }
    index += width;
  }
  if (!units) return text;
  let decoded = text.slice(0, prefix);
  for (let offset = 0; offset < length; offset += 8192) {
    decoded += String.fromCharCode(...units.subarray(offset, Math.min(offset + 8192, length)));
  }
  return decoded;
}
