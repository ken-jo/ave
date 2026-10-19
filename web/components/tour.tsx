"use client";

import {
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import * as m from "motion/react-m";
import { useEffect, useRef, useState } from "react";
import { mediaSize, type Picture } from "@/lib/content";
import { Frame, Shot } from "./media";

/**
 * The feature tour on the home page (web/DESIGN.md, "Motion").
 *
 * The server renders a plain list: per feature its heading, lead, link and
 * capture. That list is the whole section without script, on narrow screens
 * and with reduced motion.
 *
 * On a wide screen with script and motion allowed, CSS (the PINNED query, the
 * same string the script tests) turns each step into a viewport-tall block and
 * shows a sticky stage beside them. The stage's frame is scroll-linked: one
 * scroll progress for the whole tour drives its position, scale and rotation
 * through a pose per step, cross-fades the captures, and picks the current
 * step. The page scrolls natively the whole time; nothing here moves it.
 */

export interface TourStep {
  id: string;
  eyebrow: string;
  title: string;
  lead: string;
  pic: Picture;
  more: { href: string; label: string };
}

/** Kept equal to the media query in app/globals.css (".tour" pinned layout). */
export const PINNED = "(min-width: 1024px) and (prefers-reduced-motion: no-preference) and (scripting: enabled)";

/** Half the width of the cross-fade around each step boundary, in tour progress (0–1). */
const FADE = 0.05;

/** The frame's pose for each step: the last one is the rest pose, the one the static list shows. */
const POSES = [
  { x: -3, y: 2, scale: 0.9, rotate: -3 },
  { x: 3, y: -1.5, scale: 0.96, rotate: 2 },
  { x: -2, y: 0, scale: 1.03, rotate: -1.5 },
  { x: 2.5, y: 1, scale: 0.95, rotate: 2.5 },
  { x: 0, y: 0, scale: 1, rotate: 0 },
];
/** Where the frame starts as the tour scrolls in, before the first step. */
const ENTRY = { x: 0, y: 8, scale: 0.84, rotate: -6 };

type Pose = typeof ENTRY;

/**
 * Keyframes for one pose property: the entry pose at progress 0, then each
 * step's pose held across its own span, changing only in the cross-fade
 * window around a step boundary. Scrolling back walks the same keyframes in
 * reverse, so every scroll position has exactly one frame.
 */
function poseFrames(n: number, key: keyof Pose): { input: number[]; output: number[] } {
  const input = [0];
  const output = [ENTRY[key]];
  for (let i = 0; i < n; i++) {
    const pose = POSES[Math.min(i, POSES.length - 1)][key];
    input.push(i / n + FADE, (i + 1) / n - FADE);
    output.push(pose, pose);
  }
  input.push(1);
  output.push(output[output.length - 1]);
  return { input, output };
}

/** Opacity keyframes for capture `i`: fully shown across its step, cross-fading at each boundary. */
function layerFrames(n: number, i: number): { input: number[]; output: number[] } {
  const start = i / n;
  const end = (i + 1) / n;
  if (n === 1) return { input: [0, 1], output: [1, 1] };
  if (i === 0) return { input: [end - FADE, end + FADE], output: [1, 0] };
  if (i === n - 1) return { input: [start - FADE, start + FADE], output: [0, 1] };
  return { input: [start - FADE, start + FADE, end - FADE, end + FADE], output: [0, 1, 1, 0] };
}

/** The step a progress value falls in; a boundary is the middle of the cross-fade, so text and picture switch together. */
export function stepAt(progress: number, n: number): number {
  return Math.min(n - 1, Math.max(0, Math.floor(progress * n)));
}

function usePinned(): boolean {
  const reduce = useReducedMotion();
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(PINNED);
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return wide && !reduce;
}

function usePose(progress: MotionValue<number>, n: number, key: keyof Pose): MotionValue<number> {
  const { input, output } = poseFrames(n, key);
  return useTransform(progress, input, output);
}

function Layer({ progress, n, i, pic }: { progress: MotionValue<number>; n: number; i: number; pic: Picture }) {
  const { input, output } = layerFrames(n, i);
  const opacity = useTransform(progress, input, output);
  // The incoming capture settles from slightly larger, a small depth cue inside the frame.
  const scale = useTransform(progress, [i / n - FADE, i / n + FADE], [i === 0 ? 1 : 1.04, 1]);
  const { w, h } = mediaSize(pic.k);
  const full = Math.abs(w / h - 1.6) < 0.02;
  return (
    <m.div className={full ? "tour-layer" : "tour-layer crop"} style={{ opacity, scale }} data-layer={i}>
      {/* The stage as a whole carries the label; the pictures inside it are decoration. */}
      <Shot pic={{ k: pic.k, alt: "" }} />
    </m.div>
  );
}

export function Tour({ steps, label }: { steps: TourStep[]; label: string }) {
  const n = steps.length;
  const ref = useRef<HTMLDivElement>(null);
  const pinned = usePinned();

  // 0 when the top of the tour reaches the middle of the viewport, 1 when its bottom does:
  // a step is current while its block crosses the middle of the screen.
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start center", "end center"] });
  // A spring smooths wheel steps. It only follows the scroll position, in either
  // direction, and at rest equals it, so scrolling back always returns to the same frame.
  const progress = useSpring(scrollYProgress, { stiffness: 140, damping: 30, restDelta: 0.0005 });

  const x = useTransform(usePose(progress, n, "x"), (v) => `${v}%`);
  const y = useTransform(usePose(progress, n, "y"), (v) => `${v}%`);
  const scale = usePose(progress, n, "scale");
  const rotate = usePose(progress, n, "rotate");
  const rail = useTransform(progress, [0, 1], [0, 1]);

  const [active, setActive] = useState(0);
  useMotionValueEvent(progress, "change", (v) => {
    const next = stepAt(v, n);
    setActive((prev) => (prev === next ? prev : next));
  });

  return (
    <div ref={ref} className="tour" data-live={pinned ? "" : undefined} data-active={pinned ? active : undefined}>
      <ol className="tour-steps">
        {steps.map((s, i) => (
          <li key={s.id} className="tour-step" aria-current={pinned && i === active ? "step" : undefined}>
            <div className="tour-text">
              <p className="eyebrow">
                <span className="tour-num">{String(i + 1).padStart(2, "0")}</span> {s.eyebrow}
              </p>
              <h3 className="h3 tour-title">{s.title}</h3>
              <p className="lead">{s.lead}</p>
              <a className="more" href={s.more.href}>
                {s.more.label}
              </a>
            </div>
            <div className="tour-still">
              <Frame pic={s.pic} />
            </div>
          </li>
        ))}
      </ol>
      <div className="tour-stage" aria-hidden={pinned ? undefined : true}>
        <m.figure className="tour-frame" role="img" aria-label={`${label}: ${steps[active].pic.alt}`} style={{ x, y, scale, rotate }}>
          {steps.map((s, i) => (
            <Layer key={s.id} progress={progress} n={n} i={i} pic={s.pic} />
          ))}
        </m.figure>
        <div className="tour-index" aria-hidden="true">
          <span className="tour-track">
            <m.span className="tour-rail" style={{ scaleY: rail }} />
          </span>
          <ol>
            {steps.map((s, i) => (
              <li key={s.id} data-on={i === active ? "" : undefined}>
                {s.eyebrow}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
