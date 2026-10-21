"use client";

import { useMotionValueEvent, useScroll, useSpring, useTransform, type MotionValue } from "motion/react";
import * as m from "motion/react-m";
import { useRef, useState } from "react";
import { mediaSize, type Picture } from "@/lib/content";
import { Frame, Shot } from "./media";
import { usePinned } from "./motion";

/**
 * The feature tour on the home page (web/DESIGN.md, "Motion").
 *
 * The server renders a plain list: per feature its heading, lead, points, link
 * and two captures. That list is the whole section without script, on narrow
 * screens and with reduced motion.
 *
 * On a wide screen with script and motion allowed (the PINNED query in
 * components/motion.tsx, which app/globals.css repeats), each step becomes a
 * viewport-tall block beside a sticky stage. One scroll progress for the
 * whole tour drives the stage 1:1: the frame's position, scale and rotation
 * move continuously from one step's pose to the next, the captures cross-fade
 * at each step boundary, and the same raw progress picks the current step, so
 * text and picture switch together and scrolling back retraces every frame.
 * The page scrolls natively the whole time; nothing here moves it.
 */

export interface TourStep {
  id: string;
  eyebrow: string;
  title: string;
  lead: string;
  /** The feature page's first points: a bold lead and the rest of the sentence. */
  points: [string, string][];
  pic: Picture;
  /** A second capture from the feature page, shown as an inset beside the main one. */
  detail: Picture;
  more: { href: string; label: string };
}

/** Half the width of the cross-fade around each step boundary, in tour progress (0–1). */
const FADE = 0.05;

/** The frame's pose at the middle of each step; the last one is the rest pose the static list shows. */
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
 * Keyframes for one pose property: the entry pose at progress 0, each step's
 * pose at the middle of its span, and the last pose held to the end. Between
 * keyframes the value moves linearly, so the frame is always in motion while
 * the page scrolls, and each scroll position maps to exactly one frame.
 */
function poseFrames(n: number, key: keyof Pose): { input: number[]; output: number[] } {
  const input = [0];
  const output = [ENTRY[key]];
  for (let i = 0; i < n; i++) {
    input.push((i + 0.5) / n);
    output.push(POSES[Math.min(i, POSES.length - 1)]![key]);
  }
  input.push(1);
  output.push(output[output.length - 1]!);
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
function stepAt(progress: number, n: number): number {
  return Math.min(n - 1, Math.max(0, Math.floor(progress * n)));
}

function usePose(progress: MotionValue<number>, n: number, key: keyof Pose): MotionValue<number> {
  const { input, output } = poseFrames(n, key);
  return useTransform(progress, input, output);
}

function Layer({ progress, n, i, pic, className }: { progress: MotionValue<number>; n: number; i: number; pic: Picture; className: string }) {
  const { input, output } = layerFrames(n, i);
  const opacity = useTransform(progress, input, output);
  // The incoming capture settles from slightly larger, a small depth cue inside the frame.
  const scale = useTransform(progress, [i / n - FADE, i / n + FADE], [i === 0 ? 1 : 1.04, 1]);
  const { w, h } = mediaSize(pic.k);
  const full = Math.abs(w / h - 1.6) < 0.02;
  return (
    <m.div className={full ? className : `${className} crop`} style={{ opacity, scale }} data-layer={i}>
      {/* Every capture keeps its alt text, so all of them stay reachable to assistive technology. */}
      <Shot pic={pic} />
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

  // The frame, the cross-fades and the current step follow the scroll position 1:1.
  const x = useTransform(usePose(scrollYProgress, n, "x"), (v) => `${v}%`);
  const y = useTransform(usePose(scrollYProgress, n, "y"), (v) => `${v}%`);
  const scale = usePose(scrollYProgress, n, "scale");
  const rotate = usePose(scrollYProgress, n, "rotate");

  // Only the inset carries a little inertia: a stiff spring that settles within a few
  // frames and, at rest, equals the scroll position, so it too retraces when scrolling back.
  const drift = useSpring(scrollYProgress, { stiffness: 500, damping: 50, restDelta: 0.0005 });
  const detailY = useTransform(drift, [0, 1], ["22%", "-22%"]);
  const detailRotate = useTransform(rotate, (r) => -r * 0.8);

  const [active, setActive] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (v) => {
    const next = stepAt(v, n);
    setActive((prev) => (prev === next ? prev : next));
  });

  return (
    <div ref={ref} className="tour" data-live={pinned ? "" : undefined}>
      <ol className="tour-steps">
        {steps.map((s, i) => (
          <li key={s.id} className="tour-step" aria-current={pinned && i === active ? "step" : undefined}>
            <div className="tour-text">
              <p className="eyebrow">
                <span className="tour-num">{String(i + 1).padStart(2, "0")}</span> {s.eyebrow}
              </p>
              <h3 className="h3 tour-title">{s.title}</h3>
              <p className="lead">{s.lead}</p>
              <ul className="points tour-points">
                {s.points.map(([lead, rest]) => (
                  <li key={lead}>
                    <b>{lead}</b>
                    {/[.:]$/u.test(lead) ? ` ${rest}` : rest}
                  </li>
                ))}
              </ul>
              <a className="more" href={s.more.href}>
                {s.more.label}
              </a>
            </div>
            <div className="tour-still">
              <Frame pic={s.pic} />
              <div className="tour-still-detail">
                <Frame pic={s.detail} />
              </div>
            </div>
          </li>
        ))}
      </ol>
      <figure className="tour-stage" aria-label={label} aria-hidden={pinned ? undefined : true}>
        <div className="tour-scene">
          <m.div className="tour-frame" style={{ x, y, scale, rotate }}>
            {steps.map((s, i) => (
              <Layer key={s.id} progress={scrollYProgress} n={n} i={i} pic={s.pic} className="tour-layer" />
            ))}
          </m.div>
          <m.div className="tour-detail" style={{ y: detailY, rotate: detailRotate }}>
            {steps.map((s, i) => (
              <Layer key={s.id} progress={scrollYProgress} n={n} i={i} pic={s.detail} className="tour-layer tour-detail-layer" />
            ))}
          </m.div>
        </div>
        <div className="tour-index" aria-hidden="true">
          <span className="tour-track">
            <m.span className="tour-rail" style={{ scaleY: scrollYProgress }} />
          </span>
          <ol>
            {steps.map((s, i) => (
              <li key={s.id} data-on={i === active ? "" : undefined}>
                {s.eyebrow}
              </li>
            ))}
          </ol>
        </div>
      </figure>
    </div>
  );
}
