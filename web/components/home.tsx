import Link from "next/link";
import { href, type Locale } from "@/lib/i18n";
import { homeCopy } from "@/lib/home";
import { getDownloads } from "@/lib/downloads";
import { OsCta } from "./client";
import { QuadFragment, SidebarFragment, WorkbenchFragment } from "./fragments";

export function Home({ locale }: { locale: Locale }) {
  const c = homeCopy(locale);
  const downloads = getDownloads(locale);
  const ko = locale === "ko";
  const dlPage = href(locale, "/download/");
  const docs = href(locale, "/docs/");

  return (
    <main id="main">
      {/* The claim, and the thing itself: two tiles, one approval waiting. */}
      <section className="hero wrap grid" aria-labelledby="hero-title">
        <h1 id="hero-title" className={ko ? "display display-ko" : "display"}>
          <span className="line"><span style={{ ["--i" as string]: 0 }}>{c.hero.line1}</span></span>
          <span className="line"><span style={{ ["--i" as string]: 1 }}>{c.hero.line2}</span></span>
        </h1>
        <div className="hero-copy">
          <p className="lead" data-rise style={{ ["--i" as string]: 0 }}>{c.hero.lead}</p>
          <div className="hero-actions" data-rise style={{ ["--i" as string]: 1 }}>
            <OsCta base={dlPage} labels={{ any: c.hero.cta, mac: c.hero.ctaMac, windows: c.hero.ctaWin, linux: c.hero.ctaLinux }} />
            <Link className="textlink" href={docs}>{c.hero.docs}</Link>
          </div>
        </div>
        <div className="hero-media">
          <WorkbenchFragment c={c.frag} />
        </div>
      </section>

      {/* Permissions: the live thing. Radios + :has() work without script. */}
      <section id="permissions" className="field-dark section" aria-labelledby="perm-title">
        <div className="wrap grid">
          <div className="perm-head" data-reveal>
            <h2 id="perm-title" className="head">{c.perm.title}</h2>
          </div>
          <div className="perm-statement" data-reveal><p>{c.perm.statement}</p></div>
          <div className="perm-live">
            <div className="perm-picker">
            <fieldset className="modes">
              <legend>{c.perm.legend}</legend>
              {c.perm.modes.map((m) => (
                <div className="mode" key={m.id}>
                  <input type="radio" name="perm-mode" id={`mode-${m.id}`} value={m.id} defaultChecked={m.id === "default"} />
                  <label htmlFor={`mode-${m.id}`}>{m.label}</label>
                </div>
              ))}
            </fieldset>
            <p className="mode-desc" aria-live="polite">
              {c.perm.modes.map((m) => (
                <span key={m.id} data-m={m.id}>{m.desc}</span>
              ))}
            </p>
            </div>
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
          <div className="perm-facts" data-reveal>
            {c.perm.facts.map((f) => (
              <div key={f.title}>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Workbench: four tiles beside the keys that drive them. */}
      <section id="workbench" className="section" aria-labelledby="wb-title">
        <div className="wrap grid">
          <div className="wb-media" data-reveal>
            <QuadFragment quad={c.wb.quad} title={c.frag.windowTitle} />
          </div>
          <div className="wb-copy" data-reveal>
            <h2 id="wb-title" className="head">{c.wb.title}</h2>
            <p className="body-measure">{c.wb.body}</p>
            <dl className="keys">
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

      {/* Models: the provider names are the picture. */}
      <section id="models" className="field-surface section" aria-labelledby="models-title">
        <div className="wrap grid">
          <div className="models-head" data-reveal>
            <h2 id="models-title" className="head">{c.models.title}</h2>
          </div>
          <div className="models-copy" data-reveal>
            <p>{c.models.body}</p>
            <p>{c.models.subs}</p>
          </div>
          <ul className="providers" data-reveal>
            {c.models.providers.map((p) => <li key={p}>{p}</li>)}
            {c.models.local.map((p) => <li key={p} className="local">{p}</li>)}
          </ul>
        </div>
      </section>

      {/* Plugins and marketplace: the links, the sources, the rules. */}
      <section id="plugins" className="section" aria-labelledby="plug-title">
        <div className="wrap grid">
          <div className="plug-head" data-reveal>
            <h2 id="plug-title" className="head">{c.plugins.title}</h2>
            <p className="body-measure">{c.plugins.body}</p>
          </div>
          <div className="plug-code" data-reveal>
            <pre className="codeblock"><code><span className="c">{c.plugins.codeComment1}</span>{"\n"}ave://marketplace/add?url=&lt;repository&gt;{"\n\n"}<span className="c">{c.plugins.codeComment2}</span>{"\n"}ave://install/plugin/&lt;name&gt;@&lt;source&gt;</code></pre>
            <p className="small muted">{c.plugins.codeNote}</p>
          </div>
          <table className="sources">
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
          <div className="plug-facts" data-reveal>
            {c.plugins.facts.map((f) => (
              <div key={f.title}>
                <h3>{f.title}</h3>
                <p className="body-measure">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Alongside: the chat list holds what runs beside you. */}
      <section id="alongside" className="field-surface section" aria-labelledby="side-title">
        <div className="wrap grid">
          <div className="side-head" data-reveal>
            <h2 id="side-title" className="head">{c.side.title}</h2>
          </div>
          <div className="side-media">
            <SidebarFragment s={c.side.sidebar} />
          </div>
          <div className="side-rows">
            {c.side.rows.map((r) => (
              <div key={r.title} data-reveal>
                <h3>{r.title}</h3>
                <p className="body-measure">{r.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Download: the close, on the accent field. */}
      <section id="download" className="field-lime section" aria-labelledby="dl-title">
        <div className="wrap grid">
          <div className="dl-head" data-reveal>
            <h2 id="dl-title" className="head">{c.dl.title}</h2>
            <p className="lead" style={{ marginTop: "1.25rem", maxWidth: "46ch" }}>{c.dl.lead}</p>
          </div>
          <ul className="dl-list">
            {downloads.map((d) => (
              <li key={d.os} className="dl-row">
                <span className="dl-os">{d.osLabel}</span>
                <span className="dl-meta">{d.title}, {d.format}</span>
                <a className="button" href={d.href} aria-label={`${d.osLabel} ${d.title} ${c.dl.get}`}>
                  {c.dl.get}
                </a>
              </li>
            ))}
          </ul>
          <div className="dl-after">
            <p>{c.dl.unsigned}</p>
            <Link className="textlink" href={dlPage}>{c.dl.guide}</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
