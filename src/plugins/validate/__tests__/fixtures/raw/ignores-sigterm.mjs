/** Ignore start and SIGTERM so only escalation can end the fixture. */
import { constructed, speak, WITHHOLD } from "./speak.mjs";

process.on("SIGTERM", () => undefined);
speak({
  "ave/instance/construct": (request) => constructed(request.params, ["start"]),
  "ave/instance/start": WITHHOLD,
});
