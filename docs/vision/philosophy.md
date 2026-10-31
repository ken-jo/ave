# Philosophy

Status: Active. The goals themselves are stated once, in [Vision](./README.md).
This page records the principles Ave follows while pursuing them.

## Principles

- **Side by side, not behind a wall.** The agent works in surfaces the user can
  see. It already works in the same files; working in the same browser tabs and
  the same terminal as the user is a goal, not yet shipped
  ([where Ave is today](./README.md#where-ave-is-today)). The user can watch,
  interrupt, and take over at any point, and the agent can pick up where the
  user left off.
- **One place, shared context.** Chat, browser, terminal, files, plugins, and
  remote sessions share one project context, so nothing has to be re-explained
  when work moves between surfaces.
- **Your models, your computer.** The user chooses the model provider. State
  lives on the user's machine under `~/.ave/`, and the user can inspect, back
  up, or clear it.
- **Extensible through contracts.** Plugins, MCP servers, and skills plug in
  through published contracts (`src/plugins/types.ts`, manifests, HostApi). The
  host has no plugin-specific branches.
- **Usable first, safe throughout.** Approvals appear where an action matters
  and stay quiet where it does not. Sandboxing and audit work in the background
  so daily use stays comfortable
  ([permission policy](../architecture/permission-policy-design.md)).
- **Honest status.** The app shows what the agent is doing, what it changed, and
  why something failed, instead of hiding failures behind defaults.

## Related

- [Vision](./README.md)
- [Architecture](../architecture/README.md)
- [Ave Project Documentation](../README.md)
