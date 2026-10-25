import type { PowerShellValueArgument } from "../../tools/powershell-ast.js";

export function powerShellLiteral(value: string, text = value): PowerShellValueArgument {
  return { kind: "literal", value, text };
}
