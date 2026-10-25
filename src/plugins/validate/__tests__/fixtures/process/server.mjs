/** Report launch environment and argv on stderr, then answer the host protocol. */
import { speak } from "../raw/speak.mjs";

process.stderr.write(
  `launch=${JSON.stringify({
    PLUGIN_ROOT: process.env.PLUGIN_ROOT,
    PLUGIN_DATA: process.env.PLUGIN_DATA,
    SMOKE_VENDOR_DIR: process.env.SMOKE_VENDOR_DIR,
    SMOKE_STATE_DIR: process.env.SMOKE_STATE_DIR,
    argv: process.argv.slice(1),
  })}\n`,
);
speak();
