// i18n fragment. Source: src/ui/renderer/components/ProjectHomeView.tsx.
export const en = {
  "projectHome.allProjectsCount": "{count} projects",
  "projectHome.openSurfaces": "Open now · {count}",
  "projectHome.noOpenSurfaces": "No terminal or page is open in this project.",
  "projectHome.linksLabel": "Project views",
  "projectHome.workApprovalsLabel": "Needs your decision",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "projectHome.allProjectsCount": "프로젝트 {count}개",
  "projectHome.openSurfaces": "지금 열린 화면 · {count}",
  "projectHome.noOpenSurfaces": "이 프로젝트에 열린 터미널이나 페이지가 없습니다.",
  "projectHome.linksLabel": "프로젝트 보기",
  "projectHome.workApprovalsLabel": "확인 필요",
};
