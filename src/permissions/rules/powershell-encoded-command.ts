// The scripts a shell input hands to PowerShell as `-EncodedCommand` (UTF-16LE base64). The text is otherwise opaque, so the host decodes it to run
// the destructive and credential floors on what will actually execute, to refuse an allow rule for it, and to show the person the decoded command.
// Decoding only ever adds scrutiny: a payload that is not valid base64 or UTF-16LE text is left opaque and never decides anything by itself.

// `-EncodedCommand` and every prefix PowerShell accepts for it (`-e`, `-ec`, `-enc`, …), for `pwsh` and `powershell`, optionally pathed, with `.exe`.
const ENCODED_COMMAND_RE = /(?:^|[\s;&|(){}'"`])(?:[^\s;&|(){}'"`]*[\\/])?(?:pwsh|powershell)(?:\.exe)?(?=[\s'"`])[^;&|\n]*?\s[-/](e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?::|\s+)['"]?([A-Za-z0-9+/]+={0,2})/gi;

const MAX_PAYLOADS = 8;

export function encodedPowerShellPayloads(command: string): string[] {
  const payloads: string[] = [];
  for (const match of command.matchAll(ENCODED_COMMAND_RE)) {
    if (payloads.length >= MAX_PAYLOADS) break;
    const encoded = match[2]!;
    if (encoded.length % 4 !== 0) continue;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0 || bytes.length % 2 !== 0) continue;
    const text = bytes.toString("utf16le").replace(/^﻿/, "");
    // Anything but printable text and ordinary whitespace is not a script the card could show.
    if (!/^[^\u0000-\u0008\u000B\u000C\u000E-\u001F�]*$/.test(text)) continue;
    payloads.push(text);
  }
  return payloads;
}
