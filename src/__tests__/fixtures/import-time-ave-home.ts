/** Resolve the home at import time to exercise isolation of module-level captures. */
import { aveHome } from "../../shared/ave-home.js";

export const AVE_HOME_AT_IMPORT = aveHome();
