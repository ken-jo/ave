const { createHash } = require("node:crypto");

const FONT_DATA_URL = /data:(?:application\/(?:x-)?font-[^;,]*|font\/[^;,]*)(?:;[^,]*)?,[^'"\s)\\]*/g;
const FONT_FORMATS = new Map([
  ["application/x-font-woff", { signature: "wOFF", extension: "woff", headerBytes: 44 }],
  ["application/font-woff", { signature: "wOFF", extension: "woff", headerBytes: 44 }],
  ["font/woff", { signature: "wOFF", extension: "woff", headerBytes: 44 }],
  ["application/font-woff2", { signature: "wOF2", extension: "woff2", headerBytes: 48 }],
  ["font/woff2", { signature: "wOF2", extension: "woff2", headerBytes: 48 }],
]);

// Embedded font bytes use local emitted resources under the document's existing font policy.
module.exports = function bundledFontResourceLoader(source) {
  this.cacheable?.();
  const emitted = new Set();
  return source.replace(FONT_DATA_URL, (url) => {
    const match = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    const format = match && FONT_FORMATS.get(match[1]);
    if (!match || !format) throw new Error("Unsupported embedded font data");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.toString("base64") !== match[2] || bytes.length < format.headerBytes
      || bytes.toString("ascii", 0, 4) !== format.signature || bytes.readUInt32BE(8) !== bytes.length) {
      throw new Error("Invalid embedded font data");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const filename = `renderer/fonts/${digest}.${format.extension}`;
    if (!emitted.has(filename)) {
      this.emitFile(filename, bytes);
      emitted.add(filename);
    }
    return `./${filename}`;
  });
};
