/** Model-authored images can exfiltrate context on paint without approval, even through allowed hosts. Emit a visible
 * alt/destination chip instead of img so no request occurs. */
import type { Components, Options } from "react-markdown";

/** Schemes a link may navigate to. Anything else is dropped. */
const ALLOWED_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Drop image sources outright and restrict link targets by scheme. `react-markdown` calls this for every URL-bearing
 * attribute; `key` is the property being resolved (`"src"` for images, `"href"` for links). */
export const markdownUrlTransform: Options["urlTransform"] = (url, key) => {
  if (key === "src") return "";
  if (!url) return "";
  // Relative URLs carry no host to exfiltrate to and are resolved against the app's own file:// origin, so they are left
  // alone.
  let parsed: URL;
  try {
    parsed = new URL(url, "https://ave.invalid/");
  } catch {
    return "";
  }
  if (!url.includes(":")) return url;
  return ALLOWED_LINK_SCHEMES.has(parsed.protocol) ? url : "";
};

function BlockedImage({ alt, src }: { alt?: string | undefined; src?: string | undefined }) {
  const label = alt?.trim() || "image";
  let host = "";
  if (src) {
    try {
      host = new URL(src, "https://ave.invalid/").host;
    } catch {
      host = "unparsable";
    }
  }
  return (
    <span
      data-testid="markdown-blocked-image"
      title={src ? `Blocked remote image: ${src}` : "Blocked remote image"}
      className="inline-flex items-center gap-1 rounded border border-border/(--opacity-medium) bg-muted/(--opacity-muted) px-1.5 py-0.5 align-middle font-mono text-[11px] text-muted-foreground"
    >
      🚫 {label}
      {host ? ` · ${host}` : ""}
    </span>
  );
}

/**
 * Component overrides for model-authored markdown.
 *
 * `img` is replaced rather than merely stripped of its `src`: an `<img src="">`
 * still resolves against the document URL in some engines, and the point is
 * that no request leaves the renderer.
 */
export const MARKDOWN_SAFE_COMPONENTS: Components = {
  img: ({ alt, src }) => (
    <BlockedImage alt={typeof alt === "string" ? alt : undefined} src={typeof src === "string" ? src : undefined} />
  ),
};
