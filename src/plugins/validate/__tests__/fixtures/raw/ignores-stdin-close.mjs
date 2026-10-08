/**
 * Answers the whole protocol, then ignores its stdin ending: a timer keeps it
 * alive, so only a termination ends it.
 */
import { speak } from "./speak.mjs";

speak({}, { exitOnEnd: false });
setInterval(() => undefined, 1_000);
