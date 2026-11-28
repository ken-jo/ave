import type { Readable } from "node:stream";

/** Everything a child's stream yields until it closes, as UTF-8; an absent stream yields "". */
export function collectStream(stream: Readable | null | undefined): Promise<string> {
  if (stream === null || stream === undefined) return Promise.resolve("");
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return new Promise(done => { stream.once("close", () => done(Buffer.concat(chunks).toString("utf8"))); });
}
