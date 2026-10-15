import { homeCopy } from "@/lib/home";
import { href, type Locale } from "@/lib/i18n";
import { more, page } from "@/lib/nav";
import { pagesCopy } from "@/lib/pages";
import { Bento, Facts, Points, SecHead } from "./blocks";
import { ChangelogTeaser } from "./changelog";
import { Footer, Header } from "./chrome";
import { KindIcon } from "./icons";
import { Frame, HeroLoop, PreloadShot } from "./media";

/**
 * The home page: hero with the product loop, the workbench beside its list of
 * facts, what agents work with, the three ways to connect a model, safety,
 * the extension kinds, the newest release, then download. Each section ends
 * with a link to the page that covers it in full.
 */
export function Home({ locale }: { locale: Locale }) {
  const c = homeCopy(locale);
  const reqs = pagesCopy(locale).download.requirements;
  const download = page(locale, "download");
  const path = "/";
  return (
    <>
      <PreloadShot k={c.hero.pic.k} />
      <Header locale={locale} path={path} />
      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="wrap">
            <div className="hero-copy">
              <p className="eyebrow">{c.hero.eyebrow}</p>
              <h1 id="hero-title" className="h1">{c.hero.title}</h1>
              <p className="lead">{c.hero.sub}</p>
              <div className="hero-ctas">
                <a className="btn btn-primary btn-lg" href={download.href}>{c.hero.download}</a>
                <a className="btn btn-ghost btn-lg" href={page(locale, "docs").href}>{c.hero.docs}</a>
              </div>
              <p className="hero-note">{c.hero.note}</p>
            </div>
            <div className="hero-media">
              <HeroLoop pic={c.hero.pic} label={c.hero.pic.alt} />
            </div>
          </div>
        </section>

        <section className="sec band" aria-labelledby="work">
          <div className="wrap">
            <div className="split">
              <Frame pic={c.work.pic} />
              <div className="split-text">
                <p className="eyebrow">{c.work.eyebrow}</p>
                <h2 id="work" className="h2">{c.work.title}</h2>
                <p className="lead">{c.work.body}</p>
                <Points points={c.work.points} />
              </div>
            </div>
          </div>
        </section>

        <section className="sec" aria-labelledby="surfaces">
          <div className="wrap">
            <Bento
              id="surfaces"
              block={c.surfaces}
              foot={
                <p className="hero-ctas">
                  <a className="more" href={more(locale, "browser").href}>{more(locale, "browser").label}</a>
                  <a className="more" href={more(locale, "terminal").href}>{more(locale, "terminal").label}</a>
                </p>
              }
            />
          </div>
        </section>

        <section className="sec band" aria-labelledby="models">
          <div className="wrap">
            <SecHead id="models" eyebrow={c.models.eyebrow} title={c.models.title} body={c.models.body} />
            <div className="split flip">
              <Frame pic={c.models.pic} />
              <div className="choices choices-stack">
                {c.models.ways.map((w) => (
                  <div key={w.tag} className="choice">
                    <p className="tag">{w.tag}</p>
                    <h3 className="h3">{w.title}</h3>
                    <p>{w.body}</p>
                  </div>
                ))}
              </div>
            </div>
            <p className="sec-foot">
              <a className="more" href={more(locale, "models").href}>{more(locale, "models").label}</a>
            </p>
          </div>
        </section>

        <section className="sec" aria-labelledby="safety">
          <div className="wrap">
            <Bento id="safety" block={c.safety} />
            <div className="sec-gap">
              <Facts items={c.safetyFacts} />
            </div>
            <p className="sec-foot">
              <a className="more" href={more(locale, "security").href}>{more(locale, "security").label}</a>
            </p>
          </div>
        </section>

        <section className="sec band" aria-labelledby="plugins">
          <div className="wrap">
            <SecHead id="plugins" eyebrow={c.plugins.eyebrow} title={c.plugins.title} body={c.plugins.body} />
            <ul className="kinds">
              {c.plugins.kinds.map((k, i) => (
                <li key={k.name} className="kind">
                  <KindIcon index={i} />
                  <b>{k.name}</b>
                  <span>{k.body}</span>
                </li>
              ))}
            </ul>
            <figure className="figure plugins-shot">
              <Frame pic={c.plugins.pic} />
              <figcaption>{c.plugins.cap}</figcaption>
            </figure>
            <p className="sec-foot">
              <a className="more" href={more(locale, "plugins").href}>{more(locale, "plugins").label}</a>
            </p>
          </div>
        </section>

        <section className="sec" aria-labelledby="changes">
          <div className="wrap">
            <ChangelogTeaser locale={locale} eyebrow={c.changes.eyebrow} title={c.changes.title} body={c.changes.body} />
          </div>
        </section>

        <section className="sec band" id="download" aria-labelledby="get">
          <div className="wrap">
            <SecHead id="get" eyebrow={c.get.eyebrow} title={c.get.title} body={c.get.body} />
            <Facts items={reqs} />
            <p className="sec-foot">
              <a className="btn btn-primary btn-lg" href={href(locale, "/download/")}>{c.get.cta}</a>
            </p>
          </div>
        </section>
      </main>
      <Footer locale={locale} path={path} />
    </>
  );
}
