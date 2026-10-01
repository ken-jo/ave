/** Answers construct requiring an `ave/host/*` method no host serves. */
import { constructed, speak } from "./speak.mjs";

speak({
  "ave/instance/construct": (request) => constructed(request.params, [], ["ave/host/notServedAnywhere"]),
});
