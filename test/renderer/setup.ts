// Shared DOM setup owns cleanup, polyfills and explicit intersection delivery.
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { _clearTerminalFileReviewForTest } from "../../src/ui/renderer/preview/terminal-file-review.js";
import { clearComposerDrafts } from "../../src/ui/renderer/state/composer-draft-store.js";

const stubbedGlobals = new Map<string, unknown>();

if (typeof (vi as { stubGlobal?: unknown }).stubGlobal !== "function") {
  (vi as {
    stubGlobal: (key: string, value: unknown) => void;
    unstubAllGlobals?: () => void;
  }).stubGlobal = (key: string, value: unknown) => {
    if (!stubbedGlobals.has(key)) {
      stubbedGlobals.set(key, (globalThis as Record<string, unknown>)[key]);
    }
    (globalThis as Record<string, unknown>)[key] = value;
  };
}

if (typeof (vi as { unstubAllGlobals?: unknown }).unstubAllGlobals !== "function") {
  (vi as {
    unstubAllGlobals: () => void;
  }).unstubAllGlobals = () => {
    for (const [key, value] of stubbedGlobals.entries()) {
      if (typeof value === "undefined") {
        delete (globalThis as Record<string, unknown>)[key];
      } else {
        (globalThis as Record<string, unknown>)[key] = value;
      }
    }
    stubbedGlobals.clear();
  };
}

const liveIntersectionObservers = new Set<TestIntersectionObserver>();
// New observers receive each target's retained intersection state, not only future trigger events.
const intersectionStates = new Map<Element, boolean>();

afterEach(() => {
  cleanup();
  _clearTerminalFileReviewForTest();
  // Clear parked drafts so unmounting one test cannot seed the next composer.
  clearComposerDrafts();
  intersectionStates.clear();
  containerWidths = { shellWidth: Infinity, canvasWidth: Infinity };
});

// Supply explicit intersection delivery because the DOM test environment has no layout.
class TestIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin: string;
  readonly thresholds: readonly number[];
  private readonly targets = new Set<Element>();
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.root = (options?.root as Element | Document | null | undefined) ?? null;
    this.rootMargin = options?.rootMargin ?? "0px";
    this.scrollMargin = options?.scrollMargin ?? "0px";
    const threshold = options?.threshold ?? 0;
    this.thresholds = Array.isArray(threshold) ? threshold : [threshold];
    liveIntersectionObservers.add(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
    // Queue current-state delivery to match asynchronous browser observer behavior.
    queueMicrotask(() => {
      this.deliver(target, intersectionStates.get(target) ?? false);
    });
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    liveIntersectionObservers.delete(this);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  deliver(target: Element, isIntersecting: boolean): boolean {
    if (!this.targets.has(target)) return false;
    const rect = target.getBoundingClientRect();
    this.callback(
      [{
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        boundingClientRect: rect,
        intersectionRect: rect,
        rootBounds: null,
        time: 0,
      } as IntersectionObserverEntry],
      this,
    );
    return true;
  }
}

// Retain intersection state for new observers and return the number of actual watchers.
export function triggerIntersection(target: Element, isIntersecting = true): number {
  intersectionStates.set(target, isIntersecting);
  let delivered = 0;
  for (const observer of [...liveIntersectionObservers]) {
    if (observer.deliver(target, isIntersecting)) delivered += 1;
  }
  return delivered;
}

export interface ContainerWidths {
  shellWidth: number;
  canvasWidth: number;
}

let containerWidths: ContainerWidths = { shellWidth: Infinity, canvasWidth: Infinity };
const liveResizeObservers = new Set<TestResizeObserver>();

class TestResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    liveResizeObservers.add(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
    queueMicrotask(() => this.deliver(target));
  }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void {
    this.targets.clear();
    liveResizeObservers.delete(this);
  }
  deliver(target: Element): void {
    if (!this.targets.has(target)) return;
    const width = target.matches('[data-testid="app-shell"]')
      ? containerWidths.shellWidth : containerWidths.canvasWidth;
    if (!Number.isFinite(width)) return;
    this.callback([{
      target,
      contentRect: new DOMRectReadOnly(0, 0, width, 768),
      contentBoxSize: [{ inlineSize: width, blockSize: 768 }],
      borderBoxSize: [{ inlineSize: width, blockSize: 768 }],
      devicePixelContentBoxSize: [{ inlineSize: width, blockSize: 768 }],
    } as ResizeObserverEntry], this);
  }
  deliverAll(): void { for (const target of this.targets) this.deliver(target); }
}

// Deliver shell and canvas geometry independently, including observers mounted after a resize.
export function setContainerWidths(widths: Partial<ContainerWidths>): void {
  containerWidths = { ...containerWidths, ...widths };
  for (const observer of liveResizeObservers) observer.deliverAll();
}

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    // @ts-expect-error — jsdom doesn't provide matchMedia.
    window.matchMedia = () => ({
      matches: false,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = function () {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function () {
      return false;
    };
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function () {};
  }
  if (!window.IntersectionObserver) {
    window.IntersectionObserver = TestIntersectionObserver;
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = TestResizeObserver;
  }
}
