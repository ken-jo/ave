// A PowerShell single-quoted string literal.
export const quotePowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`;
