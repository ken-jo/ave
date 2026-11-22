// Portions adapted from microsoft/vscode src/vs/base/common/filters.ts @ 6659689e6b03ec062f5b7bcea9850b4c59045807, Copyright (c) Microsoft Corporation, MIT License.

export interface SettingsTextMatch { start: number; end: number }

/** Case-insensitive contiguous ranges used by both matching and highlighting. */
export function matchSettingsText(word: string, text: string): SettingsTextMatch[] | null {
  if (word.length === 0) return [];
  if (word.length > text.length) return null;
  const index = text.toLowerCase().indexOf(word.toLowerCase());
  if (index === -1) return null;
  return [{ start: index, end: index + word.length }];
}
