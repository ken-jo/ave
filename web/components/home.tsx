import { homeCopy, type Section } from "@/lib/home";
import type { Locale } from "@/lib/i18n";
import { pkg } from "@/lib/marketplace";
import { doc, more, page, type NavLink } from "@/lib/nav";
import { Footer, Header } from "./chrome";
import { FilesTab, HelloStage } from "./hello";
import { DownloadGlyph } from "./icons";
import { Frame } from "./media";

/**
 * The home page, "Greeting", paced like a product page: the hello card (main
 * line, the Latin-hello line, a built Ave workspace that performs the
 * trail-notes session), five sections for what "everything" means (the web,
 * the terminal, files, models, connectors and plugins), each one headline,
 * one or two sentences, one visual and the link to the page that covers it,
 * then a dark closing card. Details live on the feature pages and the guide.
 */
export function Home({ locale }: { locale: Locale }) {
  const c = homeCopy(locale);
  const download = page(locale, "download");
  const docs = page(locale, "docs");
  const path = "/";
  const links: Record<Section["id"], NavLink> = {
    web: more(locale, "browser"),
    terminal: more(locale, "terminal"),
    files: doc(locale, "workbench"),
    models: more(locale, "models"),
    connect: more(locale, "plugins"),
  };
  return (
    <>
      <Header locale={locale} path={path} />
      <main id="main">
        <section className="hello" aria-labelledby="hero-title">
          <div className="hello-card">
            <div className="hello-copy">
              <h1 id="hero-title" className="hello-title">
                {c.hero.title}
              </h1>
              <p className="hello-sub">{c.hero.sub}</p>
              <p className="hello-ctas">
                <a className="btn btn-primary btn-lg" href={download.href}>
                  <DownloadGlyph />
                  {c.hero.download}
                </a>
                <a className="btn btn-ghost btn-lg" href={docs.href}>
                  {c.hero.docs}
                </a>
              </p>
              <p className="hello-note">{c.hero.note}</p>
            </div>
            <HelloStage demo={c.hero.demo} />
          </div>
        </section>

        {c.sections.map((s, i) => (
          <section key={s.id} className={`sec home-sec home-sec-${s.id}`} aria-labelledby={`sec-${s.id}`}>
            <div className={`wrap home-row${i % 2 ? " flip" : ""}`}>
              <div className="home-text">
                <h2 id={`sec-${s.id}`} className="h2">
                  {s.title}
                </h2>
                <p className="lead">{s.body}</p>
                {s.id === "connect" ? <Connectors locale={locale} /> : null}
                <p>
                  <a className="more" href={links[s.id].href}>
                    {links[s.id].label}
                  </a>
                </p>
              </div>
              <div className={`home-stage stage-${s.id}`}>{s.pic === "files" ? <FilesFragment locale={locale} /> : <Frame pic={s.pic} />}</div>
            </div>
          </section>
        ))}

        {/* id="download": the app's unsigned-build update guide opens the site root, and this is where its download is. */}
        <section className="closing" id="download" aria-labelledby="say-hello">
          <div className="closing-card">
            <h2 id="say-hello">
              {c.close.before}
              <span>{c.close.hello}</span>
              {c.close.after}
            </h2>
            <p>{c.close.body}</p>
            <a className="btn btn-lg btn-light" href={download.href}>
              <DownloadGlyph />
              {c.close.cta}
            </a>
            <p className="closing-note">{c.close.note}</p>
          </div>
        </section>
      </main>
      <Footer locale={locale} path={path} />
    </>
  );
}

/** Section 5's names, each one a package in the catalog snapshot (pkg() fails the build otherwise). */
function Connectors({ locale }: { locale: Locale }) {
  const c = homeCopy(locale).connectors;
  return (
    <ul className="chips" aria-label={c.label}>
      {[...c.mcp, ...c.plugins].map((name) => (
        <li key={name} data-kind={pkg(name).kind}>
          {pkg(name).displayName}
        </li>
      ))}
    </ul>
  );
}

/**
 * The work panel's Files tab, built at fidelity because no capture of it
 * exists yet (web/DESIGN.md, "Built fragments"): the session's files with
 * what was done to each, and the captures' change opened below it.
 */
function FilesFragment({ locale }: { locale: Locale }) {
  const label =
    locale === "ko"
      ? "작업 패널의 파일 탭: 세션의 파일 src/export.js에 읽음과 씀이 표시되고, 아래에 추가된 json 분기 줄이 강조된 모습"
      : "The work panel's Files tab: the session's file src/export.js marked Read and Written, with the added json case highlighted below";
  return (
    <div className="files-window" role="img" aria-label={label}>
      <div className="hw-tabs" aria-hidden="true">
        <span data-on="">Files</span>
        <span>Preview</span>
        <span>Browser</span>
        <span>Terminal</span>
      </div>
      <div className="files-body" aria-hidden="true">
        <FilesTab />
      </div>
    </div>
  );
}
