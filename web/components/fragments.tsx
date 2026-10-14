import type { HomeCopy } from "@/lib/home";
import type { DownloadTarget } from "@/lib/downloads";

/**
 * Cropped fragments of Ave's own interface, built in HTML at true size.
 * `data-ui` marks them: inside, the app's conventions (hairlines, small
 * radii, a window shadow) apply instead of the page's.
 */

export function QuadFragment({ quad, title }: { quad: HomeCopy["wb"]["quad"]; title: string }) {
  return (
    <div data-ui aria-hidden="true">
      <div className="win">
        <div className="win-bar">
          <span className="dots"><i /><i /><i /></span>
          <span className="win-title">{title}</span>
        </div>
        <div className="quad">
          {quad.map((q, i) => (
            <div key={q.title} className={i === 1 ? "q focused" : "q"}>
              <div className="q-title">
                <span>{q.title}</span>
                <span className={q.tone === "warn" ? "chip chip-warn" : q.tone === "go" ? "chip chip-go" : "chip"}>{q.state}</span>
              </div>
              <div className="q-line"><code>{q.line}</code></div>
              <p className="q-body">
                {q.excerpt}
                {i === 1 ? <span className="caret" /> : null}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SidebarFragment({ s }: { s: HomeCopy["side"]["sidebar"] }) {
  const today = s.items.slice(0, 5);
  const earlier = s.items.slice(5);
  const row = (it: (typeof s.items)[number]) => (
    <div key={it.label} className={["row", it.on ? "on" : "", it.child ? "child" : ""].join(" ").trim()}>
      <span className={it.mark} />
      <span>{it.label}</span>
      <span className="when">{it.when}</span>
    </div>
  );
  return (
    <div data-ui aria-hidden="true">
      <div className="win">
        <div className="sidebar">
          <div className="side-tabs">
            <span className="on">{s.chats}</span>
            <span>{s.projects}</span>
          </div>
          <div className="side-group">{s.today}</div>
          {today.map(row)}
          <div className="side-group">{s.earlier}</div>
          {earlier.map(row)}
        </div>
      </div>
    </div>
  );
}

/**
 * The first-launch steps of one system as a small window: the installer's
 * name, then each step and its command, exactly as the setup section lists
 * them (web/DESIGN.md 19, 29).
 */
export function InstallFragment({ d }: { d: DownloadTarget }) {
  const file = d.href.slice(d.href.lastIndexOf("/") + 1);
  return (
    <div data-ui aria-hidden="true">
      <div className="win">
        <div className="win-bar">
          <span className="dots"><i /><i /><i /></span>
          <span className="win-title">{d.osLabel}</span>
          <span className="badge"><span className="chip">{d.format}</span></span>
        </div>
        <div className="install">
          <code className="install-file">{file}</code>
          <ol>
            {d.steps.map((s) => (
              <li key={s.label}>
                <span>{s.label}</span>
                {s.command ? <code>{s.command}</code> : null}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
