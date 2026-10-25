// The scripts a shell input hands to PowerShell as `-EncodedCommand` (UTF-16LE base64). The text is otherwise opaque, so the host decodes it to run
// the destructive and credential floors on what will actually execute, to refuse an allow rule for it, and to show the person the decoded command.
// Decoding fails closed: an encoded-command argument whose payload the host cannot fully decode (missing, split oddly, not base64, not text, or
// past the payload limit) is `hidden` code, which the permission manager treats as a destructive floor (a forced modal, never an allow rule).

// `pwsh` / `powershell`, optionally pathed, with `.exe`, as a command word.
const POWERSHELL_HEAD_RE = /(?:^|[\s;&|(){}'"`])(?:[^\s;&|(){}'"`]*[\\/])?(?:pwsh|powershell)(?:\.exe)?(?=[\s'"`]|$)/gi;

// `-EncodedCommand` and every prefix PowerShell accepts for it (`-e`, `-ec`, `-enc`, …), behind any dash PowerShell's parser accepts as a parameter
// prefix (hyphen-minus, en dash, em dash, horizontal bar) or `/`, then its payload: double-quoted, single-quoted (base64 ignores the whitespace inside,
// as .NET's FromBase64String does) or one bare word.
const ENCODED_PARAMETER_RE = /(?:^|\s)[-\u2013\u2014\u2015/](?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?=[:\s"']|$):?\s*(?:"([^"]*)"?|'([^']*)'?|([^\s;&|]+))?/gi;

// `-Command` / `-c`, `-CommandWithArgs` / `-cwa` and `-File` / `-f`, behind the same dashes.
const SCRIPT_PARAMETER_RE = /(?:^|\s)[-\u2013\u2014\u2015/](?:c|command|cwa|commandwithargs|f|file)(?=[:\s"']|$)/i;

const MAX_PAYLOADS = 8;

export interface EncodedPowerShell {
  /** The decoded scripts, in order. */
  readonly scripts: string[];
  /** An encoded-command argument whose payload could not be fully decoded: the code it runs is hidden from every check. */
  readonly hidden: boolean;
}

function decodePayload(raw: string): string | null {
  const encoded = raw.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length % 2 !== 0) return null;
  const text = bytes.toString("utf16le").replace(/^\uFEFF/, "");
  // Anything but printable text and ordinary whitespace is not a script the card could show.
  return /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]*$/.test(text) ? text : null;
}

export function inspectEncodedPowerShell(command: string): EncodedPowerShell {
  const scripts: string[] = [];
  let hidden = false;
  for (const head of command.matchAll(POWERSHELL_HEAD_RE)) {
    // The arguments of this invocation: up to the next command separator.
    const start = head.index + head[0].length;
    const segment = command.slice(start).split(/[;&|\n]/, 1)[0] ?? "";
    // After `-Command` or `-File` the rest is the script or its arguments, not this invocation's parameters (a nested pwsh is its own head match).
    const scriptStart = SCRIPT_PARAMETER_RE.exec(segment);
    const rest = scriptStart === null ? segment : segment.slice(0, scriptStart.index);
    for (const parameter of rest.matchAll(ENCODED_PARAMETER_RE)) {
      const payload = parameter[1] ?? parameter[2] ?? parameter[3];
      const script = payload === undefined || scripts.length >= MAX_PAYLOADS ? null : decodePayload(payload);
      if (script === null) hidden = true;
      else scripts.push(script);
    }
  }
  return { scripts, hidden };
}
