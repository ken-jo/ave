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

These are product goals. [Where Ave is today](#where-ave-is-today) describes
implemented behavior and remaining validation.

1. **A browser you and the agent share.** The agent browses with you: it opens
   and reads pages, follows links, fills forms, and operates sites in a browser
   you can see and take over at any moment. You and the agent share the same
   tabs, so handing work back and forth needs no copy and paste.
2. **A terminal for everyday work with an agent.** The terminal is a first-class
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
- **Browser.** The agent operates visible shared tabs through typed browser
  tools, alongside `web_fetch` and `web_search`. Human takeover pauses agent
  mutation until explicit Resume. Borrowed user tabs survive agent release;
  agent-created tabs remain for handoff after a turn. Browser sandboxing stays
  enabled in every mode. The [workspace guide](../guides/browser-terminal-workspace.md)
  covers page actions, file-picker uploads, browser controls, and visible-card
  previews. Native interaction and provider-authentication signoff remain pending.
- **Terminal.** Each terminal tab is one private host shell, **My terminal
  (host) · No agent access**, using the user's shell/profile. Each conversation
  owns its own confined **Agent (isolated)** shell with a disposable HOME; its
  commands appear inline in the conversation. `terminal_run` and `terminal_read`
  reach only that conversation's isolated shell. An unavailable isolated backend
  leaves host terminals usable without falling back to host execution. The
  current Windows interactive isolated backend is unavailable. Agent typing into
  a host shell, with per-command approval and take-over, is pending; searchable
  terminal history remains a goal. See the
  [workspace guide](../guides/browser-terminal-workspace.md#terminal-lanes).
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
