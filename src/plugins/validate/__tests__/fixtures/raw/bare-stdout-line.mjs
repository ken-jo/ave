/** Prints a bare `ready` line before its first frame, then speaks the protocol. */
import { speak } from "./speak.mjs";

process.stdout.write("ready\n");
speak();
