import type { Locale } from "./i18n";

/** Chrome-level UI strings (header/footer/sidebar/toc/page-nav/search). */
export const ui = {
  ko: {
    nav: { features: "작동 방식", trust: "신뢰", download: "다운로드", docs: "문서" },
    downloadApp: "다운로드",
    home: "Ave 홈",
    skipToContent: "본문으로 건너뛰기",
    searchPlaceholder: "검색...",
    openSearch: "검색 열기 (⌘K)",
    onThisPage: "On this page",
    prev: "이전",
    next: "다음",
    sidebarLabel: "문서 사이드바",
    tocLabel: "페이지 목차",
    footerTagline: "당신의 PC에서 일하는 업무 AI. 신호는 조용히 읽고, 실행은 당신의 승인으로.",
    footerProduct: "제품",
    footerDocs: "문서",
    footerResources: "리소스",
    footerHome: "홈",
    footerLinks: {
      start: "시작하기",
      updates: "업데이트",
      plugins: "익스텐션",
      architecture: "아키텍처",
      roadmap: "로드맵",
      reinstall: "Ave에서 옮겨 오기",
      hostApi: "호스트 API",
    },
  },
  en: {
    nav: { features: "How it works", trust: "Trust", download: "Download", docs: "Docs" },
    downloadApp: "Download",
    home: "Ave home",
    skipToContent: "Skip to content",
    searchPlaceholder: "Search...",
    openSearch: "Open search (⌘K)",
    onThisPage: "On this page",
    prev: "Previous",
    next: "Next",
    sidebarLabel: "Docs sidebar",
    tocLabel: "Table of contents",
    footerTagline: "The AI work host on your own PC. It reads signals quietly and acts only with your approval.",
    footerProduct: "Product",
    footerDocs: "Docs",
    footerResources: "Resources",
    footerHome: "Home",
    footerLinks: {
      start: "Getting started",
      updates: "Updates",
      plugins: "Extensions",
      architecture: "Architecture",
      roadmap: "Roadmap",
      reinstall: "Coming from Ave",
      hostApi: "Host API",
    },
  },
} satisfies Record<Locale, unknown>;

export function uiStrings(locale: Locale) {
  return ui[locale];
}
