/**
 * Fenced code block for model-authored markdown: the block itself stays the
 * typography plugin's `<pre>` (so theme tokens and spacing are unchanged), and
 * a small header strip carries the fence language and a Copy button.
 *
 * Copy writes the block's raw source text — taken from the markdown AST, not
 * from the rendered DOM — so what lands on the clipboard is exactly what the
 * model wrote between the fences, without UI chrome or a trailing newline.
 */
import type { ComponentPropsWithoutRef } from "react";
import { Check, Copy } from "lucide-react";
import type { ExtraProps } from "react-markdown";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { useCopyFlash } from "../hooks/use-copy-flash.js";

interface HastLike {
  type?: string;
  value?: unknown;
  tagName?: string;
  properties?: { className?: unknown };
  children?: readonly HastLike[];
}

/** Concatenated text of a hast subtree. */
export function hastText(node: HastLike | undefined): string {
  if (!node) return "";
  if (node.type === "text" && typeof node.value === "string") return node.value;
  return (node.children ?? []).map((child) => hastText(child)).join("");
}

/** `language-ts` → `ts`; `undefined` when the fence named no language. */
export function fenceLanguage(pre: HastLike | undefined): string | undefined {
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
      <pre {...rest} className={`${rest.className ?? ""} !mt-0 !mb-0 rounded-t-none`}>
        {children}
      </pre>
    </div>
  );
}
