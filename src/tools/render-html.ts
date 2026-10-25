



import { createDynamicTool, type Tool } from "./base.js";
import { t } from "../i18n/index.js";

export const MAX_HTML_BYTES = 200_000;
export const DEFAULT_HEIGHT = 400;
export const MAX_HEIGHT = 1200;
export const MIN_HEIGHT = 80;

const CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="` +
  `default-src 'none'; ` +
  `script-src 'unsafe-inline' 'unsafe-eval'; ` +
  `style-src 'unsafe-inline' data:; ` +
  `img-src data:; ` +
  `font-src data:; ` +
  `base-uri 'none'; ` +
  `form-action 'none'; ` +
  `frame-ancestors 'none'` +
  `">`;

export interface RenderHtmlResult {
  kind: "ave.render_html";
  title?: string;
  height: number;
  html: string;
  warnings: string[];
}

export function createRenderHtmlTool(): Tool {
  return createDynamicTool({
    name: "render_html",
    description: t("be_renderHtml.toolDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["html"],
      properties: {
        html: {
          type: "string",
          description: t("be_renderHtml.propHtmlDescription"),
        },
        title: {
          type: "string",
          description: t("be_renderHtml.propTitleDescription"),
        },
        height: {
          type: "integer",
          description: t("be_renderHtml.propHeightDescription", { default: DEFAULT_HEIGHT, min: MIN_HEIGHT, max: MAX_HEIGHT }),
        },
      },
    },
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      const rawHtml = typeof args.html === "string" ? args.html : "";
      if (!rawHtml.trim()) {
        return {
          output: JSON.stringify({ error: "html is required" }),
          isError: true,
        };
      }
      if (Buffer.byteLength(rawHtml, "utf8") > MAX_HTML_BYTES) {
        return {
          output: JSON.stringify({
            error: `html too large (>${MAX_HTML_BYTES} bytes)`,
          }),
          isError: true,
        };
      }

      const rawTitle = typeof args.title === "string" ? args.title.trim() : "";
      const title = rawTitle ? rawTitle.slice(0, 60) : undefined;

      const rawHeight = Number(args.height);
      const height = Number.isFinite(rawHeight)
        ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.floor(rawHeight)))
        : DEFAULT_HEIGHT;

      const { sanitized, warnings } = sanitizeHtml(rawHtml);
      const wrapped = wrapWithCsp(sanitized, title);

      const result: RenderHtmlResult = {
        kind: "ave.render_html",
        title,
        height,
        html: wrapped,
        warnings,
      };
      return { output: JSON.stringify(result), isError: false };
    },
  });
}

export interface SanitizeResult {
  sanitized: string;
  warnings: string[];
}

// Webview isolation, navigation guards, and CSP are primary; strip nested contexts, refresh, external script sources, and external links.
// Inline scripts, handlers, and javascript URLs stay inside the webview; removed links also prevent prefetch.
export function sanitizeHtml(html: string): SanitizeResult {
  const warnings: string[] = [];
  let out = html;

  const tagBlocks: Array<[RegExp, string]> = [
    [/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "iframe"],
    [/<iframe\b[^>]*\/?>/gi, "iframe"],
    [/<object\b[\s\S]*?<\/object\s*>/gi, "object"],
    [/<embed\b[^>]*\/?>/gi, "embed"],
    [/<frame\b[^>]*\/?>/gi, "frame"],
    [/<frameset\b[\s\S]*?<\/frameset\s*>/gi, "frameset"],
  ];
  for (const [pattern, label] of tagBlocks) {
    if (pattern.test(out)) {
      warnings.push(`removed <${label}>`);
      out = out.replace(pattern, "");
    }
  }

  if (/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(out)) {
    warnings.push("removed <meta refresh>");
    out = out.replace(
      /<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi,
      "",
    );
  }

  // Remove external src while retaining inline script bodies.
  const scriptSrcRe =
    /(<script\b[^>]*?)\ssrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)([^>]*>)/gi;
  if (scriptSrcRe.test(out)) {
    warnings.push("removed <script src>");
    out = out.replace(scriptSrcRe, "$1$2");
  }

  // Keep only fragment hrefs; relative links can also navigate or fetch unexpectedly from blank/data bases.
  let hrefStripped = false;
  out = out.replace(
    /(<a\b[^>]*?)\s+href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)([^>]*>)/gi,
    (match, before: string, value: string, after: string) => {
      const unquoted = value.replace(/^["']|["']$/g, "");
      if (unquoted.startsWith("#")) return match;
      hrefStripped = true;
      return `${before}${after}`;
    },
  );
  if (hrefStripped) warnings.push("removed <a href>");

  return { sanitized: out, warnings };
}

export function wrapWithCsp(body: string, title?: string): string {
  const safeTitle = (title ?? "Ave render").replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
  );
  return (
    "<!doctype html><html><head>" +
    CSP_META +
    '<meta charset="utf-8">' +
    `<title>${safeTitle}</title>` +
    // Keep font-family aligned with src/shared/host-font-stack.ts.
    '<style>html,body{margin:0;padding:8px;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif;color:#e5e7eb;background:transparent;}</style>' +
    "</head><body>" +
    body +
    "</body></html>"
  );
}
