import "./main/bare-program-lookup.js";
import { configureHeadlessRuntimeIdentity } from "./main/headless-runtime-identity.js";
import { projectRoot } from "./main/main-paths.js";

configureHeadlessRuntimeIdentity(projectRoot);
const { runHeadlessHost } = await import("./headless-host.js");
runHeadlessHost();
