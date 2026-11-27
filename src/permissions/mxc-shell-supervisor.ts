import "../main/bare-program-lookup.js";
import { runMxcShellSupervisorProcess } from "./mxc-shell-supervisor-service.js";

void runMxcShellSupervisorProcess(process.argv.slice(2)).then(() => process.exit(0), () => process.exit(1));
