import type { Locale } from "./i18n";

/**
 * The one statement of the Ave → Ave reinstall rule, shown on the landing
 * download section and the install/update docs. 0.14.0 ships under a new app
 * ID and data folder, with no automatic migration and no auto-update path from
 * older Ave builds.
 */
const notice = {
  ko: {
    title: "Ave를 쓰고 있었다면: 0.14.0은 새로 설치해야 합니다",
    points: [
      "0.14.0부터 앱 이름이 Ave로 바뀌면서 새 앱 ID와 새 데이터 폴더를 씁니다.",
      "이전 Ave 버전의 설정·대화·익스텐션은 자동으로 옮겨지지 않습니다.",
      "이전 Ave 앱은 0.14.0으로 자동 업데이트되지 않습니다. Ave를 새로 내려받아 설치하세요.",
      "이전 Ave 앱은 Ave와 별개로 남습니다. 더 쓰지 않으면 직접 삭제하면 됩니다.",
    ],
  },
  en: {
    title: "Coming from Ave? 0.14.0 is a fresh install",
    points: [
      "Starting with 0.14.0 the app is named Ave and uses a new app ID and a new data folder.",
      "Settings, conversations, and extensions from older Ave versions are not migrated automatically.",
      "Older Ave apps will not auto-update to 0.14.0. Download Ave and install it fresh.",
      "Your old Ave app stays separate from Ave. Remove it yourself once you no longer need it.",
    ],
  },
} as const satisfies Record<Locale, { title: string; points: readonly string[] }>;

export function reinstallNotice(locale: Locale) {
  return notice[locale];
}
