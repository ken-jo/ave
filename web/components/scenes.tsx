"use client";

/*
 * Motion scenes (web/DESIGN.md 19–23). Each scene is a composed, static
 * frame first: nodes are HTML at fixed positions and the beams are SVG paths
 * rendered on the server, so the picture reads without script and under
 * reduced motion. With script, a short bright pulse travels each beam in turn
 * (the beam technique follows Magic UI's AnimatedBeam; notice in
 * web/THIRD_PARTY_NOTICES.md), and the model orbit turns with scroll.
 */
import { useRef, type CSSProperties, type ReactNode } from "react";
import { LazyMotion, m, useInView, useReducedMotion, useScroll, useTransform } from "motion/react";
import { cn } from "@/lib/utils";

/** Animation features arrive in their own chunk after first paint. */
const loadFeatures = () => import("./motion-features").then((mod) => mod.default);

type Pt = [number, number];

export interface Layout {
  /** viewBox size; the container keeps this aspect ratio so % and px agree. */
  size: Pt;
  nodes: Record<string, Pt>;
  edges: { a: Pt; b: Pt; bend?: number; reverse?: boolean }[];
}

interface SceneProps {
  label: string;
  /** Layout from 1024 px. */
  wide: Layout;
  /** Layout below 1024 px; omit to show `fallback` there instead. */
  narrow?: Layout;
  nodes: Record<string, { body: ReactNode; className?: string }>;
  fallback?: ReactNode;
  /** Start on mount (hero) or when the scene scrolls into view. */
  start?: "mount" | "view";
  className?: string;
}

const PULSE = 1.5; // seconds a pulse takes to cross one beam

function pathOf({ a, b, bend = 0 }: Layout["edges"][number]) {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  // Control point pushed perpendicular to the chord by `bend`.
  const cx = mx - ((y2 - y1) / len) * bend;
  const cy = my + ((x2 - x1) / len) * bend;
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
}

function Beams({ layout, run, id }: { layout: Layout; run: boolean; id: string }) {
  const [w, h] = layout.size;
  const n = layout.edges.length;
  const cycle = n * PULSE * 0.75 + 1.5;
  return (
    <svg className="pointer-events-none absolute inset-0 size-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={w} y2={h}>
          <stop offset="0" stopColor="#8fd11f" />
          <stop offset="1" stopColor="#2f9e83" />
        </linearGradient>
      </defs>
      {layout.edges.map((e, i) => {
        const d = pathOf(e);
        const from = e.reverse ? -1 : 0.14;
        const to = e.reverse ? 0.14 : -1;
        return (
          <g key={i}>
            <path d={d} fill="none" stroke="rgba(11,13,12,0.2)" strokeWidth={1.5} />
            <m.path
              d={d}
              fill="none"
              stroke={`url(#${id})`}
              strokeWidth={3}
              strokeLinecap="round"
              pathLength={1}
              strokeDasharray="0.14 1"
              // Static frame: the pulse rests mid-beam.
              initial={{ strokeDashoffset: -0.43 }}
              animate={run ? { strokeDashoffset: [from, to] } : undefined}
              transition={
                run
                  ? { duration: PULSE, delay: i * PULSE * 0.75, ease: [0.22, 1, 0.36, 1], repeat: Infinity, repeatDelay: cycle - PULSE }
                  : undefined
              }
            />
          </g>
        );
      })}
    </svg>
  );
}

function Frame({ layout, nodes, run, id, className }: { layout: Layout; nodes: SceneProps["nodes"]; run: boolean; id: string; className?: string }) {
  const [w, h] = layout.size;
  return (
    <div className={cn("relative w-full", className)} style={{ aspectRatio: `${w} / ${h}` }}>
      <Beams layout={layout} run={run} id={id} />
      {Object.entries(layout.nodes).map(([key, [x, y]]) => {
        const node = nodes[key];
        if (!node) throw new Error(`scene: no node "${key}"`);
        return (
          <div
            key={key}
            className={cn("absolute -translate-x-1/2 -translate-y-1/2", node.className)}
            style={{ left: `${(x / w) * 100}%`, top: `${(y / h) * 100}%` } as CSSProperties}
          >
            {node.body}
          </div>
        );
      })}
    </div>
  );
}

export function Scene({ label, wide, narrow, nodes, fallback, start = "view", className }: SceneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -15% 0px" });
  const reduced = useReducedMotion();
  const run = !reduced && (start === "mount" || inView);
  const id = label.replace(/[^a-z0-9]/giu, "").slice(0, 12) || "beam";
  return (
    <LazyMotion features={loadFeatures} strict>
      <div ref={ref} role="img" aria-label={label} className={className}>
        <Frame layout={wide} nodes={nodes} run={run} id={`${id}-w`} className="hidden lg:block" />
        {narrow ? (
          <Frame layout={narrow} nodes={nodes} run={run} id={`${id}-n`} className="mx-auto max-w-[30rem] lg:hidden" />
        ) : (
          <div className="lg:hidden">{fallback}</div>
        )}
      </div>
    </LazyMotion>
  );
}

/**
 * Providers on a ring around Ave (after Magic UI's OrbitingCircles). The ring
 * turns a little as the section scrolls past and stands still under reduced
 * motion or without script.
 */
export function Orbit({ label, center, items }: { label: string; center: ReactNode; items: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const turn = useTransform(scrollYProgress, [0, 1], [-30, 30]);
  const counter = useTransform(turn, (v) => -v);
  return (
    <LazyMotion features={loadFeatures} strict>
      <div ref={ref} role="img" aria-label={label} className="relative mx-auto aspect-square w-full max-w-[34rem]">
        <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(11,13,12,0.12)" strokeWidth="0.25" />
          <circle cx="50" cy="50" r="24" fill="none" stroke="rgba(11,13,12,0.08)" strokeWidth="0.25" strokeDasharray="1 1.5" />
        </svg>
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">{center}</div>
        <m.div className="absolute inset-0" style={reduced ? undefined : { rotate: turn }}>
          {items.map((item, i) => {
            const a = ((360 / items.length) * i - 90) * (Math.PI / 180);
            return (
              <div
                key={item}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${50 + 40 * Math.cos(a)}%`, top: `${50 + 40 * Math.sin(a)}%` }}
              >
                <m.span className="block whitespace-nowrap rounded-full bg-white px-4 py-2 font-medium ring-1 ring-inset ring-line-strong" style={reduced ? undefined : { rotate: counter }}>
                  {item}
                </m.span>
              </div>
            );
          })}
        </m.div>
      </div>
    </LazyMotion>
  );
}
