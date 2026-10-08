import { isAbsolute, join } from "node:path";
import { withoutGitContext } from "../../../scripts/lib/git-process-environment.mjs";

export function gitFixtureEnv(home, source = process.env) {
  if (!isAbsolute(home)) throw new Error("Git fixture home must be absolute");
  return {
    ...withoutGitContext(source),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig-fixture"),
  };
}
