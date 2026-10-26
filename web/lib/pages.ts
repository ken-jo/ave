import type { Picture } from "./content";
import type { Locale } from "./i18n";

/** Copy for the download, docs index, changelog and not-found pages, and shared UI words. */

export interface PagesCopy {
  download: {
    title: string;
    lead: string;
    pending: string;
    pendingNote: string;
    get: string;
    setup: string;
    requirements: { title: string; body: string }[];
    after: { eyebrow: string; title: string; body: string; points: [string, string][]; pic: Picture; start: string };
  };
  docs: { title: string; lead: string; pages: string };
  changelog: { title: string; lead: string; note: string; versions: string };
  notFound: { title: string; lead: string; home: string };
  ui: {
    copy: string;
    copied: string;
    prev: string;
    next: string;
    faq: string;
    nextSteps: string;
  };
}

const ko: PagesCopy = {
  download: {
    title: "Ave 내려받기",
    lead: "Ave는 macOS, Windows, Linux에서 실행됩니다. 공개 빌드는 아직 코드 서명이 없어서, 운영체제마다 처음 실행할 때 한 단계가 더 필요합니다. 그 단계를 아래에 그대로 적어 두었습니다.",
    pending: "릴리스 준비 중",
    pendingNote: "첫 공개 릴리스를 올리는 중이라 아직 설치 파일 링크가 없습니다. 무엇이 들어가는지는 변경 기록에서 볼 수 있습니다.",
    get: "설치 파일 받기",
    setup: "설치 단계",
    requirements: [
      { title: "macOS", body: "Apple Silicon(arm64) Mac. Intel Mac은 지원하지 않습니다." },
      { title: "Windows", body: "Windows 10 이상, x64. 설치 프로그램 형식입니다." },
      { title: "Linux", body: "x86_64 AppImage. 실행하려면 FUSE 2가 필요합니다." },
    ],
    after: {
      eyebrow: "설치한 다음",
      title: "모델을 하나 연결하면 시작할 수 있습니다",
      body: "처음 실행하면 Ave는 빈 상태로 시작합니다. 설정 → 모델에서 제공자를 추가하고 카드에서 저장하면 바로 대화할 수 있습니다.",
      points: [
        ["API 키.", "OpenAI, Claude, Gemini, OpenRouter는 키를 넣고 저장합니다."],
        ["직접 띄운 서버.", "OpenAI 호환 엔드포인트의 주소를 넣으면 모델 목록을 받아 옵니다."],
        ["구독.", "ChatGPT 요금제나 Claude 구독으로 로그인할 수 있습니다."],
      ],
      pic: { k: "settings-model", alt: "모델 설정 화면. OpenAI 호환 제공자가 연결됨으로 표시되고 추론과 대체 체인 설정이 이어지는 화면" },
      start: "첫 실행부터 첫 대화까지의 단계는 시작하기 문서에 있습니다.",
    },
  },
  docs: {
    title: "Ave 문서",
    lead: "설치부터 모델 연결, 작업 화면, 권한, 플러그인, 마켓플레이스, 루틴, 데이터까지. 앱에 보이는 이름 그대로 설명합니다.",
    pages: "문서 목록",
  },
  changelog: {
    title: "변경 기록",
    lead: "버전마다 바뀐 것을 저장소의 CHANGELOG.md에서 그대로 옮겨 둡니다. 최신 버전이 맨 위에 있습니다.",
    note: "Ave는 0.14.0부터 시작합니다. 그보다 앞선 버전은 이전 앱의 기록입니다.",
    versions: "버전",
  },
  notFound: {
    title: "찾는 페이지가 없습니다",
    lead: "주소가 바뀌었거나 없는 페이지입니다. 아래에서 다시 시작하세요.",
    home: "홈으로",
  },
  ui: {
    copy: "복사",
    copied: "복사됨",
    prev: "이전",
    next: "다음",
    faq: "자주 묻는 질문",
    nextSteps: "다음으로",
  },
};

const en: PagesCopy = {
  download: {
    title: "Download Ave",
    lead: "Ave runs on macOS, Windows and Linux. Public builds are not code-signed yet, so each system needs one extra step on first launch. The steps are written out below.",
    pending: "Release in preparation",
    pendingNote: "The first public release is being uploaded, so there is no installer link yet. The changelog shows what it contains.",
    get: "Get the installer",
    setup: "Setup steps",
    requirements: [
      { title: "macOS", body: "An Apple Silicon (arm64) Mac. Intel Macs are not supported." },
      { title: "Windows", body: "Windows 10 or later, x64, as an installer." },
      { title: "Linux", body: "An x86_64 AppImage. It needs FUSE 2 to run." },
    ],
    after: {
      eyebrow: "After installing",
      title: "Connect one model and you can start",
      body: "On first launch Ave starts empty. Add a provider in Settings → Model, save its card, and you can start a conversation.",
      points: [
        ["API key.", "For OpenAI, Claude, Gemini and OpenRouter, enter a key and save."],
        ["Your own server.", "Enter an OpenAI-compatible endpoint’s address and the model list is fetched."],
        ["Subscription.", "Sign in with a ChatGPT plan or a Claude subscription."],
      ],
      pic: { k: "settings-model", alt: "The Model settings with an OpenAI-compatible provider shown as connected, followed by reasoning and fallback settings" },
      start: "The steps from first launch to a first conversation are in the getting-started guide.",
    },
  },
  docs: {
    title: "Ave docs",
    lead: "From installing and connecting a model to the workbench, permissions, plugins, marketplaces, routines and data, named the way the app names them.",
    pages: "Pages",
  },
  changelog: {
    title: "Changelog",
    lead: "What changed in each version, from the repository’s CHANGELOG.md, as a headline and short points per change. The newest version is at the top.",
    note: "Ave starts at 0.14.0; earlier versions belong to its predecessor app.",
    versions: "Versions",
  },
  notFound: {
    title: "This page doesn’t exist",
    lead: "The address may have changed, or the page was never here. Start again from one of these.",
    home: "Go to the home page",
  },
  ui: {
    copy: "Copy",
    copied: "Copied",
    prev: "Previous",
    next: "Next",
    faq: "Questions",
    nextSteps: "Next",
  },
};

export function pagesCopy(locale: Locale): PagesCopy {
  return locale === "en" ? en : ko;
}
