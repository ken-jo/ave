"use client";

import { useEffect, useRef } from "react";
import type { HelloDemo, Said } from "@/lib/home";

/**
 * The home hero's built workspace.
 *
 * It is rendered finished on the server: without script, and with reduced
 * motion, the reader gets the whole conversation. With motion allowed, script
 * rewinds it and plays it: the workspace performs the trail-notes session
 * (hello, the task, the work panel, the tests) while it is on screen.
 * Script touches the DOM only through refs and never re-renders, so React and
 * the timeline never fight over the same nodes.
 *
 * The UI labels are the app's own English strings (src/i18n/messages), as in
 * the captures; the scenario is the captures' trail-notes scenario.
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

/** The three tool calls of the scenario, as the work group lists them. */
const TOOLS: { name: string; arg?: string; tab: Tab }[] = [
  { name: "browser_snapshot", tab: "preview" },
  { name: "Edit file", arg: "src/export.js", tab: "files" },
  { name: "Terminal command", arg: "npm test", tab: "terminal" },
];
type Tab = "files" | "preview" | "browser" | "terminal";
const TABS: { id: Tab; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "preview", label: "Preview" },
  { id: "browser", label: "Browser" },
  { id: "terminal", label: "Terminal" },
];
const TRAILS: [string, string][] = [
  ["Ridge Loop", "11.2 km, 640 m up"],
  ["Cedar Falls", "6.4 km, 210 m up"],
  ["North Saddle", "15.8 km, 1,120 m up"],
  ["Lakeshore Path", "4.1 km, 40 m up"],
];
const TEST_LINES = ["✔ csv has a header", "✔ json round-trips", "✔ unknown format throws", "tests 6", "pass 6", "fail 0"];

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
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-trail]"));
    const tabs = Array.from(el.querySelectorAll<HTMLElement>("[data-tab]"));
    const views = Array.from(el.querySelectorAll<HTMLElement>("[data-view]"));
    const modes = Array.from(el.querySelectorAll<HTMLElement>("[data-mode]"));
    const finished = { log: log.innerHTML, term: term.innerHTML, cls: app.className };
    const items = Array.from(log.children).map((c) => c.outerHTML);
    let timers: number[] = [];
    let visible = false;
    let busy = false;

    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    const show = (tab: Tab) => {
      tabs.forEach((t) => t.toggleAttribute("data-on", t.dataset.tab === tab));
      views.forEach((v) => v.toggleAttribute("data-on", v.dataset.view === tab));
    };
    const setWork = (on: boolean) => {
      app.classList.toggle("is-work", on);
      modes.forEach((m) => m.toggleAttribute("data-on", (m.dataset.mode === "work") === on));
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

    function play() {
      timers.forEach(clearTimeout);
      timers = [];
      busy = true;
      app.setAttribute("data-live", "");
      setWork(false);
      log.innerHTML = "";
      typed.textContent = "";
      typed.classList.add("caret");
      rows.forEach((r) => r.removeAttribute("data-read"));
      add.removeAttribute("data-on");
      term.textContent = "trail-notes % ";
      show("preview");

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
      at(t + 900, () => setWork(true));
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
        if (tool.tab === "preview") rows.forEach((r, j) => at(t0 + 250 + j * 330, () => r.setAttribute("data-read", "")));
        if (tool.tab === "files") at(t0 + 300, () => add.setAttribute("data-on", ""));
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
      log.innerHTML = finished.log;
      term.innerHTML = finished.term;
      app.className = finished.cls;
      app.removeAttribute("data-live");
      typed.textContent = "";
      typed.classList.remove("caret");
      rows.forEach((r) => r.setAttribute("data-read", ""));
      add.setAttribute("data-on", "");
      show("terminal");
      setWork(true);
    };
  }, [demo]);

  return (
    <div ref={root} className="hw-stage" role="img" aria-label={demo.label}>
      <div className="hw-app is-work" data-app aria-hidden="true">
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
            <span className="hw-toggle">
              <span data-mode="chat">Chat</span>
              <span data-mode="work" data-on="">
                Work
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
                <span>Confirm writes</span>
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
                  <ul className="hw-tree">
                    <li>src/</li>
                    <li data-sel="">export.js</li>
                    <li>parse.js</li>
                    <li>test/</li>
                  </ul>
                  <pre className="hw-code">
                    {'switch (format) {\n  case "csv": return toCsv(trails);\n  case "md": return toTable(trails);\n'}
                    <span className="hw-add" data-add data-on="">
                      {'  case "json": return JSON.stringify(trails);'}
                    </span>
                    {"}"}
                  </pre>
                </div>
                <div className="hw-view" data-view="preview">
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
  );
}
