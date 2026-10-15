import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The repository's CHANGELOG.md, read once at build time and parsed into the
 * few shapes it uses: release headings (`## v0.14.0 — 2026-10-14`), section
 * headings (`###`), paragraphs, bullet lists nested by two-space indents,
 * quotes, fenced code and horizontal rules. Inline text keeps `code`,
 * **strong** and *emphasis*.
 *
 * Anything else is a contract break between the file and this page, so it
 * throws and fails the build instead of rendering wrong.
 */

export type Inline = { t: "text"; v: string } | { t: "code"; v: string } | { t: "strong"; c: Inline[] } | { t: "em"; c: Inline[] };

export type ChangeBlock =
  | { kind: "h3"; text: Inline[] }
  | { kind: "p"; text: Inline[] }
  | { kind: "quote"; text: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "list"; items: ListItem[] };

export interface ListItem {
  text: Inline[];
  children: ListItem[];
}

export interface Release {
  /** Anchor id, e.g. "v0-14-0". */
  id: string;
  /** The heading before the dash, e.g. "v0.14.0". */
  name: string;
  /** The heading after the dash, e.g. "2026-10-14". */
  date: string;
  blocks: ChangeBlock[];
}

const FILE = resolve(process.cwd(), "..", "CHANGELOG.md");

type Tok = { k: "text" | "code"; v: string } | { k: "mark"; v: "**" | "*" };

function tokens(source: string): Tok[] {
  const out: Tok[] = [];
  source.split(/(`[^`]+`)/u).forEach((part, n) => {
    if (n % 2 === 1) {
      out.push({ k: "code", v: part.slice(1, -1) });
      return;
    }
    for (const piece of part.split(/(\*\*|\*)/u)) {
      if (piece === "**" || piece === "*") out.push({ k: "mark", v: piece });
      else if (piece) out.push({ k: "text", v: piece });
    }
  });
  return out;
}

/** Parses from `i` until the `closer` mark; `closed` says whether it was found. */
function run(toks: Tok[], i: number, closer: string | null): { out: Inline[]; next: number; closed: boolean } {
  const out: Inline[] = [];
  const text = (v: string) => {
    const last = out.at(-1);
    if (last && last.t === "text") last.v += v;
    else out.push({ t: "text", v });
  };
  while (i < toks.length) {
    const tok = toks[i]!;
    if (tok.k === "mark" && tok.v === closer) return { out, next: i + 1, closed: true };
    if (tok.k === "code") out.push({ t: "code", v: tok.v });
    else if (tok.k === "text") text(tok.v);
    else {
      const inner = run(toks, i + 1, tok.v);
      if (inner.closed && inner.out.length) {
        out.push(tok.v === "**" ? { t: "strong", c: inner.out } : { t: "em", c: inner.out });
        i = inner.next;
        continue;
      }
      text(tok.v);
    }
    i++;
  }
  return { out, next: i, closed: false };
}

function inline(source: string): Inline[] {
  return run(tokens(source), 0, null).out;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

function parseChangelog(source: string): Release[] {
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  const releases: Release[] = [];
  let release: Release | null = null;
  let i = 0;

  const fail = (why: string): never => {
    throw new Error(`CHANGELOG.md line ${i + 1}: ${why}`);
  };
  const push = (b: ChangeBlock) => {
    if (!release) fail("content before the first release heading");
    release!.blocks.push(b);
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim() === "---") {
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      if (releases.length || release) fail("a second top-level heading");
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      const head = line.slice(3).trim();
      const dash = head.indexOf(" — ");
      if (dash < 0) fail(`release heading without " — ": ${head}`);
      const name = head.slice(0, dash).trim();
      release = { id: slug(name), name, date: head.slice(dash + 3).trim(), blocks: [] };
      if (releases.some((r) => r.id === release!.id)) fail(`duplicate release anchor ${release.id}`);
      releases.push(release);
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      push({ kind: "h3", text: inline(line.slice(4).trim()) });
      i++;
      continue;
    }
    if (line.startsWith("#")) fail(`unsupported heading: ${line}`);
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      if (i >= lines.length) fail("unclosed code fence");
      i++;
      push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (line.startsWith(">")) {
      const parts: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) parts.push(lines[i++]!.replace(/^>\s?/u, ""));
      push({ kind: "quote", text: inline(parts.join(" ").trim()) });
      continue;
    }
    if (/^- /u.test(line)) {
      // A list runs until a blank line followed by something that is not a bullet or its continuation.
      const flat: { depth: number; text: string }[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const bullet = /^( *)- (.*)$/u.exec(l);
        if (bullet) {
          const indent = bullet[1]!.length;
          if (indent % 2 !== 0) fail("bullet indent is not a multiple of two spaces");
          flat.push({ depth: indent / 2, text: bullet[2]! });
          i++;
          continue;
        }
        if (l.trim() === "") {
          const nextLine = lines.slice(i + 1).find((x) => x.trim() !== "");
          if (nextLine !== undefined && /^ *- /u.test(nextLine)) {
            i++;
            continue;
          }
          break;
        }
        if (/^ +\S/u.test(l) && flat.length) {
          flat[flat.length - 1]!.text += ` ${l.trim()}`;
          i++;
          continue;
        }
        break;
      }
      const root: ListItem[] = [];
      const stack: ListItem[][] = [root];
      for (const { depth, text } of flat) {
        if (depth > stack.length) fail("bullet nested more than one level deeper than its parent");
        if (depth === stack.length) {
          const parent = stack[depth - 1]!.at(-1);
          if (!parent) fail("nested bullet without a parent");
          stack.push(parent!.children);
        }
        stack.length = depth + 1;
        stack[depth]!.push({ text: inline(text), children: [] });
      }
      push({ kind: "list", items: root });
      continue;
    }
    if (/^ +- /u.test(line)) fail("indented bullet outside a list");
    const parts: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#|>|```|- |---)/u.test(lines[i]!)) parts.push(lines[i++]!.trim());
    push({ kind: "p", text: inline(parts.join(" ")) });
  }
  if (!releases.length) throw new Error("CHANGELOG.md has no release headings");
  return releases;
}

/**
 * Ave's first release. The file goes on with the predecessor app's history,
 * which this site does not publish.
 */
const FIRST_RELEASE = "v0.14.0";

let cached: Release[] | null = null;

/** Ave's releases, newest first, as the file lists them: from the top down to FIRST_RELEASE. */
export function releases(): Release[] {
  if (!cached) {
    const all = parseChangelog(readFileSync(FILE, "utf8"));
    const first = all.findIndex((r) => r.name === FIRST_RELEASE);
    if (first < 0) throw new Error(`CHANGELOG.md has no ${FIRST_RELEASE} release`);
    cached = all.slice(0, first + 1);
  }
  return cached;
}
