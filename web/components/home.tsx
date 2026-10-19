import { featurePage } from "@/lib/features";
import { homeCopy } from "@/lib/home";
import { href, type Locale } from "@/lib/i18n";
import { FEATURES, more, page } from "@/lib/nav";
import { pagesCopy } from "@/lib/pages";
import { Bento, Facts, Points, SecHead } from "./blocks";
import { ChangelogTeaser } from "./changelog";
import { Footer, Header } from "./chrome";
import { KindIcon } from "./icons";
import { Frame, HeroLoop, PreloadShot } from "./media";
import { MotionRoot, Reveal, RevealItem } from "./motion";
import { Tour, type TourStep } from "./tour";

/**
 * The home page: hero with the product loop, the feature tour (one step per
 * feature page, from that page's hero), the workbench beside its list of
 * facts, what agents work with, the three ways to connect a model, safety,
 * the extension kinds, the newest release, then download. Each section ends
 * with a link to the page that covers it in full.
 */
export function Home({ locale }: { locale: Locale }) {
  const c = homeCopy(locale);
  const reqs = pagesCopy(locale).download.requirements;
  const download = page(locale, "download");
  const path = "/";
  const tour: TourStep[] = FEATURES.map((f) => {
    const { eyebrow, title, lead, pic } = featurePage(locale, f).hero;
    const link = more(locale, f);
    return { id: f, eyebrow, title, lead, pic, more: { href: link.href, label: link.label } };
  });
  return (
    <>
      <PreloadShot k={c.hero.pic.k} />
      <Header locale={locale} path={path} />
      <main id="main">
        <MotionRoot>
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

        <section className="sec band tour-sec" aria-labelledby="tour">
          <Reveal className="wrap">
            <SecHead Item={RevealItem} id="tour" eyebrow={c.tour.eyebrow} title={c.tour.title} body={c.tour.body} />
          </Reveal>
          <div className="wrap">
            <Tour steps={tour} label={c.tour.label} />
          </div>
        </section>

        <section className="sec" aria-labelledby="work">
          <Reveal className="wrap">
            <div className="split">
              <RevealItem>
                <Frame pic={c.work.pic} />
              </RevealItem>
              <RevealItem className="split-text">
                <p className="eyebrow">{c.work.eyebrow}</p>
                <h2 id="work" className="h2">{c.work.title}</h2>
                <p className="lead">{c.work.body}</p>
                <Points points={c.work.points} />
              </RevealItem>
            </div>
          </Reveal>
        </section>

        <section className="sec band" aria-labelledby="surfaces">
          <Reveal className="wrap">
            <Bento
              Item={RevealItem}
              id="surfaces"
              block={c.surfaces}
              foot={
                <p className="hero-ctas">
                  <a className="more" href={more(locale, "browser").href}>{more(locale, "browser").label}</a>
                  <a className="more" href={more(locale, "terminal").href}>{more(locale, "terminal").label}</a>
                </p>
              }
            />
          </Reveal>
        </section>

        <section className="sec" aria-labelledby="models">
          <Reveal className="wrap">
            <SecHead Item={RevealItem} id="models" eyebrow={c.models.eyebrow} title={c.models.title} body={c.models.body} />
            <div className="split flip">
              <RevealItem>
                <Frame pic={c.models.pic} />
              </RevealItem>
              <div className="choices choices-stack">
                {c.models.ways.map((w) => (
                  <RevealItem key={w.tag} className="choice">
                    <p className="tag">{w.tag}</p>
                    <h3 className="h3">{w.title}</h3>
                    <p>{w.body}</p>
                  </RevealItem>
                ))}
              </div>
            </div>
            <p className="sec-foot">
              <a className="more" href={more(locale, "models").href}>{more(locale, "models").label}</a>
            </p>
          </Reveal>
        </section>

        <section className="sec band" aria-labelledby="safety">
          <Reveal className="wrap">
            <Bento Item={RevealItem} id="safety" block={c.safety} />
            <div className="sec-gap">
              <Facts Item={RevealItem} items={c.safetyFacts} />
            </div>
            <p className="sec-foot">
              <a className="more" href={more(locale, "security").href}>{more(locale, "security").label}</a>
            </p>
          </Reveal>
        </section>

        <section className="sec" aria-labelledby="plugins">
          <Reveal className="wrap">
            <SecHead Item={RevealItem} id="plugins" eyebrow={c.plugins.eyebrow} title={c.plugins.title} body={c.plugins.body} />
            <ul className="kinds">
              {c.plugins.kinds.map((k, i) => (
                <RevealItem as="li" key={k.name} className="kind">
                  <KindIcon index={i} />
                  <b>{k.name}</b>
                  <span>{k.body}</span>
                </RevealItem>
              ))}
            </ul>
            <RevealItem>
              <figure className="figure plugins-shot">
                <Frame pic={c.plugins.pic} />
                <figcaption>{c.plugins.cap}</figcaption>
              </figure>
            </RevealItem>
            <p className="sec-foot">
              <a className="more" href={more(locale, "plugins").href}>{more(locale, "plugins").label}</a>
            </p>
          </Reveal>
        </section>

        <section className="sec band" aria-labelledby="changes">
          <Reveal className="wrap">
            <RevealItem>
              <ChangelogTeaser locale={locale} eyebrow={c.changes.eyebrow} title={c.changes.title} body={c.changes.body} />
            </RevealItem>
          </Reveal>
        </section>

        <section className="sec" id="download" aria-labelledby="get">
          <Reveal className="wrap">
            <SecHead Item={RevealItem} id="get" eyebrow={c.get.eyebrow} title={c.get.title} body={c.get.body} />
            <Facts Item={RevealItem} items={reqs} />
            <p className="sec-foot">
              <a className="btn btn-primary btn-lg" href={href(locale, "/download/")}>{c.get.cta}</a>
            </p>
          </Reveal>
        </section>
        </MotionRoot>
      </main>
      <Footer locale={locale} path={path} />
    </>
  );
}
