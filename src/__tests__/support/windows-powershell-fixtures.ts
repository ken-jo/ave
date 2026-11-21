import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function installIncompatibleSecurityModule(root: string): void {
  const moduleDirectory = join(root, "Microsoft.PowerShell.Security");
  mkdirSync(moduleDirectory);
  writeFileSync(join(moduleDirectory, "Microsoft.PowerShell.Security.psd1"), [
    "@{",
    "ModuleVersion = '1.0.0'",
    "RootModule = 'incompatible.psm1'",
    "FunctionsToExport = @('Get-Acl')",
    "}",
  ].join("\n"));
  writeFileSync(join(moduleDirectory, "incompatible.psm1"), "throw 'Incompatible security module fixture'\n");
}
