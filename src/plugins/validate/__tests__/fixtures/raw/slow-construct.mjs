/**
 * Answers construct after 10.5 s — past the runtime's 10 s activation bound,
 * inside the session's 20 s cleanup deadline.
 */
import { constructed, reply, speak, WITHHOLD } from "./speak.mjs";

speak({
  "ave/instance/construct": (request) => {
    setTimeout(() => reply(request.id, constructed(request.params)), 10_500);
    return WITHHOLD;
  },
});
