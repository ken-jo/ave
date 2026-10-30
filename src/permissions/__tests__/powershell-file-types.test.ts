import { expect, it } from "vitest";
import { POWERSHELL_FILE_TYPES } from "../rules/powershell-file-types.js";
import { POWERSHELL_COMMAND_POLICIES } from "../rules/powershell-command-policy.js";
import { runnerName } from "../rules/shell-prefix-values.js";

it("registers extensions without treating extensionless native commands as a suffix", () => {
  expect(POWERSHELL_COMMAND_POLICIES.xcopy?.native).toBe("opaque");
  expect(POWERSHELL_COMMAND_POLICIES.robocopy?.native).toBe("opaque");
  expect(Object.hasOwn(POWERSHELL_FILE_TYPES, "")).toBe(false);
  expect(POWERSHELL_FILE_TYPES[".exe"]).toBe("opaque");
  expect(POWERSHELL_FILE_TYPES[".ps1"]).toBe("script");
});

it.each(["npx", "bunx", "pnpx", "uvx", "corepack", "npm", "pnpm", "yarn", "pipx"])
  ("retains the complete extensionless runner identity %s", name => {
    expect(runnerName(name)).toBe(name);
    expect(runnerName(`./node_modules/.bin/${name}`)).toBe(name);
    expect(runnerName(`${name}@1.2.3`)).toBe(name);
  });

it.each(["npx.exe", "bunx.cmd", "pnpm.ps1", "corepack.js"])
  ("removes only the actual recognized runner shim suffix from %s", name => {
    expect(runnerName(name)).toBe(name.slice(0, name.lastIndexOf(".")));
  });
