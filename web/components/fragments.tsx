import type { HomeCopy } from "@/lib/home";

/**
 * Cropped fragments of Ave's own interface, built in HTML at true size.
 * `data-ui` marks them: inside, the app's conventions (hairlines, small
 * radii, a window shadow) apply instead of the page's.
 */

export function WorkbenchFragment({ c }: { c: HomeCopy["frag"] }) {
  const a = c.tileA;
  const b = c.tileB;
  return (
    <div data-ui aria-hidden="true">
      <div className="win">
        <div className="win-bar">
          <span className="dots"><i /><i /><i /></span>
          <span className="win-title">Ave</span>
          <span className="badge">
            <span className="chip">{c.mode}</span>
            <span className="chip chip-warn">{c.pending}</span>
          </span>
        </div>
        <div className="tiles">
          <section className="tile focused">
            <div className="tile-head">
              <span>{a.title}</span>
              <span className="tile-ctl">⋯</span>
            </div>
            <div className="msgs">
              <div className="msg-user">{a.user}</div>
              <div className="tool">
                <code>{a.toolRead}</code>
                <span className="ok">{a.toolReadResult}</span>
              </div>
              <div className="msg-ai"><span className="stream">{a.ai}</span></div>
            </div>
            <div className="dock">
              <div className="dock-title">{a.dockTitle}</div>
              <div className="dock-meta">
                <span className="chip">{a.dockPath}</span>
                <span className="chip">{a.kind}</span>
                <span className="chip chip-warn">{a.risk}</span>
              </div>
              <div className="dock-actions">
                <span className="ui-btn">{a.reject}</span>
                <span className="ui-btn">{a.always}</span>
                <span className="ui-btn ui-btn-primary">{a.once}</span>
              </div>
            </div>
          </section>
          <section className="tile secondary">
            <div className="tile-head">
              <span>{b.title}</span>
              <span className="tile-ctl">⋯</span>
            </div>
            <div className="msgs">
              <div className="msg-user">{b.user}</div>
              <div className="tool">
                <code>{b.toolShell}</code>
                <span className="run">{b.running}</span>
              </div>
              <div className="msg-ai">
                <span className="caret" />
              </div>
              <div className="queued">
                <b>{b.queuedLabel}</b>
                {b.queued}
              </div>
            </div>
            <div className="composer">{c.composer}</div>
          </section>
        </div>
        <div className="status">
          <span>{c.model}</span>
          <span className="push">⌘ Enter</span>
        </div>
      </div>
    </div>
  );
}

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
