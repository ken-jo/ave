import Link from "next/link";
import type { ReactNode } from "react";
import { href, type Locale } from "@/lib/i18n";
import { homeCopy } from "@/lib/home";
import { docPages } from "@/lib/docs";
import { getDownloads } from "@/lib/downloads";
import { OsCta } from "./os-cta";
import { Mark } from "./chrome";
import { QuadFragment, SidebarFragment } from "./fragments";
import { Orbit, Scene, type Layout } from "./scenes";
import { Button } from "./ui/button";
import { Chevron } from "./chevron";

/* ── Scene parts (DESIGN.md 19, 21) ─────────────────────────────────────── */

const card = "rounded-2xl bg-white/95 p-3 text-left ring-1 ring-inset ring-line";
const chip = "inline-block rounded-full bg-white px-2.5 py-0.5 text-xs ring-1 ring-inset ring-line-strong";
const label = "mb-2 block text-xs text-muted";

function Hub({ name, role }: { name: string; role?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="grid place-items-center rounded-[22px] shadow-[0_0_0_10px_rgba(196,240,74,0.35)]">
        <Mark className="size-16 text-ink lg:size-[4.5rem]" />
      </span>
      <span className="text-sm font-medium">{name}</span>
      {role ? <span className="-mt-1 text-xs text-muted">{role}</span> : null}
    </div>
  );
}

function Chips({ items }: { items: string[] }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <span key={i} className={chip}>{i}</span>
      ))}
    </span>
  );
}

type P = [number, number];

const heroWide: Layout = {
  size: [1000, 360],
  nodes: { you: [160, 178], ave: [500, 172], models: [840, 76], computer: [840, 278] },
  edges: [
    { a: [270, 178], b: [456, 172] },
    { a: [546, 156], b: [732, 82], bend: -16 },
    { a: [546, 156], b: [732, 82], bend: -16, reverse: true },
    { a: [546, 188], b: [732, 278], bend: 16 },
  ],
};
const heroNarrow: Layout = {
  size: [360, 640],
  nodes: { you: [180, 72], ave: [180, 250], models: [95, 478], computer: [265, 478] },
  edges: [
    { a: [180, 140], b: [180, 196] },
    { a: [160, 300], b: [100, 380], bend: 10 },
    { a: [160, 300], b: [100, 380], bend: 10, reverse: true },
    { a: [200, 300], b: [260, 380], bend: -10 },
  ],
};

const plugWide: Layout = {
  size: [1000, 380],
  nodes: { repo: [125, 170], check: [385, 170], ave: [590, 165], k0: [860, 40], k1: [860, 100], k2: [860, 160], k3: [860, 220], k4: [860, 280], more: [860, 340] },
  edges: [
    { a: [214, 170], b: [322, 170] },
    { a: [450, 170], b: [545, 170] },
    ...[40, 100, 160, 220, 280].map((y) => ({ a: [635, 168] as P, b: [818, y] as P, bend: (168 - y) * 0.25 })),
  ],
};
const plugNarrow: Layout = {
  size: [360, 540],
  nodes: { repo: [180, 55], check: [180, 170], ave: [180, 285], kinds: [180, 460] },
  edges: [
    { a: [180, 108], b: [180, 150] },
    { a: [180, 192], b: [180, 232] },
    { a: [180, 340], b: [180, 400] },
  ],
};

const sideWide: Layout = {
  size: [1000, 460],
  nodes: { s0: [150, 85], s1: [150, 180], s2: [150, 275], s3: [150, 370], list: [690, 230] },
  edges: [85, 180, 275, 370].map((y, i) => ({ a: [222, y] as P, b: [492, 150 + i * 55] as P, bend: (y - (150 + i * 55)) * 0.2 })),
};

export function Home({ locale }: { locale: Locale }) {
  const c = homeCopy(locale);
  const downloads = getDownloads(locale);
  const dlPage = href(locale, "/download/");
  const docs = href(locale, "/docs/");
  const guides = docPages(locale);
  /** Section label: the matching guide page, as a link (DESIGN.md 25). */
  const eyebrow = (slug: string) => {
    const page = guides.find((g) => g.slug === slug);
    if (!page) throw new Error(`home: no guide page "${slug}"`);
    return (
      <Link className="eyebrow" href={href(locale, `/docs/${slug}/`)}>
        {page.title}
        <Chevron />
      </Link>
    );
  };
  const cta = { any: c.hero.cta, mac: c.hero.ctaMac, windows: c.hero.ctaWin, linux: c.hero.ctaLinux };
  const h = c.harness;
  const p = c.plugins;
  const s = c.side;

  const heroNodes: Record<string, { body: ReactNode }> = {
    you: {
      body: (
        <div className={`${card} w-[15rem] max-lg:w-[80vw] max-lg:max-w-[20rem]`}>
          <span className={label}>{h.you}</span>
          <p className="rounded-xl rounded-br-sm bg-[#f0f1ee] px-3 py-2 text-sm leading-snug">{h.youSays}</p>
        </div>
      ),
    },
    ave: { body: <Hub name={h.ave} role={h.aveRole} /> },
    models: {
      body: (
        <div className={`${card} w-[15rem] max-lg:w-[44vw] max-lg:max-w-[13.5rem]`}>
          <span className={label}>{h.models}</span>
          <Chips items={c.models.providers} />
        </div>
      ),
    },
    computer: {
      body: (
        <div className={`${card} w-[15rem] max-lg:w-[44vw] max-lg:max-w-[13.5rem]`}>
          <span className={label}>{h.computer}</span>
          <Chips items={h.computerItems} />
          <code className="mt-2 block truncate font-mono text-[0.6875rem] text-muted">{h.toolLine}</code>
        </div>
      ),
    },
  };

  const plugNodes: Record<string, { body: ReactNode }> = {
    repo: {
      body: (
        <div className={`${card} w-[12.5rem]`}>
          <span className={label}>{p.repo}</span>
          <code className="font-mono text-sm">marketplace.json</code>
        </div>
      ),
    },
    check: { body: <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-3.5 py-1.5 text-sm font-medium text-white">✓ {p.check}</span> },
    ave: { body: <Hub name={h.ave} /> },
    kinds: {
      body: (
        <div className="w-[80vw] max-w-[22rem]">
          <span className="flex flex-wrap justify-center gap-1.5">
            {p.kinds.map((k) => <span key={k} className={chip}>{k}</span>)}
            <span className="inline-block px-1 py-0.5 text-xs text-muted">{p.kindsMore}</span>
          </span>
        </div>
      ),
    },
    ...Object.fromEntries(p.kinds.map((k, i) => [`k${i}`, { body: <span className={`${chip} whitespace-nowrap text-sm`}>{k}</span> }])),
    more: { body: <span className="whitespace-nowrap text-sm text-muted">{p.kindsMore}</span> },
  };

  const sideNodes: Record<string, { body: ReactNode }> = {
    ...Object.fromEntries(s.rows.map((r, i) => [`s${i}`, { body: <span className={`${chip} whitespace-nowrap px-3.5 py-1.5 text-sm font-medium`}>{r.title}</span> }])),
    list: { body: <div className="w-[26rem]"><SidebarFragment s={s.sidebar} /></div> },
  };

  return (
    <main id="main">
      {/* Hero: the greeting, one action, and the harness where the four meet (11, 19–21). */}
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-panel">
          <div className="hero-text">
            <Link className="pill" href={href(locale, "/docs/start/")} data-rise style={{ ["--i" as string]: 0 }}>
              {c.hero.pill}
              <Chevron />
            </Link>
            <h1 id="hero-title" className="display" data-rise style={{ ["--i" as string]: 1 }}>{c.hero.title}</h1>
            <p className="hero-sub" data-rise style={{ ["--i" as string]: 2 }}>{c.hero.sub}</p>
            <div className="hero-actions" data-rise style={{ ["--i" as string]: 3 }}>
              <OsCta base={dlPage} labels={cta} />
              <Button asChild variant="ghost">
                <Link href={docs}>{c.hero.docs}</Link>
              </Button>
            </div>
          </div>
          <div className="hero-scene">
            <Scene label={h.label} wide={heroWide} narrow={heroNarrow} nodes={heroNodes} start="mount" />
          </div>
        </div>
      </section>

      {/* Intro: the name, what the app is, and the one line about control (12, 28). */}
      <section className="section">
        <div className="frame rails">
          <div className="intro" data-reveal>
            <div>{eyebrow("start")}</div>
            <div className="grid gap-5">
              <p className="intro-text">
                <strong>{c.intro.claim}</strong> {c.intro.rest}
              </p>
              <p className="text-muted">
                {c.intro.control}{" "}
                <Link className="textlink whitespace-nowrap text-ink" href={href(locale, "/docs/permissions/")}>{c.intro.controlLink}</Link>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Workbench: four tiles beside the keys that drive them (5, 19). */}
      <section id="workbench" className="section band rule-top" aria-labelledby="wb-title">
        <div className="frame rails">
          <div className="center-head" data-reveal>
            {eyebrow("workbench")}
            <h2 id="wb-title" className="head">{c.wb.title}</h2>
            <p className="lead">{c.wb.body}</p>
          </div>
          <div className="pair">
            <div className="stage" data-reveal>
              <QuadFragment quad={c.wb.quad} title={c.wb.windowTitle} />
            </div>
            <dl className="stack keys" data-reveal>
              {c.wb.keys.map((k) => (
                <div key={k.key}>
                  <dt>{k.key === "Enter" || k.key.startsWith("⌘") ? <kbd>{k.key}</kbd> : k.key}</dt>
                  <dd>{k.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* Models: providers on a ring that turns with the page (21). */}
      <section id="models" className="section rule-top" aria-labelledby="models-title">
        <div className="frame rails">
          <div className="center-head" data-reveal>
            {eyebrow("models")}
            <h2 id="models-title" className="head">{c.models.title}</h2>
            <p className="lead">{c.models.body}</p>
          </div>
          <div className="mt-14 hidden lg:block">
            <Orbit label={c.models.providers.join(", ")} center={<Hub name={h.ave} />} items={c.models.providers} />
          </div>
          <ul className="providers lg:hidden">
            {c.models.providers.map((x) => <li key={x}>{x}</li>)}
          </ul>
          <p className="models-local">
            {c.models.local.map((x) => <span key={x}>{x}</span>)}
          </p>
          <p className="models-subs" data-reveal>{c.models.subs}</p>
        </div>
      </section>

      {/* Plugins: from a git repository, through a hash check, into Ave (19, 21). */}
      <section id="plugins" className="section band rule-top" aria-labelledby="plug-title">
        <div className="frame rails">
          <div className="center-head" data-reveal>
            {eyebrow("marketplace")}
            <h2 id="plug-title" className="head">{p.title}</h2>
            <p className="lead">{p.body}</p>
          </div>
          <div className="stage">
            <Scene label={p.sceneLabel} wide={plugWide} narrow={plugNarrow} nodes={plugNodes} />
          </div>
          <div className="pair pair-even">
            <div className="code-card" data-reveal>
              <pre className="codeblock codeblock-dark"><code><span className="c">{p.codeComment1}</span>{"\n"}ave://marketplace/add?url=&lt;repository&gt;{"\n\n"}<span className="c">{p.codeComment2}</span>{"\n"}ave://install/plugin/&lt;name&gt;@&lt;source&gt;</code></pre>
              <p className="split-note">{p.codeNote}</p>
            </div>
            <div className="stack" data-reveal>
              {p.facts.map((f) => (
                <p key={f.title}><strong>{f.title}</strong> {f.body}</p>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Alongside: index, meetings, routines and sub-agents arrive in the chat list. */}
      <section id="alongside" className="section rule-top" aria-labelledby="side-title">
        <div className="frame rails">
          <div className="center-head" data-reveal>
            {eyebrow("automation")}
            <h2 id="side-title" className="head">{s.title}</h2>
          </div>
          <div className="stage">
            <Scene
              label={s.sceneLabel}
              wide={sideWide}
              nodes={sideNodes}
              fallback={<div className="mx-auto max-w-[26rem]"><SidebarFragment s={s.sidebar} /></div>}
            />
          </div>
          <div className="captions captions-4" data-reveal>
            {s.rows.map((r) => (
              <p key={r.title}><strong>{r.title}</strong> {r.body}</p>
            ))}
          </div>
        </div>
      </section>

      {/* Download: the close, one tinted panel. */}
      <section id="download" className="section rule-top" aria-labelledby="dl-title">
        <div className="frame">
          <div className="cta-panel">
            <div className="cta-text" data-reveal>
              <h2 id="dl-title" className="head">{c.dl.title}</h2>
              <p className="lead">{c.dl.lead}</p>
              <div className="hero-actions">
                <OsCta base={dlPage} labels={cta} />
              </div>
            </div>
            <ul className="dl-list">
              {downloads.map((d) => (
                <li key={d.os}>
                  <a href={d.href} aria-label={`${d.osLabel} ${d.title} ${c.dl.get}`}>
                    <span className="dl-os">{d.osLabel}</span>
                    <span className="dl-meta">{d.title}, {d.format}</span>
                  </a>
                </li>
              ))}
            </ul>
            <p className="cta-note">
              {c.dl.unsigned}{" "}
              <Link className="whitespace-nowrap" href={dlPage}>{c.dl.guide}</Link>
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
