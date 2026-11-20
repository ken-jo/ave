interface Quote {
  index: number;
  start: number;
}

function nextQuote(text: string, cursor: number, limit: number, width: number): Quote | undefined {
  const quoteEscaping = width / 2 - 1;
  for (let index = text.indexOf('"', cursor); index >= 0 && index < limit; index = text.indexOf('"', index + 1)) {
    let start = index;
    while (start > cursor && text.charCodeAt(start - 1) === 92) start--;
    if ((index - start) % width === quoteEscaping) return { index, start: index - quoteEscaping };
  }
  return undefined;
}

const JSON_ESCAPE_TAIL = /^(?:[/bfnrt]|u[0-9a-fA-F]{4})/u;

function hasJsonStringSyntax(text: string, start: number, end: number, width: number): boolean {
  for (let index = start; index < end;) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 34) return false;
    if (code !== 92) {
      index++;
      continue;
    }
    let next = index + 1;
    while (next < end && text.charCodeAt(next) === 92) next++;
    const residue = (next - index) % width;
    if (residue === 0) {
      index = next;
      continue;
    }
    const following = text.charCodeAt(next);
    if (residue === width - 1 && following === 34) {
      index = next + 1;
      continue;
    }
    const tail = text.slice(next, Math.min(end, next + 5));
    if (residue !== width / 2 || !JSON_ESCAPE_TAIL.test(tail)) return false;
    index = next + (following === 117 ? 5 : 1);
  }
  return true;
}

function containsJsonEnvelope(text: string, start: number, end: number, width: number): boolean {
  while (start < end && /[\t\n\r ]/u.test(text.charAt(start))) start++;
  while (end > start && /[\t\n\r ]/u.test(text.charAt(end - 1))) end--;
  const first = text.charCodeAt(start);
  const last = text.charCodeAt(end - 1);
  if (first === 123) {
    if (last !== 125) return false;
    let key = start + 1;
    while (key < end && /[\t\n\r ]/u.test(text.charAt(key))) key++;
    return text.charCodeAt(key) === 125 || nextQuote(text, key, Math.min(end, key + width), width * 2)?.start === key;
  }
  if (first === 91) return last === 93;
  return last === 34 && nextQuote(text, start, Math.min(end, start + width), width * 2)?.start === start;
}

/** Find the enclosing string on original text. A quote inside prose keeps that string's width. */
export function rewriteWindowsPathText(text: string, rewrite: (part: string, separatorWidth: number) => string): string {
  if (!text.includes('"')) return rewrite(text, 1);
  const pieces: string[] = [];
  const visit = (start: number, end: number, width: number): void => {
    let copied = start;
    let open = nextQuote(text, start, end, width);
    while (open) {
      const close = nextQuote(text, open.index + 1, end, width);
      if (!close) break;
      const contentStart = open.index + 1;
      if (hasJsonStringSyntax(text, contentStart, close.start, width)) {
        pieces.push(rewrite(text.slice(copied, open.start), width / 2), text.slice(open.start, contentStart));
        if (containsJsonEnvelope(text, contentStart, close.start, width)) {
          visit(contentStart, close.start, width * 2);
        } else {
          pieces.push(rewrite(text.slice(contentStart, close.start), width));
        }
        pieces.push(text.slice(close.start, close.index + 1));
        copied = close.index + 1;
        open = nextQuote(text, copied, end, width);
      } else {
        open = close;
      }
    }
    pieces.push(rewrite(text.slice(copied, end), width / 2));
  };
  visit(0, text.length, 2);
  return pieces.join("");
}
