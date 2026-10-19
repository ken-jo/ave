"use client";

import {
  LazyMotion,
  MotionConfig,
  stagger,
  useInView,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  type Variants,
} from "motion/react";
import * as m from "motion/react-m";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Motion for the home page (web/DESIGN.md, "Motion"). Everything here is an
 * enhancement of HTML that is already complete: the server renders every
 * element in its final, visible state, and nothing is hidden until script has
 * run and found that the element is still below the fold.
 *
 * `LazyMotion` loads only the `domAnimation` feature set (no layout or drag),
 * and loads it asynchronously after hydration (components/motion-features.ts),
 * so it is not in the page's first script. `strict` makes a stray full
 * `motion.*` component fail instead of silently pulling the whole bundle back in.
 * `MotionConfig reducedMotion="user"` turns transform animations off for
 * visitors who ask for reduced motion.
 */
const loadFeatures = () => import("./motion-features").then((mod) => mod.default);

export function MotionRoot({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

/**
 * "static" is the server-rendered state and has no variant: elements stay
 * exactly as rendered. "hidden" is applied instantly, only to a group that is
 * still below the fold after hydration; "shown" then plays when it scrolls in,
 * each item delayed one after the other.
 */
type Phase = "static" | "hidden" | "shown";

const group: Variants = {
  hidden: { transition: { duration: 0 } },
  shown: { transition: { delayChildren: stagger(0.07) } },
};

const item: Variants = {
  hidden: { opacity: 0, y: 18, transition: { duration: 0 } },
  shown: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] } },
};

const tags = { div: m.div, article: m.article, li: m.li };
type Tag = keyof typeof tags;

/** A group whose `RevealItem` descendants enter in sequence the first time it scrolls into view. */
export function Reveal({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  // Any part of the group inside the viewport, less a strip at the bottom so the entrance is seen.
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  const [phase, setPhase] = useState<Phase>("static");
  const { scrollY } = useScroll();

  useEffect(() => {
    const el = ref.current;
    if (reduce || !el) return;
    // Only a group that starts below the fold is hidden; one already on screen (or scrolled past) stays put.
    if (el.getBoundingClientRect().top > window.innerHeight) setPhase("hidden");
  }, [reduce]);

  useEffect(() => {
    if (inView && phase === "hidden") setPhase("shown");
  }, [inView, phase]);

  // A jump past the group (End key, a long fling, a restored position) may never intersect it;
  // a group that is already above the viewport is shown so nothing stays hidden behind the reader.
  useMotionValueEvent(scrollY, "change", () => {
    if (phase !== "hidden") return;
    const el = ref.current;
    if (el && el.getBoundingClientRect().bottom < 0) setPhase("shown");
  });

  return (
    <m.div ref={ref} className={className} initial={false} animate={phase} variants={group}>
      {children}
    </m.div>
  );
}

/** One element of a `Reveal` group. Outside a group it renders as plain, static markup. */
export function RevealItem({ as = "div", className, children }: { as?: Tag; className?: string; children: ReactNode }) {
  const Comp = tags[as] as typeof m.div;
  return (
    <Comp className={className} variants={item}>
      {children}
    </Comp>
  );
}
