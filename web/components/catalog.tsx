import type { FeaturePage } from "@/lib/features";
import type { Locale } from "@/lib/i18n";
import { CATALOG, countOf, KINDS, packagesOf, TOTAL } from "@/lib/marketplace";
import { providers, type Provider } from "@/lib/providers";
import { Points, SecHead } from "./blocks";

/** Models page: every provider in the app's provider list, built in first, then provider packages. */
export function ProviderList({ locale, copy }: { locale: Locale; copy: NonNullable<FeaturePage["providers"]> }) {
  const all = providers(locale);
  const groups: { title: string; list: Provider[] }[] = [
    { title: copy.builtIn, list: all.filter((p) => p.builtIn) },
    { title: copy.packages, list: all.filter((p) => !p.builtIn) },
  ];
  return (
    <>
      <SecHead id="providers" eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />
      <div className="prov-groups">
        {groups.map((g) => (
          <section key={g.title} className="prov-group" aria-label={g.title}>
            <h3 className="h3">
              {g.title} <span className="prov-count">{g.list.length}</span>
            </h3>
            <ul className="prov-list">
              {g.list.map((p) => (
                <li key={p.id}>
                  <b>{p.name}</b>
                  {p.host ? <code>{p.host}</code> : null}
                  <span className="prov-tags">
                    {p.gateway ? <span>{copy.tags.gateway}</span> : null}
                    {p.keyOptional ? <span>{copy.tags.noKey}</span> : null}
                    {!p.builtIn ? <span>{p.pkg ? copy.tags.pkg(p.pkg.version) : copy.tags.notListed}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

const KIND_ORDER = ["plugin", "agent-plugin", "mcp", "skill", "agent", "provider", "theme", "language"];

/** Plugins page: the official catalog by kind, with the names of a few packages of each. */
export function CatalogSection({ copy }: { copy: NonNullable<FeaturePage["catalog"]> }) {
  const known = new Set(KIND_ORDER);
  const unordered = [...KINDS, ...Object.keys(copy.kinds)].filter((k) => !known.has(k));
  if (unordered.length) throw new Error(`catalog kinds missing from KIND_ORDER: ${unordered.join(", ")}`);
  return (
    <>
      <SecHead id="catalog" eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />
      <p className="cat-meta">{copy.meta(TOTAL, CATALOG.commit.slice(0, 12))}</p>
      <ul className="cat-kinds">
        {KIND_ORDER.filter((k) => countOf(k) > 0).map((k) => {
          const label = copy.kinds[k];
          if (!label) throw new Error(`no label for catalog kind ${k}`);
          const names = packagesOf(k).slice(0, 4).map((p) => p.displayName);
          const rest = countOf(k) - names.length;
          return (
            <li key={k} className="cat-kind">
              <p className="cat-count">{countOf(k)}</p>
              <h3 className="h3">{label}</h3>
              <p className="cat-names">
                {names.join(" · ")}
                {rest > 0 ? ` ${copy.more(rest)}` : ""}
              </p>
            </li>
          );
        })}
      </ul>
      <div className="sec-gap">
        <Points points={copy.points} />
      </div>
    </>
  );
}
