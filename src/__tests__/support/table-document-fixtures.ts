import * as XLSX from "xlsx";

export function cyclicWorkbook(): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["x"]]), "S");
  const bytes = XLSX.write(book, { type: "buffer", bookType: "biff8" }) as Buffer;
  const sectorSize = 2 ** bytes.readUInt16LE(30);
  const directory = (bytes.readUInt32LE(48) + 1) * sectorSize;
  // The root's two stream children become each other's right sibling.
  bytes.writeInt32LE(2, directory + 128 + 72);
  bytes.writeInt32LE(1, directory + 256 + 72);
  return bytes;
}

export function offsetWorkbook(bookType: "xlsx" | "biff8" | "ods"): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, {
    A10001: { t: "s", v: "late value" },
    B10002: { t: "n", v: 42 },
    "!ref": "A10001:B10002",
  }, "Offset");
  return XLSX.write(book, { type: "buffer", bookType }) as Buffer;
}
