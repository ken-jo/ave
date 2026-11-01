/** Give jsdom renderer tests the WHATWG stream globals Chromium renderers always expose. */
import { ReadableStream, TransformStream, WritableStream } from "node:stream/web";

for (const [name, value] of Object.entries({ ReadableStream, TransformStream, WritableStream })) {
  if (!(name in globalThis)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
