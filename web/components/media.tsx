import { mediaSize, type MediaKey, type Picture } from "@/lib/content";

/**
 * Every capture exists as AVIF, WebP and a half-width PNG fallback, in the
 * app's light theme and its dark (Tokyo Night) theme (web/DESIGN.md, "Media").
 * The site is light only, so pages show the light captures; the browser picks
 * the first format it supports. Width and height are always set so the page
 * does not shift while loading.
 */

const src = (k: MediaKey, theme: "light", ext: string) => `/media/${k}-${theme}.${ext}`;

export function Shot({ pic, priority = false, className }: { pic: Picture; priority?: boolean; className?: string }) {
  const { w, h, x } = mediaSize(pic.k);
  return (
    <picture className={className}>
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
 * The preload hint for a page's first picture. React hoists the `<link>`
 * into the document head.
 */
export function PreloadShot({ k }: { k: MediaKey }) {
  return <link rel="preload" as="image" type="image/avif" href={src(k, "light", "avif")} fetchPriority="high" />;
}
