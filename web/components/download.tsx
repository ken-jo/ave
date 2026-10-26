import { getDownloads, RELEASE_PUBLISHED } from "@/lib/downloads";
import type { Locale } from "@/lib/i18n";
import { doc, page, PATHS } from "@/lib/nav";
import { pagesCopy } from "@/lib/pages";
import { Command, Points } from "./blocks";
import { Footer, Header } from "./chrome";
import { DownloadGlyph } from "./icons";
import { Frame } from "./media";

/**
 * Download, in the home page's Greeting system: a dawn-lit inset card with the
 * title, and the three systems rising out of it as cards, each with its
 * installer (or, before the first published release, the "release in
 * preparation" state), what it needs, and the first-launch steps. Then what to
 * do after installing, leading on to the start guide.
 */
export function DownloadView({ locale }: { locale: Locale }) {
  const c = pagesCopy(locale).download;
  const path = PATHS.download;
  const changelog = page(locale, "changelog");
  const start = doc(locale, "start");
  const needs = new Map(c.requirements.map((r) => [r.title, r.body]));
  return (
    <>
      <Header locale={locale} path={path} />
      <main id="main">
        <section className="dl-hero" aria-labelledby="title">
          <div className="dl-card-bg">
            <div className="dl-copy">
              <h1 id="title" className="hello-title">
                {c.title}
              </h1>
              <p className="hello-sub">{c.lead}</p>
            </div>
            <div className="dl-cards">
              {getDownloads(locale).map((d) => (
                <article key={d.os} id={d.os} className="dl-card" aria-labelledby={`os-${d.os}`}>
                  <div className="dl-head">
                    <h2 id={`os-${d.os}`} className="h2">
                      {d.osLabel}
                    </h2>
                    <p className="dl-format">
                      {d.title} · {d.format}
                    </p>
                  </div>
                  {needs.get(d.osLabel) ? <p className="dl-needs">{needs.get(d.osLabel)}</p> : null}
                  {RELEASE_PUBLISHED ? (
                    <a className="btn btn-primary btn-lg dl-get" href={d.href} aria-label={`${d.osLabel} ${c.get}`}>
                      <DownloadGlyph />
                      {c.get}
                    </a>
                  ) : (
                    <div className="dl-state">
                      <strong>{c.pending}</strong>
                      <p>{c.pendingNote}</p>
                      <a className="more" href={changelog.href}>
                        {changelog.label}
                      </a>
                    </div>
                  )}
                  <h3 className="h3">{c.setup}</h3>
                  <p className="note">{d.setupNote}</p>
                  <ol className="steps">
                    {d.steps.map((s) => (
                      <li key={s.label}>
                        <span>{s.label}</span>
                        {s.command ? <Command text={s.command} locale={locale} /> : null}
                      </li>
                    ))}
                  </ol>
                  {d.extraNote ? <p className="note">{d.extraNote}</p> : null}
                </article>
              ))}
            </div>
          </div>
        </section>
        <section className="sec" aria-labelledby="after">
          <div className="wrap">
            <div className="center-head">
              <p className="eyebrow">{c.after.eyebrow}</p>
              <h2 id="after" className="h2">
                {c.after.title}
              </h2>
              <p className="lead">{c.after.body}</p>
            </div>
            <div className="after-grid">
              <div className="work-stage">
                <Frame pic={c.after.pic} />
              </div>
              <div className="split-text">
                <Points points={c.after.points} />
                <p>{c.after.start}</p>
                <p>
                  <a className="more" href={start.href}>
                    {start.label}
                  </a>
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer locale={locale} path={path} />
    </>
  );
}
