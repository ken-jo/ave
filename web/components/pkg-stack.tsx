"use client";

import { useMotionValueEvent, useScroll } from "motion/react";
import * as m from "motion/react-m";
import { useId, useRef, useState } from "react";
import { KindIcon } from "./icons";
import { usePinned } from "./motion";

/**
 * The home page's extension kinds and, below them, one real package from the
 * official marketplace catalog per kind that has one (lib/marketplace.ts),
 * shown as the app's install review shows a package.
 *
 * Without script, on narrow screens and with reduced motion, the packages are
 * a plain grid of cards. On a wide screen with motion allowed (the same PINNED
 * query as the feature tour) they become an overlapping stack: the current
 * card is in front and its kind is highlighted. Scrolling past the stack walks
 * through the cards (scrubbed, so scrolling back walks back); pointing at or
 * focusing a kind brings its card forward; pointing at the stack fans it out,
 * and pointing at a fanned card brings that one forward.
 */

export interface StackKind {
  name: string;
  body: string;
  /** Index into `items`, or null when the official catalog has no package of this kind. */
  item: number | null;
}

export interface StackItem {
  id: string;
  kind: string;
  title: string;
  description: string;
  /** "ko" when the catalog's description is written in Korean. */
  descLang?: string;
  rows: { label: string; value: string; code?: boolean }[];
}

const spring = { type: "spring", stiffness: 260, damping: 30, mass: 0.9 } as const;

/** Where card `i` sits: stacked behind the current one, or fanned out in a row. */
function pose(i: number, active: number, n: number, fanned: boolean) {
  if (fanned) {
    // Spread across the stack's width without leaving the page frame.
    const off = i - (n - 1) / 2;
    const front = i === active;
    return {
      x: `${off * 21}%`,
      y: Math.abs(off) * 7 + (front ? -22 : 0),
      rotate: off * 2.6,
      scale: front ? 0.84 : 0.76,
      opacity: 1,
      zIndex: front ? n + 1 : n - Math.abs(Math.round(off)),
    };
  }
  // Stacked: the current card in front, the others stepping back and up so their tops show.
  const depth = (i - active + n) % n;
  return {
    x: "0%",
    y: -depth * 24,
    rotate: depth === 0 ? 0 : (depth % 2 ? -1 : 1) * Math.min(depth, 3) * 0.9,
    scale: 1 - depth * 0.05,
    opacity: depth > 3 ? 0 : 1,
    zIndex: n - depth,
  };
}

export function PackageStack({ kinds, items, caption }: { kinds: StackKind[]; items: StackItem[]; caption: string }) {
  const n = items.length;
  const base = useId();
  const stacked = usePinned();
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [fanned, setFanned] = useState(false);
  // Once the visitor points at or focuses a card or kind, scrolling stops choosing for them.
  const [chosen, setChosen] = useState(false);

  // 0 as the stack's top enters the bottom of the viewport, 1 as its bottom leaves the top.
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  useMotionValueEvent(scrollYProgress, "change", (v) => {
    if (!stacked || chosen) return;
    // The middle 60% of the pass walks the cards once.
    const next = Math.min(n - 1, Math.max(0, Math.floor(((v - 0.2) / 0.6) * n)));
    setActive((prev) => (prev === next ? prev : next));
  });

  const pick = (i: number) => {
    setChosen(true);
    setActive(i);
  };

  return (
    <div className="pkgs" data-live={stacked ? "" : undefined}>
      <ul className="kinds">
        {kinds.map((k, i) => {
          const on = stacked && k.item !== null && k.item === active;
          const body = (
            <>
              <KindIcon index={i} />
              <b>{k.name}</b>
              <span>{k.body}</span>
            </>
          );
          return (
            <li key={k.name} className="kind" data-on={on ? "" : undefined}>
              {k.item === null || !stacked ? (
                body
              ) : (
                <button
                  type="button"
                  className="kind-btn"
                  aria-controls={`${base}-${items[k.item]!.id}`}
                  aria-pressed={on}
                  onPointerEnter={() => pick(k.item!)}
                  onFocus={() => pick(k.item!)}
                  onClick={() => pick(k.item!)}
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <figure className="pkg-stack-fig">
        <div
          ref={ref}
          className="pkg-stack"
          onPointerEnter={() => stacked && setFanned(true)}
          onPointerLeave={() => setFanned(false)}
        >
          {items.map((it, i) => (
            <m.article
              key={it.id}
              id={`${base}-${it.id}`}
              className="pkg"
              data-front={stacked && i === active ? "" : undefined}
              initial={false}
              animate={stacked ? pose(i, active, n, fanned) : undefined}
              transition={spring}
              onPointerEnter={() => stacked && fanned && pick(i)}
              onFocus={() => stacked && pick(i)}
              tabIndex={stacked ? 0 : undefined}
            >
              <p className="pkg-kind">{it.kind}</p>
              <h3 className="h3">{it.title}</h3>
              <p className="pkg-desc" lang={it.descLang}>
                {it.description}
              </p>
              <dl>
                {it.rows.map((r) => (
                  <div key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>{r.code ? <code>{r.value}</code> : r.value}</dd>
                  </div>
                ))}
              </dl>
            </m.article>
          ))}
        </div>
        <figcaption>{caption}</figcaption>
      </figure>
    </div>
  );
}
