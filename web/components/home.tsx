import Link from "next/link";
import { href, type Locale } from "@/lib/i18n";
import { homeCopy } from "@/lib/home";
import { docPages } from "@/lib/docs";
import { getDownloads } from "@/lib/downloads";
import { OsCta } from "./client";
import { QuadFragment, SidebarFragment, WorkbenchFragment } from "./fragments";

/** Splits a paragraph after its first sentence (DESIGN.md 12). */
function claim(text: string): [string, string] {
  const at = text.indexOf(". ");
  return at < 0 ? [text, ""] : [text.slice(0, at + 1), text.slice(at + 2)];
}

export function Chevron() {
  return (
    <svg className="chev" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Home({ locale }: { locale: Locale }) {
  const c = homeCopy(locale);
  const downloads = getDownloads(locale);
  const dlPage = href(locale, "/download/");
  const docs = href(locale, "/docs/");
  const guides = docPages(locale);
  /** Section label: the matching guide page, as a link (DESIGN.md 25). */
  const label = (slug: string) => {
    const page = guides.find((p) => p.slug === slug);
    if (!page) throw new Error(`home: no guide page "${slug}"`);
    return (
      <Link className="eyebrow" href={href(locale, `/docs/${slug}/`)}>
        {page.title}
        <Chevron />
      </Link>
    );
  };
  const [leadClaim, leadRest] = claim(c.hero.lead);
  const cta = { any: c.hero.cta, mac: c.hero.ctaMac, windows: c.hero.ctaWin, linux: c.hero.ctaLinux };

  return (
    <main id="main">
      {/* Hero: the claim, one action, and the app itself bleeding out of its panel (19, 20). */}
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-panel">
          <div className="hero-text">
            <Link className="pill" href={dlPage} data-rise style={{ ["--i" as string]: 0 }}>
              macOS · Windows · Linux
              <Chevron />
            </Link>
            <h1 id="hero-title" className="display" data-rise style={{ ["--i" as string]: 1 }}>
              <span className="line">{c.hero.line1}</span>{" "}
              <span className="line">{c.hero.line2}</span>
            </h1>
            <div className="hero-actions" data-rise style={{ ["--i" as string]: 2 }}>
              <OsCta base={dlPage} labels={cta} />
              <Link className="button button-ghost" href={docs}>{c.hero.docs}</Link>
            </div>
          </div>
          <div className="hero-window">
            <WorkbenchFragment c={c.frag} />
          </div>
        </div>
      </section>

      {/* Intro: the claim sentence in ink, the rest muted (12). */}
      <section className="section rule-top">
        <div className="frame rails">
          <div className="intro" data-reveal>
            <div>{label("start")}</div>
            <p className="intro-text">
              <strong>{leadClaim}</strong> {leadRest}
            </p>
          </div>
        </div>
      </section>

      {/* Permissions: the live thing. Radios + :has() work without script. */}
      <section id="permissions" className="section band rule-top" aria-labelledby="perm-title">
        <div className="frame rails">
          <div className="center-head" data-reveal>
            {label("permissions")}
            <h2 id="perm-title" className="head">{c.perm.title}</h2>
            <p className="lead">{c.perm.statement}</p>
          </div>
          <div className="perm-live">
            <fieldset className="modes">
              <legend className="sr-only">{c.perm.legend}</legend>
              <div className="modes-track">
                {c.perm.modes.map((m) => (
                  <div className="mode" key={m.id}>
                    <input type="radio" name="perm-mode" id={`mode-${m.id}`} value={m.id} defaultChecked={m.id === "default"} />
                    <label htmlFor={`mode-${m.id}`}>{m.label}</label>
                  </div>
                ))}
              </div>
            </fieldset>
            <p className="mode-desc" aria-live="polite">
              {c.perm.modes.map((m) => (
                <span key={m.id} data-m={m.id}>{m.desc}</span>
              ))}
            </p>
            <table className="requests">
              <caption className="sr-only">{c.perm.tableCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{c.perm.colRequest}</th>
                  <th scope="col">{c.perm.colKind}</th>
                  <th scope="col">{c.perm.colResult}</th>
                </tr>
              </thead>
              <tbody>
                {c.perm.requests.map((r) => (
                  <tr key={r.what}>
                    <td className="what">
                      {r.what}
                      {r.code ? <> <code>{r.code}</code></> : null}
                    </td>
                    <td className="kind">{r.kind}</td>
                    <td className="verdict">
                      {(Object.keys(r.result) as (keyof typeof r.result)[]).map((m) => (
                        <span key={m} data-m={m} className={`v-${r.result[m]}`}>{c.perm.verdicts[r.result[m]]}</span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="captions" data-reveal>
            {c.perm.facts.map((f) => (
              <p key={f.title}><strong>{f.title}</strong> {f.body}</p>
            ))}
          </div>
        </div>
      </section>

      {/* Workbench: four tiles, then the keys that drive them. */}
      <section id="workbench" className="section rule-top" aria-labelledby="wb-title">
        <div className="frame rails">
          <div className="center-head" data-reveal>
            {label("workbench")}
            <h2 id="wb-title" className="head">{c.wb.title}</h2>
            <p className="lead">{c.wb.body}</p>
          </div>
          <div className="stage" data-reveal>
            <div className="stage-inner">
              <QuadFragment quad={c.wb.quad} title={c.frag.windowTitle} />
            </div>
          </div>
          <dl className="captions keys" data-reveal>
            {c.wb.keys.map((k) => (
              <div key={k.key}>
                <dt>{k.key === "Enter" || k.key.startsWith("⌘") ? <kbd>{k.key}</kbd> : k.key}</dt>
                <dd>{k.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Models: the provider names. */}
      <section id="models" className="section band rule-top" aria-labelledby="models-title">
        <div className="frame rails">
          <div className="center-head" data-reveal>
            {label("models")}
            <h2 id="models-title" className="head">{c.models.title}</h2>
            <p className="lead">{c.models.body}</p>
          </div>
          <ul className="providers" data-reveal>
            {c.models.providers.map((p) => <li key={p}>{p}</li>)}
            {c.models.local.map((p) => <li key={p} className="local">{p}</li>)}
          </ul>
          <p className="models-subs" data-reveal>{c.models.subs}</p>
        </div>
      </section>

      {/* Plugins: text beside one dark code panel, then the sources and the rules. */}
      <section id="plugins" className="rule-top" aria-labelledby="plug-title">
        <div className="frame rails split">
          <div className="split-text" data-reveal>
            {label("plugins")}
            <h2 id="plug-title" className="head">{c.plugins.title}</h2>
            <p className="lead">{c.plugins.body}</p>
          </div>
          <div className="split-panel">
            <pre className="codeblock codeblock-dark"><code><span className="c">{c.plugins.codeComment1}</span>{"\n"}ave://marketplace/add?url=&lt;repository&gt;{"\n\n"}<span className="c">{c.plugins.codeComment2}</span>{"\n"}ave://install/plugin/&lt;name&gt;@&lt;source&gt;</code></pre>
            <p className="split-note">{c.plugins.codeNote}</p>
          </div>
        </div>
        <div className="frame rails section section-tight">
          <table className="sources" data-reveal>
            <caption>{c.plugins.sourcesCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{c.plugins.colSource}</th>
                <th scope="col">{c.plugins.colWhere}</th>
                <th scope="col">{c.plugins.colTrust}</th>
              </tr>
            </thead>
            <tbody>
              {c.plugins.sources.map((s) => (
                <tr key={s.name}>
                  <th scope="row">{s.name}</th>
                  <td>{s.where}</td>
                  <td>{s.trust}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="captions" data-reveal>
            {c.plugins.facts.map((f) => (
              <p key={f.title}><strong>{f.title}</strong> {f.body}</p>
            ))}
          </div>
        </div>
      </section>

      {/* Alongside: the chat list holds what runs beside you. */}
      <section id="alongside" className="section band rule-top" aria-labelledby="side-title">
        <div className="frame rails">
          <div className="center-head" data-reveal>
            {label("automation")}
            <h2 id="side-title" className="head">{c.side.title}</h2>
          </div>
          <div className="side">
            <div className="stage stage-side" data-reveal>
              <div className="stage-inner">
                <SidebarFragment s={c.side.sidebar} />
              </div>
            </div>
            <div className="side-rows" data-reveal>
              {c.side.rows.map((r) => (
                <p key={r.title}><strong>{r.title}</strong> {r.body}</p>
              ))}
            </div>
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
              <Link href={dlPage}>{c.dl.guide}</Link>
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
