"use client";

import { useEffect, useRef } from "react";
import type { HelloDemo, Said } from "@/lib/home";

/**
 * The home hero's built workspace.
 *
 * It is rendered finished on the server: without script, and with reduced
 * motion, the reader gets the whole conversation. With motion allowed, script
 * rewinds it and plays it while it is on screen: the trail-notes session from
 * hello to the tests passing. The work panel opens the way the app opens it,
 * from the panel button in the tile header, docked beside the transcript when
 * there is room and floating over it inside the tile when there is not (one
 * responsive shell; the app has no chat and work modes). Script touches the
 * DOM only through refs and never re-renders, so React and the timeline never
 * fight over the same nodes.
 *
 * The UI labels are the app's own English strings (src/i18n/messages) and its
 * tool display names (src/ui/renderer/utils/tool-display.ts), as in the
 * captures; the scenario is the captures' trail-notes scenario.
 */

const STILL = "(prefers-reduced-motion: reduce)";

/** Text between backticks becomes code. */
function Text({ s }: { s: Said }) {
  return (
    <>
      {s.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}
    </>
  );
}
const plain = (s: Said) => s.split("`").join("");

type Tab = "files" | "preview" | "browser" | "terminal";
/** The work panel's tabs (chatPreviewRail.tab.*). */
const TABS: { id: Tab; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "preview", label: "Preview" },
  { id: "browser", label: "Browser" },
  { id: "terminal", label: "Terminal" },
];
/**
 * The scenario's tool calls as the work group lists them: the app's display
 * name (an unmapped tool name reads with spaces for underscores), the call's
 * subject, and the panel tab the call shows in.
 */
const TOOLS: { name: string; arg?: string; tab: Tab }[] = [
  { name: "browser snapshot", tab: "browser" },
  { name: "Edit file", arg: "src/export.js", tab: "files" },
  { name: "terminal run", arg: "npm test", tab: "terminal" },
];
const TRAILS: [string, string][] = [
  ["Ridge Loop", "11.2 km, 640 m up"],
  ["Cedar Falls", "6.4 km, 210 m up"],
  ["North Saddle", "15.8 km, 1,120 m up"],
  ["Lakeshore Path", "4.1 km, 40 m up"],
];
const TEST_LINES = ["✔ csv has a header", "✔ json round-trips", "✔ unknown format throws", "tests 6", "pass 6", "fail 0"];

/** The tile header's panel button: the app's "Open side panel" (chatPreviewRail.open). */
function PanelGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M10 3v10" />
    </svg>
  );
}

/**
 * The work panel's Files tab: the session's files, each with what was done to
 * it (chatPreviewRail.fileOperation: Read, Written, Attached, Tool), and the
 * selected file opened below. Shared by the hero and the home's files section.
 */
export function FilesTab({ written = true }: { written?: boolean }) {
  return (
    <div className="hw-files">
      <ul className="hw-filelist">
        <li data-sel="">
          <span className="hw-fname">export.js</span>
          <span className="hw-fpath">src/</span>
          <span className="hw-ops">
            <b>Read</b>
            <b data-write="" data-on={written ? "" : undefined}>
              Written
            </b>
          </span>
        </li>
      </ul>
      <pre className="hw-code">
        {'switch (format) {\n  case "csv": return toCsv(trails);\n  case "md": return toTable(trails);\n'}
        <span className="hw-add" data-add data-on={written ? "" : undefined}>
          {'  case "json": return JSON.stringify(trails);'}
        </span>
        {"}"}
      </pre>
    </div>
  );
}

export function HelloStage({ demo }: { demo: HelloDemo }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || matchMedia(STILL).matches) return;
    const q = <T extends Element>(sel: string) => el.querySelector<T>(sel)!;
    const app = q<HTMLDivElement>("[data-app]");
    const log = q<HTMLDivElement>("[data-log]");
    const typed = q<HTMLDivElement>("[data-typed]");
    const term = q<HTMLPreElement>("[data-term]");
    const add = q<HTMLSpanElement>("[data-add]");
    const write = q<HTMLElement>("[data-write]");
    const toggle = q<HTMLElement>("[data-panel-toggle]");
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-trail]"));
    const tabs = Array.from(el.querySelectorAll<HTMLElement>("[data-tab]"));
    const views = Array.from(el.querySelectorAll<HTMLElement>("[data-view]"));
    const finished = { log: log.innerHTML, term: term.innerHTML };
    const items = Array.from(log.children).map((c) => c.outerHTML);
    let timers: number[] = [];
    let visible = false;
    let busy = false;

    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    const show = (tab: Tab) => {
      tabs.forEach((t) => t.toggleAttribute("data-on", t.dataset.tab === tab));
      views.forEach((v) => v.toggleAttribute("data-on", v.dataset.view === tab));
    };
    const setPanel = (open: boolean) => {
      app.toggleAttribute("data-panel", open);
      toggle.toggleAttribute("data-on", open);
    };
    const enter = (node: Element | null) =>
      node?.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], {
        duration: 460,
        easing: "cubic-bezier(.32,.72,0,1)",
      });
    const push = (html: string) => {
      log.insertAdjacentHTML("beforeend", html);
      enter(log.lastElementChild);
    };
    const type = (text: string, t0: number, cps: number) => {
      Array.from(text).forEach((c, i) => at(t0 + (i * 1000) / cps, () => (typed.textContent += c)));
      return t0 + (text.length * 1000) / cps;
    };
    const finish = () => {
      log.innerHTML = finished.log;
      term.innerHTML = finished.term;
      typed.textContent = "";
      typed.classList.remove("caret");
      rows.forEach((r) => r.setAttribute("data-read", ""));
      add.setAttribute("data-on", "");
      write.setAttribute("data-on", "");
      show("terminal");
      setPanel(true);
    };

    function play() {
      timers.forEach(clearTimeout);
      timers = [];
      busy = true;
      app.setAttribute("data-live", "");
      setPanel(false);
      log.innerHTML = "";
      typed.textContent = "";
      typed.classList.add("caret");
      rows.forEach((r) => r.removeAttribute("data-read"));
      add.removeAttribute("data-on");
      write.removeAttribute("data-on");
      term.textContent = "trail-notes % ";
      show("browser");

      let t = type(demo.hello, 600, 9);
      at(t + 350, () => {
        typed.textContent = "";
        push(items[0]);
      });
      at(t + 1100, () => push(items[1]));
      t = type(plain(demo.ask), t + 2200, 34);
      at(t + 300, () => {
        typed.textContent = "";
        push(items[2]);
        push(`<div class="hw-group"><p class="hw-thinking">Thinking...</p></div>`);
      });
      // The panel button in the tile header lights, then the panel opens.
      at(t + 700, () => toggle.setAttribute("data-press", ""));
      at(t + 1000, () => {
        toggle.removeAttribute("data-press");
        setPanel(true);
      });
      t += 1700;
      TOOLS.forEach((tool, i) => {
        const t0 = t + i * 1900;
        at(t0, () => {
          show(tool.tab);
          const group = log.querySelector(".hw-group");
          group?.insertAdjacentHTML(
            "beforeend",
            `<p class="hw-tool"><span>${tool.name}</span>${tool.arg ? `<code>${tool.arg}</code>` : ""}<b>Done</b></p>`,
          );
          enter(group?.lastElementChild ?? null);
        });
        if (tool.tab === "browser") rows.forEach((r, j) => at(t0 + 250 + j * 330, () => r.setAttribute("data-read", "")));
        if (tool.tab === "files") {
          at(t0 + 300, () => add.setAttribute("data-on", ""));
          at(t0 + 900, () => write.setAttribute("data-on", ""));
        }
        if (tool.tab === "terminal") {
          at(t0 + 150, () => (term.textContent = "trail-notes % npm test"));
          TEST_LINES.forEach((_, j) =>
            at(t0 + 400 + j * 200, () => (term.textContent = ["trail-notes % npm test", ...TEST_LINES.slice(0, j + 1)].join("\n"))),
          );
        }
      });
      t += TOOLS.length * 1900 + 900;
      at(t, () => {
        log.querySelector(".hw-group")?.remove();
        push(items[3]);
        push(items[4]);
        typed.classList.remove("caret");
      });
      at(t + 5200, () => {
        busy = false;
        if (visible) play();
      });
    }

    const io = new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting;
        if (visible && !busy) play();
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
      app.removeAttribute("data-live");
      finish();
    };
  }, [demo]);

  return (
    <div ref={root} className="hw-stage" role="img" aria-label={demo.label}>
      <div className="hw-app" data-app data-panel="" aria-hidden="true">
        <div className="hw-side">
          <div className="hw-newchat">+ New Chat</div>
          <div className="hw-row">
            Features<span className="hw-k">›</span>
          </div>
          <div className="hw-seg">
            <span>Chats</span>
            <span data-on="">Projects</span>
          </div>
          <div className="hw-row hw-proj">trail-notes</div>
          <div className="hw-row" data-sel="">
            Add a --json flag to th…<span className="hw-k">now</span>
          </div>
          <div className="hw-row">
            Draft a release checklist<span className="hw-k">2d</span>
          </div>
          <div className="hw-row hw-settings">Settings</div>
        </div>
        <div className="hw-main">
          <div className="hw-top">
            Projects <span>›</span> <b>trail-notes</b>
          </div>
          <div className="hw-tile">
            <div className="hw-tilehead">
              <span className="hw-title">Add a --json flag to the export command and run the tests.</span>
              <span className="hw-icons">
                <i />
                <i />
                <span className="hw-paneltoggle" data-panel-toggle data-on="">
                  <PanelGlyph />
                </span>
              </span>
            </div>
            <div className="hw-body">
              <div className="hw-chat">
                <div className="hw-log" data-log>
                  <p className="hw-you">
                    <Text s={demo.hello} />
                  </p>
                  <p className="hw-ave">
                    <Text s={demo.answer} />
                  </p>
                  <p className="hw-you">
                    <Text s={demo.ask} />
                  </p>
                  <p className="hw-complete">Work complete 8.3s ›</p>
                  <p className="hw-ave">
                    <Text s={demo.done} />
                  </p>
                </div>
                <div className="hw-composer">
                  <div className="hw-typed" data-typed />
                  <div className="hw-bar">
                    <span className="hw-key">⌘</span>
                    <span className="hw-send">↑</span>
                  </div>
                </div>
                <div className="hw-foot">
                  <span>Confirm writes outside the project</span>
                  <span>local-model</span>
                </div>
              </div>
              <div className="hw-panel">
                <div className="hw-tabs">
                  {TABS.map((t) => (
                    <span key={t.id} data-tab={t.id} data-on={t.id === "terminal" ? "" : undefined}>
                      {t.label}
                    </span>
                  ))}
                </div>
                <div className="hw-views">
                  <div className="hw-view" data-view="files">
                    <FilesTab />
                  </div>
                  <div className="hw-view" data-view="browser">
                    <p className="hw-url">127.0.0.1:8942/index.html</p>
                    <div className="hw-page">
                      <b>Trail notes</b>
                      <span>4 trails, exported Oct 14</span>
                    </div>
                    <div className="hw-trails">
                      {TRAILS.map(([name, meta]) => (
                        <p key={name} data-trail data-read="">
                          <b>{name}</b>
                          <span>{meta}</span>
                        </p>
                      ))}
                    </div>
                  </div>
                  <div className="hw-view" data-view="terminal" data-on="">
                    <pre className="hw-term" data-term>
                      {["trail-notes % npm test", ...TEST_LINES].join("\n")}
                    </pre>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
