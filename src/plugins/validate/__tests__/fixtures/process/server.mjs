/**
 * The protocol script the fixture's launcher runs. It reports on stderr what
 * the launch handed it — the declared pair, the host-owned pair and its own
 * arguments — so the validator's test can read them, then answers the host.
 */
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
