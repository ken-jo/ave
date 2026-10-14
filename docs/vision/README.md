# Vision

Status: Active. This page is the single canonical statement of what Ave is and
where it is going. Other pages (the README, the docs index, the architecture
intro, `package.json`) describe Ave in one line and link here instead of
restating it.

Korean mirror: [docs/ko/vision/README.md](../ko/vision/README.md).

## Hello, I'm Ave

*Ave* is Latin for a bright "hello". Ave is a comprehensive agent browser: the
desktop place where you, your agents, the models you choose, and your computer
meet. You open Ave the way you open a browser, and the agent works beside you on
the web, in the terminal, in your files, and in your conversations, on one
platform that is pleasant to use every day.

## Goals

These are product goals. [Where Ave is today](#where-ave-is-today) says what
already ships.

1. **Browser use at the level of Aside.** The agent browses with you: it opens
   and reads pages, follows links, fills forms, and operates sites in a browser
   you can see and take over at any moment. You and the agent share the same
   tabs, so handing work back and forth needs no copy and paste.
2. **Terminal work at the level of Warp.** The terminal is a first-class
   surface: multiple tabs, commands and their output grouped as blocks you can
   read, copy, and rerun, searchable history, and an agent that works inside the
   terminal with you rather than only through one-shot commands.
3. **One platform for everything around it.** Chat with the model you choose,
   parallel conversations, files and previews, plugins and the marketplace,
   skills, memory, routines, and remote access from another device or agent all
   live in the same window and share the same project context.
4. **Easy to trust, easy to use.** Ave asks for your say where an action
   matters and stays out of the way where it does not. Safety controls exist to
   keep daily use comfortable, not to dominate it.

## Where Ave is today

Checked against the code; source files and tests win if this page drifts.

- **Chat and parallel work.** Streaming chat with resume, fork, branch, export,
  and compaction; up to four conversations side by side as tiles
  ([tiled chat groups](../design/tiled-chat-groups.md)); bring-your-own model
  providers.
- **Work panel.** Files, Preview, Browser, Terminal, Sub-agents, and Side chat
  in one panel per tile.
- **Browser.** Browser tabs in the work panel for the user, in an isolated web
  session (`src/main/side-browser-webview.ts`). The agent reaches the web
  through `web_fetch` and `web_search` (`src/tools/`). Agent-driven browsing of
  the shared tabs is a goal, not yet shipped.
- **Terminal.** Real interactive PTY terminal tabs rendered with xterm.js
  (`src/main/terminal/pty-manager.ts`,
  `src/ui/renderer/components/PtyTerminalView.tsx`), running inside the OS
  sandbox. The agent runs commands through its shell tool
  (`src/tools/shell-tools.ts`). Command blocks, terminal history search, and an
  agent inside the terminal are goals, not yet shipped.
- **Extensions.** Manifest-driven plugins, a managed marketplace, git
  marketplaces, MCP servers and MCP app cards, and skills
  ([plugin development](../guides/plugin-development.md)).
- **Agents and remote.** Sub-agents, agent-to-agent (A2A) remote access, a
  headless host, and remote approval from a messaging app (`src/main/`).
- **Local context.** Projects, memory, local indexing through the Local Indexer
  plugin, routines, and an audit log, all under `~/.ave/`.

## Related

- [Philosophy](./philosophy.md): the principles behind these goals.
- [Architecture](../architecture/README.md): the contracts that implement them.
- [Ave Project Documentation](../README.md)
