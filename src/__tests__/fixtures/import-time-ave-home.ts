/**
 * A module that resolves the Ave home when it loads, as store modules once
 * did for their default paths. `ave-home-isolation.test.ts` loads it to show
 * that such a capture is still this test file's home, or refused.
 */
import { aveHome } from "../../shared/ave-home.js";

export const AVE_HOME_AT_IMPORT = aveHome();
