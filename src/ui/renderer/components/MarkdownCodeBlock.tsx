/** Copy raw fenced source from the markdown AST so rendered UI and trailing newlines do not enter the clipboard. */
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type { ExtraProps } from "react-markdown";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { useCopyFlash } from "../hooks/use-copy-flash.js";
import { useHighlightedCode } from "../hooks/use-highlighted-code.js";

interface HastLike {
  type?: string;
  value?: unknown;
  tagName?: string;
  properties?: { className?: unknown };
  children?: readonly HastLike[];
}

/** Concatenated text of a hast subtree. */
function hastText(node: HastLike | undefined): string {
  if (!node) return "";
  if (node.type === "text" && typeof node.value === "string") return node.value;
  return (node.children ?? []).map((child) => hastText(child)).join("");
}

/** The `<code>` child's class list, kept on the highlighted `<code>` too. */
function codeClassName(pre: HastLike | undefined): string | undefined {
  const code = pre?.children?.find((child) => child.type === "element" && child.tagName === "code");
  const raw = code?.properties?.className;
  if (Array.isArray(raw)) return raw.filter((c) => typeof c === "string").join(" ");
  return typeof raw === "string" ? raw : undefined;
}

/** Highlighter hast → React. lowlight emits only `span` elements carrying `hljs-*` classes and text nodes; anything else is
 * rendered as its text, so no tag or attribute from the tree can reach the DOM beyond a class name. */
function renderHighlighted(nodes: readonly HastLike[] | undefined, keyPrefix = "h"): ReactNode[] {
  return (nodes ?? []).map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    if (node.type === "text") return typeof node.value === "string" ? node.value : "";
    if (node.type === "element") {
      const raw = node.properties?.className;
      const className = Array.isArray(raw)
        ? raw.filter((c): c is string => typeof c === "string" && c.startsWith("hljs-")).join(" ")
        : undefined;
      return (
        <span key={key} className={className || undefined}>
          {renderHighlighted(node.children, key)}
        </span>
      );
    }
    return hastText(node);
  });
}

/** `language-ts` → `ts`; `undefined` when the fence named no language. */
function fenceLanguage(pre: HastLike | undefined): string | undefined {
  const code = pre?.children?.find((child) => child.type === "element" && child.tagName === "code");
  const raw = code?.properties?.className;
  const classes = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\s+/) : [];
  for (const cls of classes) {
    if (typeof cls === "string" && cls.startsWith("language-")) {
      const lang = cls.slice("language-".length).trim();
      if (lang) return lang;
    }
  }
  return undefined;
}

export function MarkdownCodeBlock({ node, children, ...rest }: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const { t } = useTranslation();
  const { copied, copy } = useCopyFlash();
  const hast = node as unknown as HastLike | undefined;
  const language = fenceLanguage(hast);
  const source = hastText(hast).replace(/\n$/, "");
  const label = copied ? t("assistantCard.codeCopied") : t("assistantCard.codeCopy");
  const highlighted = useHighlightedCode(language, source);

  return (
    <div className="group/code relative my-3 min-w-0 max-w-full" data-testid="markdown-code-block">
      <div className="flex items-center justify-between gap-2 rounded-t-md border border-b-0 border-border/(--opacity-medium) bg-muted/(--opacity-muted) px-2 py-0.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate font-mono" data-testid="markdown-code-language">
          {language ?? t("assistantCard.codePlainText")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          aria-label={label}
          title={label}
          data-testid="markdown-code-copy"
          onClick={() => copy(source)}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          <span>{label}</span>
        </Button>
      </div>
      {/* Same <pre>/<code> box before and after highlighting: the spans only
          recolour, so the block does not shift when a grammar arrives. */}
      <pre
        {...rest}
        className={`${rest.className ?? ""} mt-0! mb-0! rounded-t-none`}
        data-highlighted={highlighted ? "true" : undefined}
      >
        {highlighted ? (
          <code className={codeClassName(hast)}>
            {renderHighlighted(highlighted.children as readonly HastLike[])}
            {"\n"}
          </code>
        ) : children}
      </pre>
    </div>
  );
}
