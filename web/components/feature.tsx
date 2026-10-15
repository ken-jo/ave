import { featurePage } from "@/lib/features";
import type { Locale } from "@/lib/i18n";
import { doc, FEATURE_DOC, nextAfter, page, PATHS, type Feature, type NavLink } from "@/lib/nav";
import { Bento, Facts, Faqs, NextSteps, Split } from "./blocks";
import { Footer, Header } from "./chrome";
import { Frame, PreloadShot } from "./media";

/**
 * One feature page: hero shot, a split, a bento of real crops, an optional
 * second split (or the three ways to connect, on Models), questions, and the
 * next steps: the guide, the next feature, Download.
 */
export function FeatureView({ locale, feature }: { locale: Locale; feature: Feature }) {
  const c = featurePage(locale, feature);
  const path = PATHS[feature];
  const following = nextAfter(feature);
  const nextItems: { link: NavLink; body: string }[] = [{ link: doc(locale, FEATURE_DOC[feature]), body: c.next.doc }];
  if (following !== "download") nextItems.push({ link: page(locale, following), body: c.next.feature });
  nextItems.push({ link: page(locale, "download"), body: c.next.download });
  return (
    <>
      <PreloadShot k={c.hero.pic.k} />
      <Header locale={locale} path={path} />
      <main id="main">
        <section className="hero" aria-labelledby="title">
          <div className="wrap">
            <div className="hero-copy">
              <p className="eyebrow">{c.hero.eyebrow}</p>
              <h1 id="title" className="h1">{c.hero.title}</h1>
              <p className="lead">{c.hero.lead}</p>
            </div>
            <div className="hero-media">
              <Frame pic={c.hero.pic} priority />
            </div>
          </div>
        </section>

        {c.ways ? (
          <section className="sec band" aria-labelledby="ways">
            <div className="wrap">
              <div className="sec-head">
                <h2 id="ways" className="h2">{c.ways.title}</h2>
                <p className="lead">{c.ways.body}</p>
              </div>
              <div className="choices">
                {c.ways.items.map((w) => (
                  <div key={w.tag} className="choice">
                    <p className="tag">{w.tag}</p>
                    <h3 className="h3">{w.title}</h3>
                    <ul>
                      {w.points.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        <section className={c.ways ? "sec" : "sec band"} aria-labelledby="first">
          <div className="wrap">
            <Split id="first" block={c.first} />
          </div>
        </section>

        <section className={c.ways ? "sec band" : "sec"} aria-labelledby="grid">
          <div className="wrap">
            <Bento id="grid" block={c.grid} />
          </div>
        </section>

        {c.facts ? (
          <section className="sec" aria-labelledby="facts">
            <div className="wrap">
              <Facts id="facts" title={c.facts.title} items={c.facts.items} />
            </div>
          </section>
        ) : null}

        {c.second ? (
          <section className="sec band" aria-labelledby="second">
            <div className="wrap">
              <Split id="second" block={c.second} />
            </div>
          </section>
        ) : null}

        <section className="sec" aria-labelledby="faq">
          <div className="wrap">
            <Faqs id="faq" title={c.faqTitle} faqs={c.faqs} />
          </div>
        </section>

        <section className="sec band" aria-labelledby="next">
          <div className="wrap">
            <NextSteps id="next" title={locale === "ko" ? "이어서 읽기" : "Read on"} items={nextItems} path={path} />
          </div>
        </section>
      </main>
      <Footer locale={locale} path={path} />
    </>
  );
}
