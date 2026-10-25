/** Delay construct beyond the activation bound but inside the session cleanup deadline. */
import { constructed, reply, speak, WITHHOLD } from "./speak.mjs";

speak({
  "ave/instance/construct": (request) => {
    setTimeout(() => reply(request.id, constructed(request.params)), 10_500);
    return WITHHOLD;
  },
});
