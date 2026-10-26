import { mediaSize, type MediaKey, type Picture } from "@/lib/content";

/**
 * Every capture exists in a light and a dark (Tokyo Night) version, each as
 * AVIF, WebP and a half-width PNG fallback (web/DESIGN.md, "Media"). The
 * browser picks the theme with the colour-scheme media query and the first
 * format it supports. Width and height are always set so the page does not
 * shift while loading.
 */

const DARK = "(prefers-color-scheme: dark)";
const src = (k: MediaKey, theme: "light" | "dark", ext: string) => `/media/${k}-${theme}.${ext}`;

/** The dark sources, listed before the light ones so a dark scheme matches first. */
function DarkSources({ k, png = true }: { k: MediaKey; png?: boolean }) {
  return (
    <>
      <source media={DARK} type="image/avif" srcSet={src(k, "dark", "avif")} />
      <source media={DARK} type="image/webp" srcSet={src(k, "dark", "webp")} />
      {png ? <source media={DARK} srcSet={src(k, "dark", "png")} /> : null}
    </>
  );
}

export function Shot({ pic, priority = false, className }: { pic: Picture; priority?: boolean; className?: string }) {
  const { w, h, x } = mediaSize(pic.k);
  return (
    <picture className={className}>
      <DarkSources k={pic.k} />
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
 * A capture cropped inside a fixed window (the home tiles): `crop` is the
 * picture's width, left and top as percentages of the window. Lazy, with its
 * width and height set like every other picture.
 */
export function Crop({ pic, crop }: { pic: Picture; crop: [w: number, x: number, y: number] }) {
  const { w, h } = mediaSize(pic.k);
  const [cw, cx, cy] = crop;
  return (
    <picture>
      <DarkSources k={pic.k} />
      <source type="image/avif" srcSet={src(pic.k, "light", "avif")} />
      <source type="image/webp" srcSet={src(pic.k, "light", "webp")} />
      <img
        src={src(pic.k, "light", "png")}
        alt={pic.alt}
        width={w}
        height={h}
        loading="lazy"
        decoding="async"
        className="crop-img"
        style={{ width: `${cw}%`, left: `${cx}%`, top: `${cy}%` }}
      />
    </picture>
  );
}

/**
 * Preload hints for a page's first picture, one per colour scheme. React
 * hoists these `<link>` elements into the document head.
 */
export function PreloadShot({ k }: { k: MediaKey }) {
  return (
    <>
      <link rel="preload" as="image" type="image/avif" href={src(k, "light", "avif")} media="(prefers-color-scheme: light)" fetchPriority="high" />
      <link rel="preload" as="image" type="image/avif" href={src(k, "dark", "avif")} media={DARK} fetchPriority="high" />
    </>
  );
}
