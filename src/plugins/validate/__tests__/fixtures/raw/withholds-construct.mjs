/** Reads construct and never answers it in time: the reply is written 2 s later. */
import { constructed, reply, speak, WITHHOLD } from "./speak.mjs";

speak({
  "ave/instance/construct": (request) => {
    setTimeout(() => reply(request.id, constructed(request.params)), 2_000);
    return WITHHOLD;
  },
});
