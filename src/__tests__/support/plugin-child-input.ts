import { Transform, type Readable, type Writable } from "node:stream";
import { PluginChildInputWriteDecoder, pluginChildInputCredit } from "../../plugins/isolation/plugin-child-credit.js";

export function consumePluginChildInput(source: Readable, sink: Writable): Transform {
  const decoder = new PluginChildInputWriteDecoder();
  return source.pipe(new Transform({
    transform(chunk: Buffer, _encoding, done) {
      decoder.push(chunk, (payload, id, consumed) => {
        this.push(payload);
        sink.write(pluginChildInputCredit(id, consumed));
      });
      done();
    },
  }));
}
