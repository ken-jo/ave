import { releases, type ChangeBlock, type Inline, type ListItem, type Release } from "@/lib/changelog";
import { englishRelease, staleEnglishNotes } from "@/lib/changelog-en";
import type { Locale } from "@/lib/i18n";
import { pagesCopy } from "@/lib/pages";

function Text({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.t === "text") return p.v;
        if (p.t === "code") return <code key={i}>{p.v}</code>;
        if (p.t === "strong") return <strong key={i}><Text parts={p.c} /></strong>;
        return <em key={i}><Text parts={p.c} /></em>;
      })}
    </>
  );
}

function List({ items }: { items: ListItem[] }) {
  return (
    <ul>
      {items.map((it, i) => (
        <li key={i}>
          <Text parts={it.text} />
          {it.children.length ? <List items={it.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

function Block({ b }: { b: ChangeBlock }) {
  switch (b.kind) {
    case "h3":
      return <h3><Text parts={b.text} /></h3>;
    case "p":
      return <p><Text parts={b.text} /></p>;
    case "quote":
      return <blockquote><Text parts={b.text} /></blockquote>;
    case "code":
      return <pre><code>{b.text}</code></pre>;
    case "list":
      return <List items={b.items} />;
  }
}

/** One release in English: a bullet per item, its headline in bold and its points beneath. */
function EnglishBody({ r }: { r: Release }) {
  const { items } = englishRelease(r);
  return (
    <ul className="cl-items">
      {items.map((it, i) => (
        <li key={i}>
          <strong>
            <Text parts={it.title} />
          </strong>
          <ul>
            {it.points.map((p, j) => (
              <li key={j}>
                <Text parts={p} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function ReleaseEntry({ r, locale }: { r: Release; locale: Locale }) {
  return (
    <section className="cl-version" id={r.id} aria-labelledby={`h-${r.id}`}>
      <div>
        <h2 id={`h-${r.id}`}>{r.name}</h2>
        <p className="cl-date">{r.date}</p>
      </div>
      <div className="cl-body">
        {locale === "en" ? <EnglishBody r={r} /> : r.blocks.map((b, i) => <Block key={i} b={b} />)}
      </div>
    </section>
  );
}

export function ChangelogPage({ locale }: { locale: Locale }) {
  const c = pagesCopy(locale).changelog;
  const all = releases();
  const stale = staleEnglishNotes(all.map((r) => r.name));
  if (stale.length) throw new Error(`lib/changelog-en.ts has notes for releases CHANGELOG.md does not list: ${stale.join(", ")}`);
  return (
    <main id="main">
      <section className="hero" aria-labelledby="title">
        <div className="wrap hero-copy">
          <h1 id="title" className="h1">{c.title}</h1>
          <p className="lead">{c.lead}</p>
          {c.note ? <p className="hero-note">{c.note}</p> : null}
        </div>
      </section>
      <div className="wrap">
        {all.map((r) => (
          <ReleaseEntry key={r.id} r={r} locale={locale} />
        ))}
      </div>
    </main>
  );
}
