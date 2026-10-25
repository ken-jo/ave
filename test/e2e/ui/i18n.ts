import { interpolate, type TranslationVars } from '../../../src/i18n/translate.js';
import { messages, type Messages } from '../../../src/i18n/messages/index.js';
import { ko } from '../../../src/i18n/messages/ko.js';
import { koMessages } from '../../../src/i18n/messages/generated-locales/ko.js';

// Bind catalog assertions to the locale seeded by the fixture.
export type TestT = (key: string, vars?: TranslationVars) => string;

export function makeTestT(locale: "en" | "ko"): TestT {
  // Bind catalogs synchronously so lazy renderer imports cannot make assertions use the fallback locale.
  const catalog: Messages = locale === "ko" ? { ...ko, ...koMessages } : messages.en;
  return (key, vars) => interpolate(catalog[key] ?? messages.en[key] ?? key, vars);
}
