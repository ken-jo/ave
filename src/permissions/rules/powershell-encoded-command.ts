// The scripts a shell input hands to PowerShell as `-EncodedCommand` (UTF-16LE base64). The text is otherwise opaque, so the host decodes it to run
// the destructive and credential floors on what will actually execute, to refuse an allow rule for it, and to show the person the decoded command.
// Decoding fails closed: an encoded-command argument whose payload the host cannot fully decode (missing, not base64, not text, past the payload
// limit), quoting it cannot balance, or a parameter boundary it cannot place, is `hidden` code, which the permission manager treats as a destructive
// floor (a forced modal, never an allow rule).

// `-EncodedCommand` and every prefix PowerShell accepts for it (`-e`, `-ec`, `-enc`, ...), behind any dash PowerShell's parser accepts as a parameter
// prefix (hyphen-minus, en dash, em dash, horizontal bar) or `/`, with an optional `:value`.
const ENCODED_PARAMETER_RE = /^[-\u2013\u2014\u2015/](?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?::([\s\S]*))?$/i;
// `-Command` / `-c`, `-CommandWithArgs` / `-cwa` and `-File` / `-f`, behind the same dashes: after one, the rest is the script or its arguments.
const SCRIPT_PARAMETER_RE = /^[-\u2013\u2014\u2015/](?:c|command|cwa|commandwithargs|f|file)(?::[\s\S]*)?$/i;
const POWERSHELL_NAME_RE = /^(?:pwsh|powershell)(?:\.exe)?$/i;
const MENTIONS_POWERSHELL_RE = /pwsh|powershell/i;

const MAX_PAYLOADS = 8;
const MAX_DEPTH = 4;

export interface EncodedPowerShell {
  /** The decoded scripts, in order. */
  readonly scripts: string[];
  /** Encoded code the host could not fully read: an undecodable payload, unbalanced quoting, or an ambiguous parameter boundary. */
  readonly hidden: boolean;
}

/** Words of each command in `text`, quotes honored: `;`, `&`, `|`, a newline and brackets split commands only outside quotes, so a quoted value
 *  keeps its separators and line breaks. A word's value has its quotes removed. Null when a quote is never closed. */
function commandWords(text: string): string[][] | null {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else word = (word ?? "") + char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      word = word ?? "";
    } else if (/[;&|\n(){}]/.test(char)) {
      endCommand();
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word = (word ?? "") + char;
    }
  }
  if (quote !== null) return null;
  endCommand();
  return commands;
}

function decodePayload(raw: string): string | null {
  // .NET's FromBase64String ignores whitespace, line breaks included; so does this.
  const encoded = raw.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length % 2 !== 0) return null;
  const text = bytes.toString("utf16le").replace(/^\uFEFF/, "");
  // Anything but printable text and ordinary whitespace is not a script the card could show.
  return /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]*$/.test(text) ? text : null;
}

function isPowerShellHead(word: string): boolean {
  const base = word.slice(Math.max(word.lastIndexOf("\\"), word.lastIndexOf("/")) + 1).replace(/\.+$/, "");
  return POWERSHELL_NAME_RE.test(base);
}

function inspect(text: string, depth: number, scripts: string[]): boolean {
  if (!MENTIONS_POWERSHELL_RE.test(text)) return false;
  if (depth > MAX_DEPTH) return true;
  const commands = commandWords(text);
  if (commands === null) return true;
  let hidden = false;
  for (const words of commands) {
    // A quoted word can carry a whole nested command line (`cmd /c "pwsh -enc ..."`, `-ArgumentList '-enc ...'`); it is read the same way.
    for (const word of words) {
      if (word.length > 0 && /\s/.test(word) && inspect(word, depth + 1, scripts)) hidden = true;
    }
    for (let head = 0; head < words.length; head += 1) {
      if (!isPowerShellHead(words[head]!)) continue;
      let scriptStarted = false;
      for (let index = head + 1; index < words.length; index += 1) {
        const word = words[index]!;
        const encoded = ENCODED_PARAMETER_RE.exec(word);
        if (encoded !== null) {
          // After -Command/-File an encoded-looking word is either the script's own argument or a parameter the host misplaced: it cannot tell, so
          // the code is hidden (`pwsh -WorkingDirectory -c -enc ...`).
          if (scriptStarted) {
            hidden = true;
            continue;
          }
          const payload = encoded[1] ?? words[index + 1];
          if (encoded[1] === undefined) index += 1;
          const script = payload === undefined || scripts.length >= MAX_PAYLOADS ? null : decodePayload(payload);
          if (script === null) hidden = true;
          else scripts.push(script);
          continue;
        }
        if (SCRIPT_PARAMETER_RE.test(word)) scriptStarted = true;
      }
    }
  }
  return hidden;
}

export function inspectEncodedPowerShell(command: string): EncodedPowerShell {
  const scripts: string[] = [];
  const hidden = inspect(command, 0, scripts);
  return { scripts, hidden };
}
