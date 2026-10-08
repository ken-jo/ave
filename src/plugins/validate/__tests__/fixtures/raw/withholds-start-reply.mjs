/** Answers construct, declaring a start hook, and never answers start. */
import { constructed, speak, WITHHOLD } from "./speak.mjs";

speak({
  "ave/instance/construct": (request) => constructed(request.params, ["start"]),
  "ave/instance/start": WITHHOLD,
});
