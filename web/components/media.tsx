import { mediaSize, type MediaKey, type Picture } from "@/lib/content";

/**
 * Every capture exists in a light and a dark version, each as AVIF, WebP and
 * a half-width PNG fallback (web/DESIGN.md, "Media"). The browser picks the
 * theme with the colour-scheme media query and the first format it supports.
 * Width and height are always set so the page does not shift while loading.
 */

const DARK = "(prefers-color-scheme: dark)";
const src = (k: MediaKey, theme: "light" | "dark", ext: string) => `/media/${k}-${theme}.${ext}`;

export function Shot({ pic, priority = false, className }: { pic: Picture; priority?: boolean; className?: string }) {
  const { w, h, x } = mediaSize(pic.k);
  return (
    <picture className={className}>
      <source media={DARK} type="image/avif" srcSet={src(pic.k, "dark", "avif")} />
      <source media={DARK} type="image/webp" srcSet={src(pic.k, "dark", "webp")} />
      <source media={DARK} srcSet={src(pic.k, "dark", "png")} />
      <source type="image/avif" srcSet={src(pic.k, "light", "avif")} />
      <source type="image/webp" srcSet={src(pic.k, "light", "webp")} />
      <img
        src={src(pic.k, "light", "png")}
        alt={pic.alt}
        width={w}
        height={h}
        loading={priority ? "eager" : "lazy"}
        decoding={priority ? "sync" : "async"}
        fetchPriority={priority ? "high" : undefined}
        // Never wider than the capture's own size on screen, so a small crop is not blown up.
        style={{ maxWidth: `${Math.round(w / x)}px` }}
      />
    </picture>
  );
}

/** A framed screenshot. */
export function Frame({ pic, priority = false }: { pic: Picture; priority?: boolean }) {
  return (
    <div className="shot">
      <Shot pic={pic} priority={priority} />
    </div>
  );
}

/**
 * Preload hints for a page's first picture, one per theme. React hoists
 * these `<link>` elements into the document head.
 */
export function PreloadShot({ k }: { k: MediaKey }) {
  return (
    <>
      <link rel="preload" as="image" type="image/avif" href={src(k, "light", "avif")} media="(prefers-color-scheme: light)" fetchPriority="high" />
      <link rel="preload" as="image" type="image/avif" href={src(k, "dark", "avif")} media={DARK} fetchPriority="high" />
    </>
  );
}

/**
 * The home hero: the conversation still as the poster, with a short silent
 * loop of the same screen playing over it. With reduced motion the loop is
 * hidden and only the still shows.
 */
export function HeroLoop({ pic, label }: { pic: Picture; label: string }) {
  const { w, h } = mediaSize("hero-loop");
  return (
    <figure className="shot hero-shot" aria-label={label}>
      <Shot pic={pic} priority />
      <video className="loop" width={w} height={h} autoPlay muted loop playsInline preload="metadata" aria-hidden="true" tabIndex={-1}>
        <source media={DARK} type="video/webm" src="/media/hero-dark.webm" />
        <source media={DARK} type="video/mp4" src="/media/hero-dark.mp4" />
        <source type="video/webm" src="/media/hero-light.webm" />
        <source type="video/mp4" src="/media/hero-light.mp4" />
      </video>
    </figure>
  );
}
