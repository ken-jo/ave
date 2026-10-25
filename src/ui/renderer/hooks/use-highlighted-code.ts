/** Load highlighter and grammars lazily; plain-text fallback retains layout metrics and highlighting emits a syntax tree,
 * never HTML. */
import { useEffect, useMemo, useState } from "react";
import type { LanguageFn, createLowlight } from "lowlight";

/** Fences longer than this render as plain text. */
const MAX_HIGHLIGHT_CHARS = 100_000;

type Lowlight = ReturnType<typeof createLowlight>;
type GrammarModule = { default: LanguageFn };

/** Grammars offered, one lazy chunk each. An explicit table rather than a template-literal import: a template import makes
 * webpack emit a context with every one of highlight.js's ~190 grammars. */
const GRAMMARS: Record<string, () => Promise<GrammarModule>> = {
  bash: () => import(/* webpackChunkName: "hljs-bash" */ "highlight.js/lib/languages/bash"),
  c: () => import(/* webpackChunkName: "hljs-c" */ "highlight.js/lib/languages/c"),
  cpp: () => import(/* webpackChunkName: "hljs-cpp" */ "highlight.js/lib/languages/cpp"),
  csharp: () => import(/* webpackChunkName: "hljs-csharp" */ "highlight.js/lib/languages/csharp"),
  css: () => import(/* webpackChunkName: "hljs-css" */ "highlight.js/lib/languages/css"),
  diff: () => import(/* webpackChunkName: "hljs-diff" */ "highlight.js/lib/languages/diff"),
  dockerfile: () => import(/* webpackChunkName: "hljs-dockerfile" */ "highlight.js/lib/languages/dockerfile"),
  go: () => import(/* webpackChunkName: "hljs-go" */ "highlight.js/lib/languages/go"),
  ini: () => import(/* webpackChunkName: "hljs-ini" */ "highlight.js/lib/languages/ini"),
  java: () => import(/* webpackChunkName: "hljs-java" */ "highlight.js/lib/languages/java"),
  javascript: () => import(/* webpackChunkName: "hljs-javascript" */ "highlight.js/lib/languages/javascript"),
  json: () => import(/* webpackChunkName: "hljs-json" */ "highlight.js/lib/languages/json"),
  kotlin: () => import(/* webpackChunkName: "hljs-kotlin" */ "highlight.js/lib/languages/kotlin"),
  markdown: () => import(/* webpackChunkName: "hljs-markdown" */ "highlight.js/lib/languages/markdown"),
  php: () => import(/* webpackChunkName: "hljs-php" */ "highlight.js/lib/languages/php"),
  python: () => import(/* webpackChunkName: "hljs-python" */ "highlight.js/lib/languages/python"),
  ruby: () => import(/* webpackChunkName: "hljs-ruby" */ "highlight.js/lib/languages/ruby"),
  rust: () => import(/* webpackChunkName: "hljs-rust" */ "highlight.js/lib/languages/rust"),
  scss: () => import(/* webpackChunkName: "hljs-scss" */ "highlight.js/lib/languages/scss"),
  sql: () => import(/* webpackChunkName: "hljs-sql" */ "highlight.js/lib/languages/sql"),
  swift: () => import(/* webpackChunkName: "hljs-swift" */ "highlight.js/lib/languages/swift"),
  typescript: () => import(/* webpackChunkName: "hljs-typescript" */ "highlight.js/lib/languages/typescript"),
  xml: () => import(/* webpackChunkName: "hljs-xml" */ "highlight.js/lib/languages/xml"),
  yaml: () => import(/* webpackChunkName: "hljs-yaml" */ "highlight.js/lib/languages/yaml"),
};

/** Fence spellings → grammar name. */
const ALIASES: Record<string, string> = {
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  h: "c",
  "c++": "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp", "c#": "csharp",
  patch: "diff",
  docker: "dockerfile",
  golang: "go",
  toml: "ini",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  jsonc: "json", json5: "json",
  kt: "kotlin", kts: "kotlin",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  html: "xml", svg: "xml", xhtml: "xml",
  yml: "yaml",
};

/** The grammar a fence language resolves to, or null when none is offered. */
function resolveGrammar(language: string | undefined): string | null {
  if (!language) return null;
  const key = language.toLowerCase();
  const name = ALIASES[key] ?? key;
  return Object.prototype.hasOwnProperty.call(GRAMMARS, name) ? name : null;
}

let lowlight: Lowlight | null = null;
let lowlightLoad: Promise<Lowlight> | null = null;
const grammarLoads = new Map<string, Promise<void>>();

function loadLowlight(): Promise<Lowlight> {
  lowlightLoad ??= import(
    /* webpackChunkName: "highlight" */
    "lowlight"
  ).then((mod) => {
    lowlight = mod.createLowlight();
    return lowlight;
  });
  return lowlightLoad;
}

function loadGrammar(name: string): Promise<void> {
  let pending = grammarLoads.get(name);
  if (!pending) {
    pending = Promise.all([loadLowlight(), GRAMMARS[name]!()]).then(([ll, mod]) => {
      ll.register(name, mod.default);
    });
    grammarLoads.set(name, pending);
  }
  return pending;
}

function isReady(name: string | null): boolean {
  return name !== null && lowlight !== null && lowlight.registered(name);
}

/** hast root of the highlighted code, or null while loading / when unsupported. */
export type HighlightedTree = ReturnType<Lowlight["highlight"]>;

export function useHighlightedCode(language: string | undefined, code: string): HighlightedTree | null {
  const name = resolveGrammar(language);
  const [ready, setReady] = useState(() => isReady(name));

  useEffect(() => {
    if (name === null) {
      setReady(false);
      return;
    }
    if (isReady(name)) {
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    loadGrammar(name).then(
      () => { if (!cancelled) setReady(true); },
      // A grammar chunk that fails to load leaves the block as plain text, which is exactly what it was before highlighting
      // existed.
      () => { if (!cancelled) grammarLoads.delete(name); },
    );
    return () => { cancelled = true; };
  }, [name]);

  // Synchronous once loaded, so streaming text never shows a stale tree.
  return useMemo(() => {
    if (!ready || name === null || lowlight === null) return null;
    // Each streamed token re-highlights the whole fence; past this size that is visible jank for little gain, so the block
    // stays plain text.
    if (code.length > MAX_HIGHLIGHT_CHARS) return null;
    try {
      return lowlight.highlight(name, code);
    } catch {
      return null;
    }
  }, [ready, name, code]);
}
