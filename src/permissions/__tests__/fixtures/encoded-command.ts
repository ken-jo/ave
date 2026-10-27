// The base64 of a script's UTF-16LE bytes: what PowerShell's -EncodedCommand takes.
export const encodeScript = (script: string): string => Buffer.from(script, "utf16le").toString("base64");
