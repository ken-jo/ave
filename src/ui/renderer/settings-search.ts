import { matchSettingsText } from "./settings-text-match.js";

const settingsRowDisplay = new WeakMap<HTMLElement, string>();

export interface RenderedSettingsMatch {
  section: HTMLElement;
  panel: HTMLElement;
  text: string;
}

/** Read the labels actually rendered, including names supplied to assistive technology. */
export function renderedSettingText(section: HTMLElement): string {
  const document = section.ownerDocument;
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
  const labels: string[] = [section.dataset.settingsSection ?? "", section.dataset.settingsDescription ?? "", section.dataset.settingsKeywords ?? ""];
  while (walker.nextNode()) {
    if (walker.currentNode.parentElement?.closest('textarea, input, [contenteditable], [data-setting-filter-hidden="true"]')) continue;
    labels.push(walker.currentNode.textContent ?? "");
  }
  for (const control of section.querySelectorAll<HTMLElement>("[aria-label], [data-setting-id]")) {
    if (control.closest('[data-setting-filter-hidden="true"]')) continue;
    labels.push(control.getAttribute("aria-label") ?? "", control.dataset.settingId ?? "");
  }
  return labels.join(" ");
}

export function settingsTextMatchesQuery(text: string, query: string): boolean {
  return query.trim().split(/\s+/).filter(Boolean).every((term) => matchSettingsText(term, text) !== null);
}

/** Search uses rendered controls, so a new setting is indexed as soon as its section mounts. */
export function filterRenderedSettings(root: HTMLElement, query: string, modifiedOnly = false): readonly RenderedSettingsMatch[] {
  const modifiedIds = new Set([...root.querySelectorAll<HTMLElement>('[data-setting-registered="true"][data-setting-modified="true"]')].map((node) => node.dataset.settingControlId ?? node.dataset.settingId));
  for (const row of root.querySelectorAll<HTMLElement>("[data-setting-row], [data-setting-id]")) {
    if (row.closest("[data-settings-actions], [data-settings-control-registry]") || row.hasAttribute("data-settings-section")) continue;
    const id = row.dataset.settingRow ?? row.dataset.settingId;
    const hidden = modifiedOnly && !modifiedIds.has(id);
    if (!settingsRowDisplay.has(row)) settingsRowDisplay.set(row, row.style.display);
    row.dataset.settingFilterHidden = hidden ? "true" : "false";
    row.hidden = hidden;
    row.style.display = hidden ? "none" : (settingsRowDisplay.get(row) ?? "");
  }
  const matches: RenderedSettingsMatch[] = [];
  for (const panel of root.querySelectorAll<HTMLElement>("[data-settings-panel]")) {
    let visible = 0;
    for (const section of panel.querySelectorAll<HTMLElement>("[data-settings-section]")) {
      const text = renderedSettingText(section);
      const modified = section.querySelector('[data-setting-modified="true"]') !== null;
      const matched = settingsTextMatchesQuery(text, query) && (!modifiedOnly || modified);
      section.hidden = !matched;
      section.style.display = matched ? "" : "none";
      if (matched) { ++visible; matches.push({ section, panel, text }); }
    }
    panel.hidden = visible === 0;
    panel.style.display = visible > 0 ? "flex" : "none";
  }
  return matches;
}

export function clearSettingsFilter(root: HTMLElement): void {
  for (const row of root.querySelectorAll<HTMLElement>("[data-setting-filter-hidden]")) {
    row.hidden = false; row.style.display = settingsRowDisplay.get(row) ?? "";
    settingsRowDisplay.delete(row); delete row.dataset.settingFilterHidden;
  }
  for (const section of root.querySelectorAll<HTMLElement>("[data-settings-section], [data-settings-panel]")) {
    // An inactive tab panel stays mounted; the tab library hides it through `hidden` and reveals it on selection.
    // An inline display would outlive that selection and keep the chosen tab blank.
    section.hidden = section.hasAttribute("data-settings-panel") && section.dataset.state === "inactive";
    section.style.removeProperty("display");
  }
  if (typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.delete("ave-settings-match");
}

/** Browser-native ranges highlight text without rewriting nodes owned by the renderer. */
export function highlightSettingsMatches(matches: readonly RenderedSettingsMatch[], query: string): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
  const ranges: Range[] = [];
  const words = query.trim().split(/\s+/).filter(Boolean);
  for (const { section } of matches) {
    const walker = section.ownerDocument.createTreeWalker(section, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('textarea, input, [contenteditable], [data-setting-filter-hidden="true"]')) continue;
      for (const word of words) {
        const range = matchSettingsText(word, node.textContent ?? "")?.[0];
        if (!range) continue;
        const selection = section.ownerDocument.createRange();
        selection.setStart(node, range.start); selection.setEnd(node, range.end);
        ranges.push(selection);
      }
    }
  }
  CSS.highlights.set("ave-settings-match", new Highlight(...ranges));
}
