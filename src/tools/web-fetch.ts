import { createDynamicTool, type Tool } from "./base.js";
import { fetchPublicHttpResponse } from "../core/network-guard.js";
import { t } from "../i18n/index.js";
import { MAX_TOOL_RESULT_ARTIFACT_BYTES } from "../shared/tool-output-artifact.js";
import { errorMessage } from "../shared/error-message.js";
import { htmlToMarkdown } from "./html-to-markdown.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Enough of an error page to show what the server said, not the whole page. */
const HTTP_ERROR_EXCERPT_CHARS = 2_000;
/** Prefer Markdown and HTML; anything else is still accepted and routed by type. */
const WEB_FETCH_ACCEPT =
  "text/markdown;q=1.0, text/html;q=0.9, application/xhtml+xml;q=0.9, text/plain;q=0.8, application/json;q=0.7, */*;q=0.1";

/** A response the tool deliberately refuses or reports, as opposed to a transport failure. */
class WebFetchContentError extends Error {
  constructor(message: string, readonly excerpt?: string) {
    super(message);
    this.name = "WebFetchContentError";
  }
}

/** Bound transport bytes before retaining text or extracting HTML. */
async function readResponseBytes(response: Response, signal?: AbortSignal): Promise<Buffer> {
  if (!response.body) {
    signal?.throwIfAborted();
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let finished = false;
  try {
    signal?.throwIfAborted();
    const declaredBytes = Number(response.headers.get("content-length"));
    if (declaredBytes > MAX_RESPONSE_BYTES) {
      throw new Error(`Response exceeds the ${MAX_RESPONSE_BYTES}-byte body limit.`);
    }
    // A byte buffer also bounds bookkeeping for tiny or empty stream chunks.
    const buffer = Buffer.allocUnsafe(MAX_RESPONSE_BYTES);
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        finished = true;
        return Buffer.from(buffer.subarray(0, bytes));
      }
      if (value.byteLength > MAX_RESPONSE_BYTES - bytes) {
        throw new Error(`Response exceeds the ${MAX_RESPONSE_BYTES}-byte body limit.`);
      }
      buffer.set(value, bytes);
      bytes += value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

/** Discard a body the tool will not read, without waiting for it. */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

type WebFetchBodyKind = "html" | "text" | "pdf" | "binary";

/** Route by declared media type; an undeclared one is sniffed from the bytes. */
function classifyBody(mime: string, sniff: () => Buffer): WebFetchBodyKind {
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "application/pdf") return "pdf";
  if (
    mime.startsWith("text/")
    || mime === "application/json" || mime.endsWith("+json")
    || mime === "application/xml" || mime.endsWith("+xml")
    || mime === "application/javascript" || mime === "application/x-javascript"
    || mime === "application/ecmascript"
  ) {
    return "text";
  }
  if (mime !== "" && mime !== "application/octet-stream") return "binary";
  const head = sniff().subarray(0, 1024);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (head.includes(0)) return "binary";
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(head.toString("latin1")) ? "html" : "text";
}

/**
 * Decode with the declared charset. An unknown label is an external-boundary
 * condition with one deterministic answer: decode as UTF-8, as the previous
 * implementation always did.
 */
function decodeBody(bytes: Buffer, contentType: string | null): string {
  const label = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "")?.[1];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label ?? "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

function unsupportedBodyMessage(kind: "pdf" | "binary", mime: string): string {
  return kind === "pdf"
    ? t("be_tools.webFetchPdfUnsupported")
    : t("be_tools.webFetchBinaryUnsupported", { contentType: mime || "unknown" });
}

// ─── web_fetch private-network policy helpers ───────────────────────
// The `allowPrivateNetwork` input opts a fetch into private / loopback
// targets; every gate below keys off that single flag so the policy has one
// source of truth.

function webFetchRequiresPrivateNetwork(input: unknown): boolean {
  const args = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  return args.allowPrivateNetwork === true;
}

function webFetchPrivateNetworkPolicy(
  input: unknown,
): boolean | ((url: URL) => boolean) {
  const args = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  if (args.allowPrivateNetwork === true) return true;
  return false;
}

/**
 * The identity an approval of this fetch is remembered under: the DESTINATION,
 * not the URL.
 *
 * A key per URL would make "always allow" mean "allow this exact page", which
 * no one wants often enough to click; a key of the tool name alone would make
 * it mean "allow every fetch anywhere", which is the standing egress primitive
 * this tool must not have. The host it reaches is the unit a person can
 * actually decide about, and it is the unit that bounds where data can go.
 *
 * The private-network discriminant stays in the key, so authorizing an
 * internal host for a private-network fetch never silently answers for the
 * public one, or the reverse.
 */
function webFetchApprovalCacheKey(input: unknown): string | undefined {
  const args = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  if (typeof args.url !== "string") return undefined;
  try {
    const parsed = new URL(args.url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      return undefined;
    }
    const scope = webFetchRequiresPrivateNetwork(input) ? "private-network:" : "";
    return `web_fetch:host:${scope}${parsed.hostname.toLowerCase()}`;
  } catch {
    return undefined;
  }
}

function webFetchCategoryForInput(input: unknown): "network" {
  // Always `network`, whether or not the URL is private. The destination is
  // model-chosen, so a public URL is an egress channel just as much as a
  // private one, and every exclusion that rests on this category — withheld
  // from unattended lanes, not covered by an away-authority read grant, no
  // standing allow rule — must keep applying to both.
  //
  // What separates an ordinary public fetch from an exfiltrating one is the
  // REQUEST, not the destination, and the host screens for that in
  // `screenEgressRequest` (permissions/reviewer/risk-classifier.ts): a
  // screened-clean public fetch rates LOW and runs unprompted, while a
  // credential, an oversized tail, an opaque blob or userinfo in the URL still
  // escalates. Grading the destination instead put a dialog in front of
  // ordinary reading, and a dialog answered that often is answered with
  // "always".
  void webFetchRequiresPrivateNetwork(input);
  return "network";
}

/**
 * Builtin `web_fetch` tool. Fetches a public URL and returns HTML as readable
 * Markdown (links kept, resolved against the final URL) and text/JSON/XML
 * as-is; PDF and other binary bodies are refused with an explicit reason.
 *
 * `networkFetch` (the Electron network-stack fetch, injected by the boot
 * assembler) is threaded straight into the SSRF guard so the definition holds
 * no boot wiring of its own.
 */
/**
 * @param singleHopFetch a transport that returns a redirect as a Response
 * instead of following or throwing on it. The SSRF guard below validates
 * each hop itself, which it can only do if the hop comes back; `net.fetch`
 * throws on every mode that would allow that.
 */
export function createWebFetchTool(singleHopFetch: typeof fetch): Tool {
  return createDynamicTool({
    name: "web_fetch",
    description: t("be_tools.webFetchDescription"),
    source: "builtin",
    category: "network",
    categoryForInput: (input) => webFetchCategoryForInput(input),
    isReadOnly: () => true,
    arbitraryEgress: true,
    approvalCacheKey: (input) => webFetchApprovalCacheKey(input),
    jsonSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: t("be_tools.webFetchUrlDescription") },
        allowPrivateNetwork: {
          type: "boolean",
          description: t("be_tools.webFetchAllowPrivateNetworkDescription"),
        },
      },
      required: ["url"],
    },
    execute: async (rawInput, context) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      const url = args.url as string;
      const allowPrivateNetwork = webFetchPrivateNetworkPolicy(rawInput);
      try {
        context.abortSignal?.throwIfAborted();
        // SSRF guard: route through NetworkGuard so private / loopback /
        // link-local / metadata endpoints are rejected per hop (incl. redirect
        // chain) and bad schemes / embedded credentials are refused up front.
        const response = await fetchPublicHttpResponse(url, {
          allowPrivateNetworks: allowPrivateNetwork,
          fetchImpl: singleHopFetch,
          signal: context.abortSignal,
          headers: {
            "User-Agent": "Ave-Assistant/0.1.0",
            Accept: WEB_FETCH_ACCEPT,
          },
        });
        const finalUrl = response.url || url;
        const rawContentType = response.headers.get("content-type");
        const mime = rawContentType?.split(";", 1)[0].trim().toLowerCase() ?? "";
        const declaredKind = mime === "" || mime === "application/octet-stream"
          ? undefined
          : classifyBody(mime, () => Buffer.alloc(0));
        if (declaredKind === "pdf" || declaredKind === "binary") {
          discardBody(response);
          throw new WebFetchContentError(unsupportedBodyMessage(declaredKind, mime));
        }
        const body = await readResponseBytes(response, context.abortSignal);
        const kind = declaredKind ?? classifyBody(mime, () => body);
        if (kind === "pdf" || kind === "binary") {
          throw new WebFetchContentError(unsupportedBodyMessage(kind, mime));
        }
        const decoded = decodeBody(body, rawContentType);
        const converted = kind === "html" ? htmlToMarkdown(decoded, finalUrl) : { markdown: decoded };
        if (!response.ok) {
          throw new WebFetchContentError(
            `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
            converted.markdown.slice(0, HTTP_ERROR_EXCERPT_CHARS),
          );
        }
        // Preserve complete bounded output for the shared history/artifact and
        // chunk reader. Provider projection owns previews, not this producer.
        const output = JSON.stringify({
          url,
          ...(finalUrl !== url ? { finalUrl } : {}),
          status: response.status,
          contentType: mime || "unknown",
          format: kind === "html" ? "markdown" : "text",
          ...("title" in converted && converted.title ? { title: converted.title } : {}),
          content: converted.markdown,
        });
        if (Buffer.byteLength(output, "utf8") > MAX_TOOL_RESULT_ARTIFACT_BYTES) {
          throw new Error(`Serialized response exceeds the ${MAX_TOOL_RESULT_ARTIFACT_BYTES}-byte tool result limit.`);
        }
        return {
          output,
          isError: false,
        };
      } catch (error) {
        return {
          output: JSON.stringify({
            url,
            error: t("be_tools.webFetchError"),
            details: errorMessage(error),
            ...(error instanceof WebFetchContentError && error.excerpt ? { excerpt: error.excerpt } : {}),
          }),
          isError: true,
        };
      }
    },
  });
}
