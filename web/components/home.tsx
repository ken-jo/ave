import { homeCopy, type Tile } from "@/lib/home";
import type { Locale } from "@/lib/i18n";
import { doc, more, page } from "@/lib/nav";
import { Footer, Header } from "./chrome";
import { HelloStage, Statement } from "./hello";
import { DownloadGlyph } from "./icons";
import { Crop, Frame } from "./media";

/**
 * The home page, "Greeting": a dawn-lit inset card with the brand line (Ave
 * means hello) above a built Ave workspace that performs the trail-notes
 * session; the AWE statement, sharpened word by word; the workbench capture;
 * six tiles for what the agent works with and the settings around it, each
 * leading to the page that covers it; and a dark closing card. Details live on
 * the feature pages and the guide; the home page only points at them.
 */
export function Home({ locale }: { locale: Locale }) {
  const c = homeCopy(locale);
  const download = page(locale, "download");
  const docs = page(locale, "docs");
  const workbench = doc(locale, "workbench");
  const path = "/";
  return (
    <>
      <Header locale={locale} path={path} />
      <main id="main">
        <section className="hello" aria-labelledby="hero-title">
          <div className="hello-card">
            <div className="hello-copy">
              <h1 id="hero-title" className="hello-title">
                {c.hero.title}
                <span className="dim">{c.hero.dim}</span>
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

        <section className="statement-sec" aria-label="AWE">
          <div className="wrap">
            <Statement text={c.statement} />
          </div>
        </section>

        <section className="sec work-sec" aria-labelledby="work">
          <div className="wrap">
            <div className="center-head">
              <p className="eyebrow">{c.work.eyebrow}</p>
              <h2 id="work" className="h2">
                {c.work.title}
              </h2>
              <p className="lead">{c.work.body}</p>
            </div>
            <div className="work-stage">
              <Frame pic={c.work.pic} />
            </div>
            <p className="center-foot">
              <a className="more" href={workbench.href}>
                {workbench.label}
              </a>
            </p>
          </div>
        </section>

        <section className="sec hands" aria-labelledby="hands">
          <div className="wrap">
            <div className="center-head">
              <h2 id="hands" className="h2">
                {c.hands.title}
              </h2>
              <p className="lead">{c.hands.body}</p>
            </div>
            <ul className="tiles">
              {c.hands.tiles.map((t) => (
                <TileCard key={t.title} tile={t} locale={locale} />
              ))}
            </ul>
          </div>
        </section>

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
          </div>
        </section>
      </main>
      <Footer locale={locale} path={path} />
    </>
  );
}

function TileCard({ tile, locale }: { tile: Tile; locale: Locale }) {
  const link = tile.feature ? more(locale, tile.feature) : doc(locale, "workbench");
  return (
    <li className="tile">
      <div className="tile-text">
        <h3 className="h3">{tile.title}</h3>
        <p>{tile.body}</p>
        <a className="more" href={link.href}>
          {link.label}
        </a>
      </div>
      {tile.pic === "files" ? (
        <FilesFragment locale={locale} />
      ) : (
        <div className="tile-window">
          <Crop pic={tile.pic} crop={tile.crop ?? [100, 0, 0]} />
        </div>
      )}
    </li>
  );
}

/**
 * The work panel's Files tab, built at fidelity because no capture of it
 * exists yet (web/DESIGN.md, "Built fragments"). It shows the same change as
 * the captures: the json case added to src/export.js.
 */
function FilesFragment({ locale }: { locale: Locale }) {
  const label = locale === "ko" ? "파일 탭: src/export.js에 추가된 json 분기 줄이 강조된 모습" : "The Files tab: src/export.js with the added json case highlighted";
  return (
    <div className="tile-window files-frag" role="img" aria-label={label}>
      <ul aria-hidden="true">
        <li>src/</li>
        <li data-sel="">export.js</li>
        <li>parse.js</li>
        <li>test/</li>
        <li>package.json</li>
      </ul>
      <pre aria-hidden="true">
        {'switch (format) {\n  case "csv": return toCsv(trails);\n  case "md": return toTable(trails);\n'}
        <span className="hw-add" data-on="">
          {'  case "json": return JSON.stringify(trails);'}
        </span>
        {"}"}
      </pre>
    </div>
  );
}
