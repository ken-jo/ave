import type { Locale } from "./i18n";

type OS = "mac" | "windows" | "linux";

export interface DownloadStep {
  label: string;
  command?: string;
}

export interface DownloadTarget {
  os: OS;
  osLabel: string;
  title: string;
  format: string;
  href: string;
  setupNote: string;
  steps: DownloadStep[];
  extraNote?: string;
}

/**
 * Download buttons link straight to the installer on the R2 release channel.
 *
 * Installers are published under their version (`releases/Ave-0.14.0-mac-arm64.dmg`),
 * which a static site cannot name ahead of time. The release workflow therefore
 * also writes a stable alias per installer under `latest/`
 * (`scripts/lib/release-channel.mjs`): a copy of the newest versioned file
 * that is always revalidated and downloads under its versioned file name.
 */

/**
 * The release channel's public host. It must equal the origin of
 * `package.json` `build.publish[0].url`, the feed installed apps update from;
 * `test/scripts/release-channel.test.ts` fails when they disagree.
 */
const RELEASE_CHANNEL_ORIGIN = "https://downloads.agent-connector.ai";

/**
 * Whether the release channel holds a published release. While it is false
 * the download page shows each system's card in its "release in preparation"
 * state without the installer link (the alias answers 404 until the first
 * release is uploaded); the setup steps stay readable. Set it to true in the
 * change that follows the first published release.
 */
export const RELEASE_PUBLISHED = true;

/** The stable `latest/` alias for one installer. */
const latest = (file: string) => `${RELEASE_CHANNEL_ORIGIN}/latest/${file}`;

/** Per-OS download targets. `command`, `os`, `osLabel`, `title`, `format`, and
 *  `href` are locale-neutral; only the human-readable notes and step labels vary. */
export function getDownloads(locale: Locale): DownloadTarget[] {
  const en = locale === "en";
  return [
    {
      os: "mac",
      osLabel: "macOS",
      title: "Apple Silicon",
      format: "DMG, arm64",
      href: latest("mac-arm64.dmg"),
      setupNote: en
        ? "The build is not signed with an Apple Developer certificate, so Gatekeeper stops the first launch. Open the DMG, drag Ave into Applications, then run these two commands in Terminal. Intel Macs are not supported."
        : "Apple 개발자 서명이 없는 빌드라 첫 실행을 Gatekeeper가 막습니다. DMG를 열어 Ave를 응용 프로그램 폴더로 옮긴 뒤 터미널에서 아래 두 명령을 실행하세요. Intel Mac은 지원하지 않습니다.",
      steps: [
        {
          label: en ? "Clear the quarantine flag" : "격리 표시 지우기",
          command: 'sudo xattr -dr com.apple.quarantine "/Applications/Ave.app"',
        },
        {
          label: en ? "Open Ave" : "Ave 열기",
          command: 'open "/Applications/Ave.app"',
        },
      ],
      extraNote: en
        ? "An unsigned Mac build cannot replace itself. When Ave offers an update, download the new DMG here and repeat the same two steps."
        : "서명 없는 Mac 빌드는 스스로 교체되지 않습니다. Ave가 업데이트를 알리면 여기서 새 DMG를 받아 같은 두 단계를 반복하세요.",
    },
    {
      os: "windows",
      osLabel: "Windows",
      title: en ? "Windows 10 or later" : "Windows 10 이상",
      format: "Installer, x64",
      href: latest("windows-x64-setup.exe"),
      setupNote: en
        ? "The installer is unsigned, so Microsoft Defender SmartScreen warns on first launch."
        : "서명되지 않은 설치 파일이라 처음 실행할 때 Microsoft Defender SmartScreen 경고가 뜹니다.",
      steps: [
        { label: en ? "Run the installer you downloaded." : "내려받은 설치 파일을 실행합니다." },
        {
          label: en
            ? "When “Windows protected your PC” appears, choose More info."
            : "“Windows의 PC 보호” 창이 뜨면 추가 정보를 누릅니다.",
        },
        { label: en ? "Choose Run anyway." : "실행을 누릅니다." },
      ],
      extraNote: en
        ? "Or: right-click the installer, open Properties, tick Unblock on the General tab, and the warning does not appear."
        : "또는 설치 파일을 마우스 오른쪽 단추로 눌러 속성의 일반 탭에서 차단 해제를 선택하면 경고가 뜨지 않습니다.",
    },
    {
      os: "linux",
      osLabel: "Linux",
      title: "AppImage",
      format: "x86_64",
      href: latest("linux-x86_64.AppImage"),
      setupNote: en
        ? "The AppImage needs no installation. Make it executable and run it."
        : "AppImage는 설치가 필요 없습니다. 실행 권한을 주고 바로 실행하세요.",
      steps: [
        { label: en ? "Make it executable" : "실행 권한 주기", command: "chmod +x Ave-*-linux-x86_64.AppImage" },
        { label: en ? "Run it" : "실행", command: "./Ave-*-linux-x86_64.AppImage" },
        {
          label: en ? "If it says AppImages require FUSE, install FUSE 2" : "AppImages require FUSE 오류가 나면 FUSE 2 설치",
          command: "sudo apt install libfuse2",
        },
      ],
      extraNote: en
        ? "On Ubuntu 24.04 and later the package is libfuse2t64. On Fedora: sudo dnf install fuse fuse-libs."
        : "Ubuntu 24.04 이상은 libfuse2t64, Fedora는 sudo dnf install fuse fuse-libs 를 씁니다.",
    },
  ];
}
