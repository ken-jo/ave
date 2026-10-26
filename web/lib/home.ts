import type { Picture } from "./content";
import type { Locale } from "./i18n";
import type { Feature } from "./nav";

/**
 * Home page copy and the site-wide notices. Every product claim is taken from
 * the app's guide (lib/docs.ts), its UI strings, or what the captures show;
 * the captures are of the real app driven by a scripted demo conversation.
 * The hero's built workspace replays that same trail-notes scenario; its UI
 * labels are the app's own English strings (src/i18n), as in the captures.
 *
 * "Ave means hello" is the brand line: avē is Latin for hello.
 */

/** A chat message; text between backticks is shown as code. */
export type Said = string;

export interface HelloDemo {
  /** What the built workspace shows, for assistive technology (it is one picture). */
  label: string;
  /** The opening greeting and Ave's answer. */
  hello: Said;
  answer: Said;
  /** The task the person types. */
  ask: Said;
  /** Ave's closing report. */
  done: Said;
}

export interface Tile {
  title: string;
  body: string;
  /** A real capture, or "files" for the built Files fragment (no capture of the Files tab yet). */
  pic: Picture | "files";
  /** Crop of the capture inside the tile: its width, left and top, as percentages of the tile's window. */
  crop?: [w: number, x: number, y: number];
  /** The feature page the tile leads to; without one it leads to the workbench guide. */
  feature?: Feature;
}

/**
 * A home section's words. Until the copy deck (product marketing, ko+en)
 * lands, new copy is a visible placeholder in the form ⟦copy: key⟧; the
 * build is not to be published while one remains.
 */
export interface SectionCopy {
  eyebrow: string;
  title: string;
  body: string;
  pic: Picture;
}

const TBD = (key: string) => `⟦copy: ${key}⟧`;

export interface HomeCopy {
  meta: { title: string; description: string };
  hero: { title: string; dim: string; sub: string; download: string; docs: string; note: string; demo: HelloDemo };
  /** Section 1, the Latin-hello story: a sentence revealed word by word, and a short body. */
  statement: string;
  story: string;
  /** Section 2: every browser with your agent, on one wide capture. */
  browse: SectionCopy;
  work: { eyebrow: string; title: string; body: string; pic: Picture };
  hands: { title: string; body: string; tiles: Tile[] };
  /** Section 5: a split, words beside one capture. */
  pair: SectionCopy;
  close: { before: string; hello: string; after: string; body: string; cta: string };
  footer: { tagline: string; copy: string; menu: string; skip: string };
}

const ko: HomeCopy = {
  meta: {
    title: "Ave — 에이전트가 내 컴퓨터에서 일하는 데스크톱 작업 환경",
    description:
      "Ave는 에이전트가 내가 고른 모델로 내 컴퓨터의 파일과 터미널, 브라우저를 다루는 macOS, Windows, Linux용 데스크톱 앱입니다. 바꾸는 일은 실행 전에 묻습니다.",
  },
  hero: {
    title: TBD("hero.title"),
    dim: TBD("hero.line2"),
    sub: TBD("hero.sub"),
    download: "Ave 내려받기",
    docs: "문서 읽기",
    note: "Apple Silicon Mac, Windows 10 이상(x64), x86_64 Linux. 공개 빌드는 아직 코드 서명이 없습니다.",
    demo: {
      label:
        "Ave 작업 화면을 다시 그린 장면. hello라고 인사하자 Ave가 답하고, trail-notes 프로젝트에 --json 내보내기를 넣어 달라고 하자 작업 패널이 열려 미리보기에서 트레일 목록을 읽고, src/export.js에 json 분기를 넣고, 터미널에서 npm test 6개가 모두 통과합니다.",
      hello: "hello",
      answer: "hello. trail-notes에서 무엇을 할까요?",
      ask: "트레일 목록을 확인하고 `--json` 내보내기를 넣은 다음 테스트를 돌려 줘.",
      done: "완료했습니다. `trail-notes export --json`이 트레일을 JSON으로 출력합니다. 테스트: `npm test` 6개 중 6개 통과.",
    },
  },
  statement: TBD("story.sentence"),
  story: TBD("story.body"),
  browse: {
    eyebrow: TBD("browse.eyebrow"),
    title: TBD("browse.title"),
    body: TBD("browse.body"),
    pic: { k: "web-main", alt: "메인 영역에 trail-notes 미리보기 웹 패널과 터미널이 나란히 열린 화면" },
  },
  work: {
    eyebrow: "작업 화면",
    title: "대화 넷을 나란히, 각자 따로 굴러갑니다",
    body: "창 폭에 맞춰 대화를 최대 네 칸까지 나란히 보여 줍니다. 칸마다 루프가 따로 있어서, 한쪽이 승인을 기다리는 동안 다른 칸은 계속 답합니다.",
    pic: {
      k: "app-subagents",
      alt: "세 칸에 각각 다른 대화가 열려 있는 화면. 왼쪽은 --json 플래그를 넣고 테스트 6개가 통과한 대화, 오른쪽 위는 서브에이전트 탭에 두 리뷰가 완료로 표시된 대화, 오른쪽 아래는 1.2.0 릴리스 체크리스트",
    },
  },
  hands: {
    title: "한 작업 공간, 여섯 갈래",
    body: "에이전트가 다루는 웹, 터미널, 파일. 그리고 모델을 고르고, 바꾸기 전에 묻고, 기능을 넓히는 방법.",
    tiles: [
      {
        title: "웹을 읽고",
        body: "브라우저 창에 붙은 채팅이 페이지를 읽고 이동합니다. 도구 실행은 권한 검사를 거칩니다.",
        pic: { k: "browser-live", alt: "Ave의 브라우저 창에 Trail notes 페이지가 열려 있고, 옆에 그 창에 붙은 채팅이 있는 화면" },
        crop: [240, -38, -6],
        feature: "browser",
      },
      {
        title: "터미널을 돌리고",
        body: "실제 셸이 도는 터미널에서 실패한 출력을 읽고, 승인을 받아 같은 셸에서 다시 돌립니다.",
        pic: { k: "terminal-ask", alt: "터미널에 붙은 채팅이 실패한 테스트 출력을 읽는 화면" },
        crop: [230, -34, -4],
        feature: "terminal",
      },
      {
        title: "파일을 고칩니다",
        body: "작업 패널의 파일 탭에서 src/export.js에 json 분기가 들어간 줄을 바로 확인합니다.",
        pic: "files",
      },
      {
        title: "모델은 내가 고르고",
        body: "API 키, 직접 띄운 OpenAI 호환 서버, 이미 쓰는 구독. 세 가지 길로 연결합니다.",
        pic: { k: "model-chooser", alt: "입력창의 모델 선택 팝오버. local-model이 선택돼 있고 아래에 추론 수준 슬라이더가 있는 화면" },
        crop: [100, 0, 0],
        feature: "models",
      },
      {
        title: "바꾸기 전에 묻고",
        body: "쓰기, 셸, 네트워크는 실행 전에 위험도와 격리 여부를 보여 주고 승인을 받습니다.",
        pic: { k: "approval-shell", alt: "builtin:bash 승인 창. 중간 위험, OS 격리 활성(asrt)과 거절, 항상 허용, 한 번 허용 버튼" },
        crop: [160, 0, 0],
        feature: "security",
      },
      {
        title: "git에서 넓힙니다",
        body: "마켓플레이스는 git 저장소입니다. 설치는 커밋에 고정되고 파일마다 SHA-256으로 확인합니다.",
        pic: { k: "install-review", alt: "플러그인 설치 검토 창. 출처, 커밋, 호환, 버전 항목이 있는 화면" },
        crop: [130, 0, 0],
        feature: "plugins",
      },
    ],
  },
  pair: {
    eyebrow: TBD("pair.eyebrow"),
    title: TBD("pair.title"),
    body: TBD("pair.body"),
    pic: { k: "approval-shell", alt: "builtin:bash 승인 창. 중간 위험, OS 격리 활성(asrt)과 거절, 항상 허용, 한 번 허용 버튼" },
  },
  close: {
    before: TBD("close.before"),
    hello: "hello",
    after: TBD("close.after"),
    body: TBD("close.body"),
    cta: "Ave 내려받기",
  },
  footer: {
    tagline: "Ave는 라틴어로 hello. 에이전트가 내가 고른 모델로 내 컴퓨터에서 일하는 데스크톱 작업 환경.",
    copy: "© 2026 Ken Jo",
    menu: "메뉴",
    skip: "본문으로 건너뛰기",
  },
};

const en: HomeCopy = {
  meta: {
    title: "Ave — a desktop work environment where agents work on your computer",
    description:
      "Ave is a desktop app for macOS, Windows and Linux where agents read and change your files, use a terminal and a browser, with the model you choose. Anything that changes something asks first.",
  },
  hero: {
    title: TBD("hero.title"),
    dim: TBD("hero.line2"),
    sub: TBD("hero.sub"),
    download: "Download Ave",
    docs: "Read the docs",
    note: "Apple Silicon Macs, Windows 10 or later (x64), x86_64 Linux. Public builds are not code-signed yet.",
    demo: {
      label:
        "A recreated Ave workspace: you say hello and Ave answers; you ask for a --json export in the trail-notes project; the work panel opens, the agent reads the trail list in Preview, adds the json case to src/export.js, and npm test passes in the terminal, 6 of 6.",
      hello: "hello",
      answer: "hello. What should we work on in trail-notes?",
      ask: "Check the trail list, add a `--json` export, run the tests.",
      done: "Done. `trail-notes export --json` prints the trails as JSON. Tests: `npm test` passes, 6 of 6.",
    },
  },
  statement: TBD("story.sentence"),
  story: TBD("story.body"),
  browse: {
    eyebrow: TBD("browse.eyebrow"),
    title: TBD("browse.title"),
    body: TBD("browse.body"),
    pic: { k: "web-main", alt: "The main area with the trail-notes preview in a web panel beside a terminal" },
  },
  work: {
    eyebrow: "Workbench",
    title: "Four conversations side by side, each on its own loop",
    body: "Window width determines how many of up to four tiles fit. Each tile has its own conversation and loop, so one can wait for an approval while the others keep answering.",
    pic: {
      k: "app-subagents",
      alt: "Three tiles, each holding a different conversation: the --json change with six passing tests on the left, a parser review with its two finished sub-agents at the top right, and a release checklist for 1.2.0 below it",
    },
  },
  hands: {
    title: "One workspace, six hands",
    body: "The web, the terminal and the files the agent works with, and how you choose its model, guard its changes and extend it.",
    tiles: [
      {
        title: "It reads the web",
        body: "A chat docked to the browser pane reads the page and navigates. Tool execution goes through the permission check.",
        pic: { k: "browser-live", alt: "Ave's browser pane on the Trail notes page with the chat docked beside it" },
        crop: [240, -38, -6],
        feature: "browser",
      },
      {
        title: "It runs the terminal",
        body: "In a terminal running a real shell it reads the failed output and, once approved, reruns it in the same shell.",
        pic: { k: "terminal-ask", alt: "The terminal's docked chat reading the failed test output" },
        crop: [230, -34, -4],
        feature: "terminal",
      },
      {
        title: "It edits your files",
        body: "The work panel's Files tab shows the json case it added to src/export.js.",
        pic: "files",
      },
      {
        title: "You pick the model",
        body: "An API key, an OpenAI-compatible server you run, or a plan you already have: three ways to connect.",
        pic: { k: "model-chooser", alt: "The composer's model chooser with local-model selected and a reasoning slider below" },
        crop: [100, 0, 0],
        feature: "models",
      },
      {
        title: "It asks before it changes",
        body: "Writes, shell commands and network requests show their risk and isolation and wait for your approval.",
        pic: { k: "approval-shell", alt: "An approval card for builtin:bash: medium risk, OS isolation active (asrt), and Reject, Always allow and Allow once" },
        crop: [160, 0, 0],
        feature: "security",
      },
      {
        title: "It grows from git",
        body: "A marketplace is a git repository. Installs pin a commit and every file is checked by SHA-256.",
        pic: { k: "install-review", alt: "The plugin install review listing source, commit, compatibility and version" },
        crop: [130, 0, 0],
        feature: "plugins",
      },
    ],
  },
  pair: {
    eyebrow: TBD("pair.eyebrow"),
    title: TBD("pair.title"),
    body: TBD("pair.body"),
    pic: { k: "approval-shell", alt: "An approval card for builtin:bash: medium risk, OS isolation active (asrt), and Reject, Always allow and Allow once" },
  },
  close: {
    before: TBD("close.before"),
    hello: "hello",
    after: TBD("close.after"),
    body: TBD("close.body"),
    cta: "Download Ave",
  },
  footer: {
    tagline: "Ave means hello. A desktop work environment where agents work on your computer, with the model you choose.",
    copy: "© 2026 Ken Jo",
    menu: "Menu",
    skip: "Skip to content",
  },
};

export function homeCopy(locale: Locale): HomeCopy {
  return locale === "en" ? en : ko;
}
