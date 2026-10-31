# Blueprints

Status: Active. A blueprint is a staged plan that others implement against. Each
page states its status at the top: proposed, in progress, or implemented. When a
plan is fully delivered its lasting contract moves into an architecture, design,
or reference page, and a closed-out or superseded plan is deleted; git history
keeps it. The full documentation map is in the [documentation index](../README.md).

## Plans in this directory

- [A2A inter-subagent messaging](./a2a-subagent-messaging.md): accepted; phases
  1-3 merged and the phase 4 remote-routing contracts locked. Together with the
  [A2A exact send replay protocol](../protocols/ave-a2a-exact-send-replay.md) it
  is checked by `bun run check:a2a-p4-5-contract`; edit both only with that check.
- [Plugin process isolation](./plugin-process-isolation.md): stages 1-8 shipped
  (first-party extensions run in a confined child process); third-party
  admission and removal of the in-process loader remain. Source comments cite
  its sections.
- [Multi-source git marketplace](./multi-source-git-marketplace.md): phases 0-6
  done; phase 7 (public release and server retirement) remains.
- [Composer message queue](./composer-redesign-message-queue.md): busy-turn
  queueing, interrupts, and turn-end sending in the composer; implemented.
- [Memory governance P1](./memory-governance-p1-consolidation.md): the
  long-term memory consolidation decision; implemented.
- [Selective borrow record](./openharness-selective-borrow-plan.md): what was
  ported from an MIT-licensed agent harness and the license obligations;
  `LICENSE` points here.
