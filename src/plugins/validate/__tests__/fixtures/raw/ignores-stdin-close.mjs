/** Keep a timer alive after stdin closes so termination is required. */
import { speak } from "./speak.mjs";

speak({}, { exitOnEnd: false });
setInterval(() => undefined, 1_000);
