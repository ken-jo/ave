import { getDownloads, RELEASE_PUBLISHED } from "@/lib/downloads";
import type { Locale } from "@/lib/i18n";
import { doc, page, PATHS } from "@/lib/nav";
import { pagesCopy } from "@/lib/pages";
import { Command, Points } from "./blocks";
import { Footer, Header } from "./chrome";
import { Frame } from "./media";

/**
 * Download: one card per system with its installer (or, before the first
 * published release, the "release in preparation" state) and the first-launch
 * steps, then what to do after installing, leading on to the start guide.
 */
export function DownloadView({ locale }: { locale: Locale }) {
  const c = pagesCopy(locale).download;
  const path = PATHS.download;
  const changelog = page(locale, "changelog");
  const start = doc(locale, "start");
  return (
    <>
      <Header locale={locale} path={path} />
      <main id="main">
        <section className="hero" aria-labelledby="title">
          <div className="wrap hero-copy">
            <h1 id="title" className="h1">{c.title}</h1>
            <p className="lead">{c.lead}</p>
          </div>
        </section>
        <section className="sec band" aria-label={c.setup}>
          <div className="wrap">
            <div className="dl-cards">
              {getDownloads(locale).map((d) => (
                <article key={d.os} id={d.os} className="dl-card" aria-labelledby={`os-${d.os}`}>
                  <h2 id={`os-${d.os}`} className="h2">{d.osLabel}</h2>
                  <p className="dl-format">
                    {d.title} · {d.format}
                  </p>
                  {RELEASE_PUBLISHED ? (
                    <a className="btn btn-primary" href={d.href} aria-label={`${d.osLabel} ${c.get}`}>
                      {c.get}
                    </a>
                  ) : (
                    <div className="dl-state">
                      <strong>{c.pending}</strong>
                      <p>{c.pendingNote}</p>
                      <a className="more" href={changelog.href}>{changelog.label}</a>
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
            <div className="split">
              <Frame pic={c.after.pic} />
              <div className="split-text">
                <p className="eyebrow">{c.after.eyebrow}</p>
                <h2 id="after" className="h2">{c.after.title}</h2>
                <p className="lead">{c.after.body}</p>
                <Points points={c.after.points} />
                <p>{c.after.start}</p>
                <p>
                  <a className="more" href={start.href}>{start.label}</a>
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
