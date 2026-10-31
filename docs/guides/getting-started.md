# Getting Started

Status: Active. This page is the clean-checkout path for running and testing
the desktop app and for the first run. This page and the source are
authoritative. What Ave is for is stated in [Vision](../vision/README.md).

## Clean-Checkout Setup

```bash
bun install
bun run build
bun run start
```

Bun is the package manager, but Electron and some build scripts call the system `node` CLI directly, so both must be on the path. Windows-specific setup is in [Windows setup](./windows-setup.md).

## First Run: Connect A Provider

Nothing can answer until a provider is connected, so the first stop is **Settings → Model**.

1. Press **Add provider**. The new card appears directly above that button, in the order you added it, and scrolls into view.
2. Fill in the card's credentials. **Save lives on the card itself**, beside the fields it commits, and stays disabled until a field differs from what is already saved. A card collapsed with uncommitted input is marked unsaved rather than discarding it.
3. An **endpoint** field appears only where the endpoint is yours to supply: the generic OpenAI-compatible provider, Azure AI Foundry, and the self-hosted set (Ollama, LM Studio, LiteLLM). Providers with a fixed endpoint, and providers installed from a marketplace preset, do not show one.
4. The OpenAI row offers three ways in, in one button row: **Sign in in browser**, **Use device code**, and **Use API key**. The last reveals the key field on the card; the first two are opened by the main process, and no sign-in URL or account token reaches the settings page.
5. The model list is fetched from the provider rather than read from a bundled list, and the card states which sync state it is in — synced with a count, syncing, "set an API key to sync the model list", "could not sync; showing the last catalogue that arrived", or "could not sync". A model the endpoint no longer lists is called out, because requests are rejected until another one is chosen and saved.
6. That list is **kept between runs, not re-fetched as you look at it**. Every card and the chooser paint from the stored catalogue immediately; a provider is asked for a fresh list once per app run, and otherwise only when you press the **refresh** control on its card. Leaving the settings page and coming back asks nothing, and neither does a card whose list is already stored. Changing a provider's endpoint, or saving a new key on it, counts as a new question and earns one fresh request.
7. **Pick a model from the model list.** Saving a key connects a provider; it does not move the conversation onto it. The **Model** chooser above the cards lists every connected provider's models together, grouped by provider, and picking one chooses both the provider and the model in a single step. A card whose credential you just saved says so while the conversation is still on a provider that cannot answer.

With a provider connected you can open a conversation and split the main area into up to four tiles from the tile header's split control. [Tiled chat groups](../design/tiled-chat-groups.md) records what a tile owns.

## Implementation Anchors

- `package.json`: the build, start, and test scripts
- `src/ui/renderer/tabs/LlmTab.tsx`: Settings → Model, provider cards and the model chooser
- `src/ui/renderer/tabs/SubscriptionProvidersSection.tsx`: subscription sign-in rows

## Related

- [Ave Project Documentation](../README.md)
- [Windows setup](./windows-setup.md)
- [Extension development](./plugin-development.md)
