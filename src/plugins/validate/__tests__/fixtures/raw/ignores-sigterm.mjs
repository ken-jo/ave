/**
 * Answers construct, declaring a start hook, ignores SIGTERM and never
 * answers start: only the SIGKILL that follows the grace period ends it.
 */
import { constructed, speak, WITHHOLD } from "./speak.mjs";

process.on("SIGTERM", () => undefined);
speak({
  "ave/instance/construct": (request) => constructed(request.params, ["start"]),
  "ave/instance/start": WITHHOLD,
});
