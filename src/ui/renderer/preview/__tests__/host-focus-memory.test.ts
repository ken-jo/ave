// @vitest-environment jsdom
/** The agent holds a page's keyboard focus only while it acts: the renderer remembers where focus was in the app and gives
 * it back when main says the action is done, unless the user has already moved focus somewhere else. */
import { afterEach, describe, expect, it } from "vitest";
import { HostFocusMemory } from "../agent-browser-bridge.js";

function setup() {
  document.body.innerHTML = `
    <textarea data-testid="composer"></textarea>
    <button data-testid="other">Other</button>
    <webview data-testid="page" tabindex="0"></webview>`;
  const memory = new HostFocusMemory(document);
  const detach = memory.attach();
  const get = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  return { memory, detach, composer: get("composer"), other: get("other"), page: get("page") };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("HostFocusMemory", () => {
  it("gives focus back to the composer after the page took it", () => {
    const { memory, detach, composer, page } = setup();
    composer.focus();
    page.focus();
    expect(document.activeElement).toBe(page);
    memory.restore();
    expect(document.activeElement).toBe(composer);
    detach();
  });

  it("skips a remembered element that has gone (a closed approval card's button)", () => {
    const { memory, detach, composer, page } = setup();
    const cardButton = document.createElement("button");
    document.body.appendChild(cardButton);
    composer.focus();
    cardButton.focus();
    page.focus();
    cardButton.remove();
    memory.restore();
    expect(document.activeElement).toBe(composer);
    detach();
  });

  it("leaves focus alone when the user already moved it off the page", () => {
    const { memory, detach, composer, other, page } = setup();
    composer.focus();
    page.focus();
    other.focus();
    memory.restore();
    expect(document.activeElement).toBe(other);
    detach();
  });

  it("does not remember the page itself, and drops focus when nothing remembered is usable", () => {
    const { memory, detach, composer, page } = setup();
    composer.focus();
    page.focus();
    composer.setAttribute("inert", "");
    memory.restore();
    expect(document.activeElement).not.toBe(page);
    expect(document.activeElement).not.toBe(composer);

    composer.removeAttribute("inert");
    composer.focus();
    page.focus();
    composer.remove();
    memory.restore();
    expect(document.activeElement).not.toBe(page);
    detach();
  });

  it("stops listening once detached", () => {
    const { memory, detach, composer, other, page } = setup();
    composer.focus();
    detach();
    other.focus();
    page.focus();
    memory.restore();
    expect(document.activeElement).toBe(composer);
  });
});
