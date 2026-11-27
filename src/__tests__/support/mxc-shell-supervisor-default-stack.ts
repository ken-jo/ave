// Regression entry for the native suite only: the real supervisor without its asynchronous call stack setting.
import "../../main/bare-program-lookup.js";
import { runMxcShellSupervisorProcess } from "../../permissions/mxc-shell-supervisor-service.js";

void runMxcShellSupervisorProcess(process.argv.slice(2), null).then(() => process.exit(0), () => process.exit(1));
