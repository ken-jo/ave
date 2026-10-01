# 멀티 소스 Git 마켓플레이스 — 설계서

> 상태: **구현됨** (2026-09-25). 공개 릴리스와 서버 종료가 남았습니다.
> 출시된 코드가 이 문서와 다른 곳은 §13.1과 §16.4에 적었습니다. §18은 0.13.0
> 다음의 변경(평문 http와 로컬 폴더 소스, 거부 대신 주소 경고, 자동 업데이트)을
> 설계합니다. 영어 원문
> [../../design/multi-source-git-marketplace.md](../../design/multi-source-git-marketplace.md)이
> 기준이고, 이 문서는 그 한국어 미러입니다. 코드 블록과 스키마는 원문과 같습니다.
> 내용이 다르면 영어 원문을 따릅니다.
>
> 아키텍처: [../architecture/proposals/multi-source-git-marketplace.md](../architecture/proposals/multi-source-git-marketplace.md) ·
> 청사진: [../blueprints/multi-source-git-marketplace.md](../blueprints/multi-source-git-marketplace.md) ·
> 목업: [../../design/multi-source-git-marketplace.html](../../design/multi-source-git-marketplace.html)
>
> 이 문서는 계약을 다룹니다. 파일 형식, 알고리즘, IPC, 오류 코드, UI 상태가
> 여기에 있습니다. 코드가 들어오면 코드와 테스트가 기준이 되고, 이 문서는 같은
> 변경에서 갱신합니다.

## 1. 용어

| 용어 | 뜻 |
|---|---|
| **소스(Source)** | 앱이 패키지를 읽어 오는 등록된 git 저장소. 출처(origin)는 `official`(앱에 하드코딩), `managed`(시스템 정책 파일이 등록), `custom`(사용자가 추가), `direct`(마켓플레이스 없이 패키지 하나). |
| **마켓플레이스 저장소** | 루트에 `marketplace.json`이 있거나 관례 레이아웃(§3.3)을 따르는 소스. |
| **패키지** | 설치 단위 하나: `plugin`, `mcp`, `skill`, `agent`, `theme`, `font`, `language`, `provider`, `messaging-connection`. |
| **디스크립터** | 패키지 디렉터리의 `ave-package.json`: 종류, 이름, 버전, 최소 앱 버전, 선언된 권한(authority), 페이로드. |
| **핀(Pin)** | 소스를 현재 읽고 있는 커밋 SHA. 로컬 폴더 소스는 내용 리비전(§18.4.3). |
| **스냅숏** | 한 소스의 한 핀에서 파싱·검증한 카탈로그. 불변. |
| **설치 계획** | 한 패키지 버전에 대해 리졸버가 할 일. 스냅숏 커밋 하나에 묶임: 아티팩트 단계, 파일, 런처, 필요한 동의. |
| **단계(Rung)** | 플러그인 아티팩트 사다리의 한 단계: `release`, `archive`, `tree`. |

## 2. 클라이언트 디스크 상태

```
~/.ave/
  installation-id                     # random UUID, local only (rollout bucketing)
  marketplaces/
    sources.json                      # custom and direct sources (§2.1)
    service.json                      # the service move accepted for this build constant (§11)
    service.staging.json              # the same, for a development staging base (§11)
    updates.json                      # the update scheduler's times and classifications (§7.3)
    <sourceId>/
      repo.git/                       # bare partial clone (blob:none); none for a folder source (§7.7)
      snapshots/<pin>.json            # validated snapshots (§2.2), named by commit or folder revision
      state.json                      # pin, enabled, last sync outcome (§2.1)
  packages/
    <kind>/<name>/<version>/          # installed content packages
    ledger.json                       # installed content packages + origin
    default-installs.json             # default-install keys already applied on this machine (§10.2)
  plugins/                            # unchanged plugin install root
  runtime/git/<version>/              # managed git copy (§9)
```

`installation-id`에는 아무 권한도 없습니다. UUID가 아닌 파일은 새 값으로
바꾸며, 그 설치는 새로 설치한 것과 똑같이 새로운 롤아웃 버킷에 들어갑니다.

### 2.1 소스 기록

```ts
interface SourcesFile {
  version: 1;
  sources: SourceEntry[];             // custom and direct only
}

interface SourceEntry {
  id: string;                 // ^[a-z0-9][a-z0-9-]{1,62}$, reserved names rejected (§5.1)
  origin: "custom" | "direct";
  url?: string;               // a git source: stored in normalized form (§7.1); http with `unencrypted` or a policy listing (§7.4)
  path?: string;              // a folder source instead of `url`: its canonical path (§7.7); exactly one of the two
  ref?: string;               // git only: branch or tag; default = remote HEAD
  subdir?: string;            // git direct sources only: package path inside the repo
  auth: { kind: "none" } | { kind: "token"; host: string } | { kind: "ssh" };   // a folder: { kind: "none" }
  addedAt: string;            // ISO-8601
  label?: string;             // user-visible override of displayName
  acknowledged?: StoredConfirmations;  // confirmations the source holds (§7.4); absent = none
}

interface SourceState {       // marketplaces/<id>/state.json, every origin
  pinnedCommit: string | null;   // 40-hex for a git source, `local-<64 hex>` for a folder (§7.7); null until the first successful sync
  enabled: boolean;              // browsing and installing only (§7.3)
  lastSync?: { at: string; result: "ok" | ErrorCode; candidate?: string };
  pendingRewrite?: { candidate: string; seenAt: string };   // custom/direct awaiting review
  acknowledged?: StoredConfirmations;  // official and managed sources' confirmations (§7.4)
  folder?: { dev: string; ino: string };  // a folder source: the directory's identity when it was added (§7.7)
}

type StoredConfirmations =
  | { url: string; warnings: SourceWarning[] }    // a git source: the normalized address they were given for
  | { path: string; warnings: SourceWarning[] };  // a folder source: the canonical path they were given for
  // another address or path holds none; each warning once

type SourceWarning = "unencrypted" | "token-unencrypted" | "internal-network" | "this-computer" | "internal-downloads" | "network-folder";
```

- 상태의 핀은 소스에 맞아야 합니다. 폴더 소스는 폴더 리비전을 담고 이력
  규칙(`pendingRewrite`, `lastSync.candidate`)이 없으며, git 소스는 커밋을
  담고 `folder` 식별자가 없습니다. 맞지 않는 상태는
  `SOURCE_LOCAL_DATA_DAMAGED` `state-invalid`로 읽히고, 레지스트리는 그런
  상태를 쓰지 않습니다.

- 공식 소스는 빌드 상수 `OFFICIAL_MARKETPLACE`(`id: "ave"`, 기본 URL, 선택적
  미러 URL, `auth`)에서 옵니다. 관리(managed) 소스는 시스템 정책 파일(§12)에서
  옵니다. 둘 다 `sources.json`에 저장하지 않고, 상태만 `state.json`에 둡니다.
- 이 설계를 구현하는 동안 공식 저장소는 프라이빗입니다
  (`https://github.com/ken-jo/agent-marketplace`, 2026-09-23 결정.
  `former_org` 조직에서는 새 공개 저장소를 만들거나 CI를 돌릴 수 없기
  때문입니다. 공식 플러그인 소스까지 담는 모노레포가 되면서 2026-09-24에
  `ave-marketplace-index`에서 이름을 바꿨습니다, §3.1). 그래서 상수는 `auth: { kind: "token", host: "github.com" }`을
  갖고, Sources 화면은 공식 행에도 Set token을 제공합니다. OS 자격 증명 헬퍼도
  응답할 수 있습니다(§9.3). 이 설계로 만든 첫 공개 릴리스 전에 저장소를 공개로
  바꾸거나 옮기고, 그 릴리스의 상수는 공개 URL과 `auth: { kind: "none" }`을
  갖습니다. 프라이빗 URL을 담은 빌드는 배포되지 않으므로 `movedTo` 같은 이전
  절차는 필요 없습니다.
- 토큰은 기존 암호화 시크릿 저장소의 `marketplace.gitToken.<정규화된 호스트>`에
  둡니다. 위 파일 어디에도 시크릿은 없습니다.
- `snapshots/`에는 현재 핀, 직전 핀, 그리고 설치된 패키지의 `origin.commit`이
  아직 가리키는 커밋만 남기고, 나머지는 동기화가 성공할 때마다 정리합니다.
- id·URL 검사를 더는 통과하지 못하는 `sources.json` 항목(예약 id, 관리 소스가
  이제 쓰는 id, 정규형이 아닌 URL)은 파일에 그대로 두되 제공하지 않고, Sources
  화면에 진단으로 보여 줍니다. 그런 항목도 id는 계속 차지합니다. 그 id로
  소스를 새로 추가할 수 없고, 같은 id의 제공 중인 소스를 제거하면 제공 중인
  항목만 지웁니다. `sources.json`을 읽을 수 없으면 공식·관리 소스만
  제공하고, 사용자가 파일을 고치거나 지울 때까지 `SOURCE_LIST_UNREADABLE`로
  쓰기를 거부해 사용자가 추가한 항목을 덮어쓰지 않습니다. 사용자 데이터이므로
  Ave가 고치지 않습니다.
- `state.json`을 읽을 수 없으면 그 소스의 동기화는
  `SOURCE_LOCAL_DATA_DAMAGED`(§18.8)로 실패합니다. 핀이 없는 새 소스로
  취급하지 않습니다. 첫 동기화는 어떤 이력도 받아들이기 때문입니다.
  `repo.git`이나 `snapshots/`가 있는데 `state.json`이 없는 것도 같은
  실패입니다. 동기화는 저장소를 만들기 전에 상태를 먼저 쓰므로, 그런 모습은
  파일을 잃었을 때만 생깁니다. 핀의 스냅숏을 읽을 수 없거나 그것이 다른
  소스·커밋을 가리켜도, git이 열 수 없는 소스 저장소도 같은 코드입니다(동기화는
  이를 네트워크 실패가 아니라 `repository-damaged`로 기록). 그러면 소스 행은
  모든 출처에서 *복구*를 제공합니다. 복구는 소스 잠금 아래에서 충돌에
  안전합니다. 옛 상태를 아직 읽을 수 있으면 먼저 핀과 스위치를 제자리에
  원자적으로 되쓰고, 그다음 `marketplaces/<id>`의 나머지 항목을 하나씩
  `.trash-<id>-<무작위>` 형제 디렉터리로 이름을 바꿔 옮깁니다(소스 id는 점으로
  시작하지 않음). `state.json`은 떠나지 않으므로 어느 단계에서 실패하거나
  중단돼도 핀이 남습니다. 읽을 수 있는 상태가 없으면 디렉터리 전체를 한 번에
  옮깁니다. 옮긴 사본은 링크를 따라가지 않고 `lstat`으로 지우며, 남은 것은 다음
  열기나 복구 때 치웁니다(목록을 읽지 못하면 기록만 남기고 열기나 복구를 실패시키지
  않음). 쓰기 실패는 `repair-write-failed`, 이름 바꾸기 실패는 `repair-failed`
  (유지할 핀이 없었으면 `repair-failed-unpinned`)이고, 어느 것도 읽을 수 있는 핀을
  바꾸지 않습니다. git이 열 수 없는 소스 저장소는 다시 쓰인 이력이 검토를 기다리는
  중에도 복구로 보이고, 그 검토를 수락해도 같은 오류로 알립니다. 읽을 수 있는
  상태가 없으면 핀 없이 시작하므로 그 시점에 제공되는 이력을 받아들이는 것은
  사용자의 복구이고, 행의 문장이 누르기 전에 그렇게 알립니다(`state-missing`,
  `state-invalid`, `state-unreadable`). 스냅숏과 저장소 사유는 핀을 유지합니다.
  설치된 패키지, 토큰, 정책, `sources.json`은 다른 곳에 있어 건드리지 않습니다.

### 2.2 스냅숏

```ts
interface SourceSnapshot {
  sourceId: string;
  commit: string;
  fetchedAt: string;
  marketplace: { name: string; displayName: string; description?: string; owner?: { name: string; url?: string } };
  packages: CatalogPackage[];          // §4, after validation and normalization
  revocations: Revocation[];           // this source's own policy/revocations.json (§10.4)
  diagnostics: SnapshotDiagnostic[];   // per-package rejections, shown in the Sources view
}
```

검증에 실패한 패키지는 진단 메시지와 함께 스냅숏에서 빠지고, 소스의 나머지는
그대로 쓸 수 있습니다. `marketplace.json` 자체가 잘못되면(파싱 불가,
`schemaVersion` 불일치, 중복 키) 후보 커밋 전체를 거부하고 이전 핀을 유지합니다.
`policy/revocations.json`이 잘못된 경우도 같습니다. 그 커밋의 나머지를 받아들이면
폐기 항목이 소리 없이 빠지기 때문입니다. 두 파일 모두 §5.4의 크기 한도 안에서
읽습니다.

### 2.3 레지스트리 출처

`PluginRegistryEntry`에 다음이 추가됩니다.

```ts
origin?: {
  sourceId: string;
  sourceOrigin: "official" | "managed" | "custom" | "direct";
  commit: string;
  packagePath: string;
  version: string;
  rung: "release" | "archive" | "tree" | "folder" | "legacy";   // "folder": a folder source (§7.7); "legacy": bound by the §16.3 migration, no digest yet
  artifactSha256: string | null;   // zip sha256 (release/archive), tree digest (§6.4), null for legacy
  installedAt: string;
};
```

`installSource`는 `user | local-dev`가 됩니다. `admin` 값은 관리 설치 메커니즘과
함께 제거됩니다(§10.1, §16.3). 콘텐츠 패키지도 같은 출처 정보를
`packages/ledger.json`에 기록합니다.

- `commit`은 설치 계획이 묶인 스냅숏 커밋입니다. 그래서 §2.1의 스냅숏 정리가
  그 커밋을 남깁니다.
- `origin`은 git 설치만 씁니다. 파일을 바꾸는 다른 모든 경로(남아 있는 동안의
  카탈로그 설치, 로컬 빌드, 롤백)는 이를 지웁니다. 남겨 두면 자기가 설치하지
  않은 바이트의 출처를 주장하게 되기 때문입니다.
- git 설치는 설치 영수증 스키마 v4를 씁니다. `installSource: "git"`, 서명자와
  허가(admission) 없음, 위와 같은 `artifactSha256`, 그리고 소스·스냅숏 커밋·버전
  커밋·패키지 경로·사용한 단계·사다리 순서의 모든 단계 결과를 담은 `git`
  기록입니다. 서명 설치와 로컬 설치는 v3를 그대로 씁니다.
- 폴더 설치는 `installSource: "folder"`인 영수증 스키마 v4와 `folder` 기록
  `{ sourceId, sourceOrigin, revision, packagePath, treeSha256,
  authoritySha256 }`을 쓰고, 레지스트리 `origin`은 `rung: "folder"`,
  `local-` 커밋, `official`이 아닌 출처로 씁니다. 호스트 시크릿 grant의
  설치(§10.3)가 되지 않고 `process` 진입점을 허가하지 않습니다(§7.7). 기록의
  `consent` 기준선은 슬라이스 F가 더합니다(§18.7.3).

## 3. 마켓플레이스 저장소 레이아웃

### 3.1 공식 모노레포

```
marketplace.json                 # index (generated by CI, committed)
plugins/<name>/ave-package.json # release pins
plugins/<name>/source/           # the plugin's source: package.json, plugin.json, src/, test/
mcp/<name>/ave-package.json     # + optional server.json
skills/<name>/                   # ave-package.json, SKILL.md, resources
agents/<name>/                   # ave-package.json, AGENTS.md
themes/<name>/                   # ave-package.json, theme.json
fonts/<name>/                    # ave-package.json, font.json, files/
languages/<name>/                # ave-package.json, language.json, messages.json
providers/<name>/                # ave-package.json, provider.json
messaging/<name>/                # ave-package.json, connection.json
policy/revocations.json          # revocations of this repository's own packages
templates/plugin/                # starting point for a new plugin (not a package)
contract/                        # the plugin contract, vendored from ave (§5.6)
schemas/                         # descriptor and index schemas, vendored from ave
tools/                           # validator, index generator, plugin build helper
package.json                     # workspaces: plugins/*/source, templates/plugin
.github/CODEOWNERS
.github/workflows/               # validate, index, release
```

공식 플러그인은 이 저장소에서 개발합니다. 소스는 패키지 디렉터리 바로 아래가
아니라 디스크립터 옆의 `source/`에 둡니다. 그래서 패키지 디렉터리에는
`plugin.json`이 없고 트리 단계도 선언되지 않습니다(§6.2). 공식 플러그인은 릴리스
자산으로만 설치되며, 이는 호스트 시크릿 권한(§10.3)의 조건이기도 합니다. 내부
`orion` 플러그인처럼 공식이 아닌 플러그인은 소유자의 저장소에 두고, 그 소유자의
마켓플레이스가 나열합니다.

### 3.2 커스텀 마켓플레이스

패키지 디렉터리 구성은 같고, 선택적인 `policy/revocations.json`도 둘 수
있습니다. 이 파일은 언제나 그 소스에서 설치한 패키지에만 적용됩니다(§10.4).
플러그인 디렉터리에는 트리 단계용 빌드 결과(`plugin.json`, `dist/`, `assets/`)를
둘 수 있습니다(§6.2). `source/`, `templates/`, `contract/`, `schemas/`, `tools/`
디렉터리는 공식 저장소를 만드는 데만 쓰며, 클라이언트는 읽지 않습니다. `marketplace.json`은
손으로 써도 되고, 패키지마다 `path`만 적어도 됩니다(§4.2).

### 3.3 `marketplace.json` 없는 관례 레이아웃

루트에 `marketplace.json`이 없으면 클라이언트는 핀 커밋에서 다음 디렉터리를
한 단계 깊이로 훑어 `ave-package.json`을 찾습니다:
`plugins/ mcp/ skills/ agents/ themes/ fonts/ languages/ providers/ messaging/`.
디스크립터는 자신이 놓인 디렉터리의 종류를 선언해야 하며(`plugins/` →
`plugin`, …), 그렇지 않으면 진단과 함께 빠집니다. 마켓플레이스 이름은 소스 id가
기본값입니다. 인덱스도 없고 이 디렉터리들에
디스크립터도 없으면 마켓플레이스가 아니며, 추가 대화상자는 직접 설치 흐름을
대신 제안합니다.

## 4. `marketplace.json` (인덱스)

### 4.1 스키마

```ts
interface MarketplaceIndex {
  $schema?: string;
  schemaVersion: 1;
  name: string;                     // must equal the source id for official; informative otherwise
  displayName: string;
  description?: string;
  owner?: { name: string; url?: string };
  packages: IndexPackage[];
}

interface IndexPackage {
  kind: PackageKind;
  name: string;                     // unique per kind within this index
  path: string;                     // repo-relative, no "./" prefix, no "..", "/" separators
  displayName?: string;
  description?: string;
  keywords?: string[];
  icon?: string;                    // repo-relative .png/.jpg/.webp, ≤ 256 KB, served from the git tree only
  latest?: string;                  // semver; must be in versions[] and not yanked
  versions?: IndexVersion[];        // newest first; absent = read the descriptor at the pin
}

interface IndexVersion {
  version: string;                  // semver 2.0.0
  commit: string;                   // 40-hex; the commit whose descriptor declares this version
  minAppVersion: string;            // copy of the descriptor's value
  platforms?: Array<"darwin" | "win32" | "linux">;   // copy of the descriptor's value
  authority?: PluginAuthority;      // plugin kind: copy of the descriptor's authority (§5.2)
  artifact?: PluginArtifactPins;    // plugin kind only (§5.2)
  rollout?: { percent: number };    // 1..100; absent = 100
  yanked?: { reason: string; at: string };
  publishedAt: string;
}
```

### 4.2 규칙

- `(kind, name)`과 `path`는 각각 유일합니다. 두 항목이 같은 쌍이나 같은 경로를
  주장하면 모두 진단과 함께 빠집니다. 작성자가 어느 쪽을 뜻했는지 클라이언트가
  알 수 없기 때문입니다. 검증에 실패한 항목도 주장한 것으로 셉니다.
  `(kind, name, version)`은 정확히 한 커밋에
  대응합니다. 기존 버전을 새 커밋으로 다시 게시하면 CI가 거부합니다.
- 버전은 패키지마다 엄격히 증가합니다(기존 플러그인 규칙을 모든 종류로 확대).
  `latest`는 회수(yank)된 버전을 가리키지 않습니다.
- `versions`가 없으면 클라이언트는 핀 커밋의 `path`에서 `ave-package.json`을
  읽고 그것을 유일한 버전으로 취급합니다.
- `schemaVersion: 1`에서는 알 수 없는 루트 키를 거부합니다.

### 4.3 공식 인덱스 생성

CI가 직전 인덱스와 머지 커밋의 디스크립터로 `marketplace.json`을 다시 만들고,
커밋된 파일과 다르면 PR을 실패시킵니다. `main`에 머지하는 것이 곧 게시입니다(D8).
아티팩트 핀을 수정하는 자동화는 릴리스 워크플로(§6.3) 하나뿐입니다.

## 5. 패키지 디스크립터 `ave-package.json`

### 5.1 공통 필드와 이름 규칙

```ts
interface PackageDescriptor {
  $schema?: string;
  schemaVersion: 1;
  kind: PackageKind;
  name: string;                     // plugin: equals plugin.json `name`
  version: string;                  // required, semver
  minAppVersion: string;            // required, plain MAJOR.MINOR.PATCH
  displayName?: string;
  description?: string;
  author?: { name: string; url?: string; email?: string };
  license?: string;                 // SPDX
  homepage?: string;
  icon?: string;
  platforms?: Array<"darwin" | "win32" | "linux">;
  payload: KindPayload;             // §5.2
}
```

- 호환성은 호스트에 이미 있는 `minAppVersion` 계약과 그 비교 함수
  `appVersionSatisfiesMin`(`src/shared/semver-compare.ts`)을 씁니다.
  `appVersion >= minAppVersion`이면 설치·실행하고, 어느 한쪽 값이라도 파싱할 수
  없으면 닫힌 쪽으로 실패합니다. 두 번째 호환성 어휘는 만들지 않습니다.
- 소스 id `ave`, `official`, `ave-official`과 모든 `ave-*` id는 예약되어
  있습니다. 이 검사는 로드할 때마다 다시 합니다.
- 디스크립터의 `icon`은 패키지 디렉터리 기준 경로이고, 스냅숏에는 인덱스의
  `icon`처럼 저장소 기준 경로로 저장합니다.

### 5.2 종류별 페이로드

| 종류 | 페이로드 | 패키지 디렉터리에 둘 수 있는 파일 |
|---|---|---|
| `plugin` | `{ authority: PluginAuthority; artifact: PluginArtifactPins }` | `ave-package.json`; tree 단계면 `plugin.json`, `dist/**`, `assets/**`도 |
| `mcp` | `{ server: McpServerSpec } \| { serverJson: "server.json", select?: { package?: number; remote?: number } }` | `ave-package.json`, `server.json`, 패키지 로컬 stdio 명령용 `server/**`(선택) |
| `skill` | `{ entry: "SKILL.md" }` | `SKILL.md`, `LICENSE`, `NOTICE`, `scripts/**`, `references/**`, `assets/**` (Agent Skills 레이아웃, agentskills.io) |
| `agent` | `{ entry: "AGENTS.md" }` | `AGENTS.md` |
| `theme` | `{ entry: "theme.json" }` | `theme.json`, 미리보기 이미지(선택) |
| `font` | `{ entry: "font.json" }` | `font.json`, `files/*.woff2\|woff\|ttf\|otf`, `LICENSE` |
| `language` | `{ locale: string; entry: "language.json"; messages: "messages.json" }` | 그 두 JSON 파일 |
| `provider` | `{ entry: "provider.json" }` | `provider.json`: 프리셋(현재 `MarketplaceProviderPackageAsset`에서 `type` 제외), 또는 마켓플레이스 대상 내장 벤더의 `{ providerId, defaultModel?, baseUrl? }`(§5.5) |
| `messaging-connection` | `{ entry: "connection.json" }` | `connection.json`(현재 메시징 자산에서 `type` 제외) |

```ts
// Copied verbatim from the plugin's plugin.json (extensions["ai.agent-connector.ave"]).
// The catalog reads it without downloading bytes; install compares it with
// the staged plugin.json (§6.2). It is the trusted "expected" side that
// today's catalog row provides to assertInstalledManifestMatchesCatalog.
// Every field is the manifest's own subschema: the index and descriptor
// schemas reference plugin.schema.json instead of restating it.
interface PluginAuthority {
  capabilities: string[];
  networkAccess?: unknown;          // same shape as the manifest field
  hostSecrets?: { read: string[] };
  pluginAccess?: unknown;
  auth?: unknown;
  requires: { capabilities?: string[]; minAppVersion: string };   // required (§5.3)
  dependencies?: unknown[];         // same shape as the manifest field
}

interface PluginArtifactPins {
  release?: {
    repo?: string;      // "owner/name" on the same host as the source; required in marketplace repositories unless url is set
    tag?: string;       // default "v{version}"
    asset?: string;     // default "{name}-{version}.zip"
    url?: string;       // explicit https URL for non-GitHub release hosts; exclusive with repo, tag and asset
    sha256?: string;    // the pin stored in git; without it the rung is skipped (ARTIFACT_NOT_PINNED)
  };
  archive?: { url: string; sha256?: string };
  tree?: string;        // repo-relative directory holding plugin.json + dist/; default = package path
}

// The host's MCP runtime spec (src/plugins/mcp-runtime-spec.ts) without the
// fields a package may not decide for itself (private-network access, OAuth
// client metadata).
type McpServerSpec =
  | { transport: "stdio"; command: "npx" | "uvx" | "docker" | string; args?: string[];
      env?: Record<string, string>; auth?: "none" | "api-key" | "sso"; apiKeyEnv?: string }
  | { transport: "http"; url: string; auth?: "none" | "api-key" | "sso" | "oauth"; apiKeyHeader?: string };
```

- `release.repo`는 **direct** 소스에서만 생략할 수 있고, 그때는 소스 저장소 자신이
  기본값입니다.
- `npx`, `uvx`, `docker`가 아닌 `stdio` 명령은 패키지 디렉터리 기준 상대
  경로(`server/…`)여야 합니다. 절대 경로, `..`, `\`, `:`, 제어 문자는 거부해
  어느 플랫폼에서도 다른 구분자나 드라이브로 읽히지 않게 합니다.
- `env` 이름, `apiKeyEnv`, `apiKeyHeader`에는 호스트가 예약한 이름
  (`src/mcp/safe-names.ts`)을 쓸 수 없고, 런처가 코드를 어디서 받을지나 무엇을
  신뢰할지 정하는 변수도 쓸 수 없습니다. 대소문자와 상관없이 `npm_config_*`,
  `PNPM_*`, `YARN_*`, `BUN_*`, `COREPACK_*`, `UV_*`, `PIP_*`, `DOCKER_*`,
  `NODE_*`, `PYTHON*`(`PYTHONUNBUFFERED`, `PYTHONIOENCODING`, `PYTHONUTF8`는
  허용), 동적 로더의 `DYLD_*`와 `LD_*`, `XDG_CONFIG_HOME`, `*_PROXY` 변수,
  CA 번들 변수가 여기에 해당합니다.
- 실행되는 MCP 코드는 커밋이 고정합니다. 디스크립터가 직접 쓴 스펙과
  `server.json`에서 만든 스펙 모두 아래 문법을 따라야 하므로, 어떤 옵션도 다른
  레지스트리나 인덱스를 고르거나, 패키지를 더하거나, 컨테이너 권한을 넓힐 수
  없습니다.

  ```
  npx    [-y | --yes]… <package>@<정확한 버전> [서버 인자…]
  uvx    <package>[extras]==<정확한 버전> [서버 인자…]
  uvx    --from <package>[extras]==<정확한 버전> <command> [서버 인자…]
  docker run [-i | -t | --rm | --init | -e NAME[=value] | --network none|bridge]… <image> [서버 인자…]
  ```

  npm 패키지는 레지스트리 이름이어야 하고 URL·경로·git 스펙은 안 됩니다. PyPI
  버전에는 와일드카드가 없어야 하고, docker 이미지는 `latest`가 아닌 태그나
  `@sha256:` 다이제스트를 가져야 합니다. 패키지나 이미지 뒤의 인자는 모두 서버의
  것입니다. 디스크립터가 직접 쓴 docker 이미지는 어느 레지스트리든 될 수 있는데,
  승인 단계가 이미지 참조 전체를 보여 주기 때문입니다.
- `server.json`(스키마 2025-12-11)은 다음과 같이 스펙으로 옮깁니다. npm →
  `npx -y <identifier>@<version> [packageArguments]`, pypi →
  `uvx <identifier>==<version> [packageArguments]`, oci →
  `docker run -i --rm [runtimeArguments] <identifier>[:<version>]
  [packageArguments]`, `streamable-http` 원격 → `http`. 인자와 변수는 `value`,
  없으면 `default`를 쓰고, 이름 있는 인자는 `name value`가 됩니다. `isSecret`
  변수나 헤더 하나는 `auth: "api-key"`와 함께 `apiKeyEnv`나 `apiKeyHeader`가
  됩니다. 거부: `sse`, 다른 레지스트리나 기본값이 아닌 `registryBaseUrl`, Docker
  Hub가 아닌 레지스트리 호스트를 쓰는 oci identifier, npm·pypi의
  `runtimeArguments`(npx와 uvx 옵션은 레지스트리와 추가 패키지를 고름), 위 docker
  문법을 벗어나거나 다른 이미지를 앞세우는 oci `runtimeArguments`, stdio가 아닌
  전송을 쓰는 패키지, `{variable}` 템플릿과 `variables`, 값이 없는 필수 입력, 고정
  값을 가진 원격 헤더, 둘 이상의 비밀. `select`는 패키지 하나나 원격 하나를
  고르며, 없으면 첫 패키지, 그것도 없으면 첫 원격을 씁니다.
- 패키지 로컬 명령은 버전 커밋에서 내보낸 패키지의 `server/` 디렉터리에서
  실행하며, 그 디렉터리에 명령 파일이 있어야 합니다. MCP 아티팩트 저장소가 그
  파일을 설치하고 `$PLUGIN_DIR`이 그곳을 가리킵니다. 패키지 파일 없는
  `$PLUGIN_DIR`과 `$PYTHON`은 거부합니다.
- 인자와 환경변수의 `$DATA_DIR`는 패키지 자신의 데이터 디렉터리
  (`~/.ave/mcp-data/<name>`)입니다. 설치 때 만들고, 업데이트해도 유지하며,
  제거할 때 사용자가 데이터까지 지우기로 고른 경우에만 지웁니다. 상태를
  가지는 서버(DB 파일, 열어 줄 디렉터리)는 이것을 씁니다. `$PLUGIN_DIR`는
  버전마다 교체됩니다. 원격(HTTP) 서버가 `$DATA_DIR`를 쓰면 거부합니다.
  그 자리에는 채울 값이 없기 때문입니다. 토큰은 한 번에 채우며, 이름 문자가
  이어지면 토큰으로 보지 않습니다(`$NODE_OPTIONS`는 그대로 둡니다).

### 5.3 플러그인 매니페스트 변경

git 소스에서 설치하는 플러그인은:

- `extensions["ai.agent-connector.ave"].requires.minAppVersion`이 **필수**이고(로컬 개발
  설치에서는 스키마상 선택으로 남김), 디스크립터의 `minAppVersion`과 같아야
  합니다.
- `PluginAuthority`의 모든 필드가 스테이징된 `plugin.json`과 같아야 합니다.

매니페스트 스키마, `manifest-validation.ts`와 그 테스트에서 한 번의 변경으로
제거합니다(git 마켓플레이스 전환). 함께 바꿀 SDK 사본은 없습니다(§5.6):

- `extensions["ai.agent-connector.ave"].installPolicy` — 관리 패키지가 더는 없습니다(§10.1).
  설치 계획(스테이징과 인덱스 CI)은 이 필드가 남아 있는 매니페스트를 필드 이름을
  밝힌 메시지와 함께 거부합니다. 런타임 로더는 거부하지 않습니다. 지금 설치된 공식
  플러그인은 모두 이 필드를 갖고 있으므로, 필드가 있는 설치본 매니페스트는
  지금처럼 로드되고 필드는 무시되며 플러그인마다 경고를 한 번 남깁니다. 다음
  업데이트가 매니페스트를 바꿀 때까지 그렇습니다(§16.3). 공식 플러그인은 공식
  저장소에서 나가는 첫 릴리스에서 필드를 뺍니다. 필드 고정 버전(§16.3)은
  기존 설치본만을 위한 것이라 필드를 그대로 두며, 그런 버전으로 해석되는 설치는
  같은 이름 명시 거부로 실패합니다.
- `extensions["ai.agent-connector.ave"].publisher` — D4에서는 이 필드가 가리킬 검증된 게시자
  신원이 없습니다.

### 5.4 콘텐츠 검증 한도

| 종류 | 최대 합계 | 최대 파일 수 | 허용 확장자 |
|---|---|---|---|
| skill | 2 MB | 64 | `.md .txt .json .yaml .yml .png .jpg .webp`. `scripts/`는 `.py .js .mjs .cjs .sh .pin` 추가, `assets/`는 `.csv .tsv .pdf .hwp .hwpx .docx .xlsx .pptx` 추가. `LICENSE`, `NOTICE` |
| agent | 256 KB | 1 | `.md` |
| theme | 256 KB | 4 | `.json .png .jpg .webp` |
| font | 20 MB | 32 | `.json .woff2 .woff .ttf .otf` + `LICENSE` |
| language | 4 MB | 2 | `.json` |
| provider, messaging-connection | 64 KB | 1 | `.json` |
| plugin(모든 단계) | 기존 `marketplace-artifact-limits.ts` | | |

마켓플레이스 파일 자체에도 한도가 있습니다. `marketplace.json` 16 MB,
`ave-package.json` 256 KB, `policy/revocations.json` 1 MB입니다. 더 큰
디스크립터는 그 패키지를 진단과 함께 빼고, 더 큰 인덱스나 폐기 파일은 커밋을
거부합니다. git은 blob을 받기 전에는 크기를 알 수 없으므로 한도는 객체가 로컬에
온 뒤 검사하고, 전송 자체는 fetch 제한 시간(§9.3)이 묶습니다.

SVG는 인라인으로 렌더링하면 능동 문서가 되므로 콘텐츠 종류에서 제외합니다.
링크, 장치 파일, 패키지 디렉터리 밖으로 나가는 경로는 거부합니다
(`sideload-filter.ts`, `zip-entry-path.ts` 재사용). 이미지와 폰트는 파일 경로가
아니라 호스트 자산 스킴으로만 렌더러에 전달합니다.

### 5.5 앱에서의 설치된 콘텐츠

콘텐츠 패키지는 `packages/<kind>/<name>/<version>/`에 설치하고
`packages/ledger.json`에 기록합니다. 원장 항목은 `{ kind, name, version,
origin }`이고, origin은 `{ sourceId, sourceOrigin, commit, packagePath,
version, contentSha256, installedAt }`입니다. 콘텐츠에는 단계가 없으므로
`contentSha256`은 설치된 파일의 트리 다이제스트(§6.4)입니다. 원장은 플러그인
레지스트리처럼 스냅샷 보존(§2.3)에 쓰입니다.

- **설치와 로드.** 설치는 파일, 원장, 활성화 순서로 진행하고, 활성화가
  실패하면 이전 설치를 되돌립니다. 되돌리기 단계가 실패하면 로그만 남기고,
  설치가 실패한 원래 오류를 가리지 않습니다. 부팅할 때마다 모든 패키지의
  파일과 다이제스트를 다시 읽고, 더는 맞지 않는 패키지는 적용하지 않고 깨진
  것으로 표시합니다. 로드는 진행 중인 설치가 끝난 뒤에 합니다.
  `requiredInstalls` 패키지는 제거할 수 없습니다
  (`PACKAGE_REQUIRED_BY_POLICY`). 한 패키지 안의 두 경로가 대소문자만 달라서는
  안 됩니다.
- **활성화와 설정.** 설정 쓰기가 실패하면 설치를 되돌립니다. 쓰기가 끝난
  뒤의 새로 고침이나 브로드캐스트 실패는 던지지 않고 로그만 남기므로, 원장에서
  빠진 패키지를 설정이 가리키는 일이 없습니다. 첫 설치는 다른 설치 경로로
  설정에 이미 있는 프로바이더·벤더·연결 id를 가져갈 수 없습니다
  (`PACKAGE_ID_CONFLICT`).
- **테마** — `theme.json`은 `{ name, description, shell: "light" | "dark",
  highContrast, tokens, surfaces, preview? }`입니다. `tokens`는 컴파일된
  번들의 토큰 이름을 모두 `"H S% L%"` 형식으로, `surfaces`는 서피스 단계
  (`surface-sunken` … `border-strong`)를 담습니다. 설치된 테마도 컴파일된
  번들과 같은 토큰 계약과 WCAG 대비 규칙을 지켜야 하고(표는
  `shared/theme-tokens.ts` 하나), 계속 컴파일되어 남는 번들(`moonstone`,
  `gallery`)의 id는 거부합니다. 서버 마켓이 배포하던 번들 14개는 같은 id의
  테마 패키지로 배포되고, 전환 때 컴파일본이 제거되므로(청사진 6.2) 선택값과
  기존 설치가 이름을 그대로 유지합니다. 그 전까지는 같은 id라면 설치된 테마가
  컴파일된 번들보다 우선하고, 기존 설치가 이미 켜 둔 id를 처음 설치하려 하면
  `PACKAGE_ID_CONFLICT`입니다. `preview`는 바이트 기준으로 PNG, JPEG,
  WebP 이미지여야 하고 한 변이 2048 px 이하여야 합니다. 이름과 설명에는 양방향
  재정의 문자나 보이지 않는 문자를 쓸 수 없습니다. 적용은 인라인 사용자 정의
  속성과 해당 shell의 그림자 스택, `color-scheme`으로 합니다.
- **언어** — 로캘 집합은 열려 있어서 올바른 BCP 47 태그라면 무엇이든 됩니다.
  `en`과 `ko`는 계속 컴파일되어 들어가고, 설치된 언어는 자기 로캘을 고유
  이름·영어 이름과 함께 등록합니다. 메시지는 영어 위에 겹치므로 번역하지 않은
  키는 영어로 보입니다.
  - 패키지는 인터페이스만 번역합니다. `messages.json`은 영어 카탈로그 키 중
    모델이 읽는 집합 밖의 키만 쓸 수 있고, 그 집합은 늘 컴파일된 카탈로그에서
    옵니다. 집합에는 `be_*` 네임스페이스(시스템 프롬프트, 도구·리뷰어 문구),
    시스템 프롬프트가 설명하는 셸 실행 환경, 화면이 사용자 메시지로 보내는
    문구가 들어갑니다(`i18n/model-facing.ts`, 모델로 가는 키가 집합 밖에 있으면
    정적 테스트가 실패). 빠진 키는 거부하지 않고 목록으로 남깁니다. 그 밖의
    키는 저장소 검사가 거부하고, 기기에서는 무시해 적용하지 않습니다. 다른 앱
    버전에 맞춰 쓴 패키지는 이 버전이 지웠거나 모델용으로 바꾼 키를 담고 있고,
    이를 거부하면 카탈로그에서 키가 하나 빠질 때마다 설치된 모든 언어가
    깨집니다.
  - 번역은 영어의 자리표시자 집합을 그대로 지켜야 하고, 양방향 재정의 문자와
    보이지 않는 문자를 쓸 수 없습니다. 승인 프롬프트는 적힌 그대로를 물어야
    합니다.
  - 영어(`en`, `en-*`)는 설치할 수 없습니다. 컴파일된 로캘은 정확한 태그로만
    (`ko-KR`이 아니라 `ko`), 공식 또는 관리 소스에서만 설치할 수 있고, 컴파일된
    카탈로그 위에 키를 겹칩니다. 그래서 제거해도 그 언어는 선택된 채로
    남습니다.
  - 로캘당 패키지는 하나이고, 두 번째는 설치 때 거부합니다
    (`PACKAGE_ID_CONFLICT`).
  - 메인 프로세스(대화상자, 메뉴, 알림)도 설치된 로캘을 쓰고, `<html lang>`은
    활성 로캘을 따르며, 공지 레이블은 담기지 않은 로캘에서 영어로 보입니다.
- **폰트** — `font.json`은 `{ family, license, faces: [{ file, weight,
  style }] }`이고 `LICENSE` 파일이 있어야 합니다. 페이스의 형식은 확장자로
  정하고, 바이트가 그 형식과 맞아야 하며, 굵기 범위는 순서대로여야 합니다.
  렌더러는 페이스를 `ave-font-<패키지 이름>`으로, `ave-content:` URL로만
  선언하고, `family`는 선택기의 레이블입니다. 따라서 패키지가 시스템 폰트나
  다른 패키지의 패밀리를 가릴 수 없습니다. 패밀리당 패키지는 하나이고, 두
  번째는 설치 때 거부합니다. 폰트 패밀리 설정은 가장 긴 설치 스택이 들어가도록
  256자까지 받습니다.
- **프로바이더와 메시징 연결**은 지금의 정규화 함수를 거치되 어떤 필드도
  빼거나 고치지 않고, 지금의 자산 설치가 쓰는 설정 경로로 적용됩니다.
  `providerId`가 마켓플레이스 대상 내장 벤더인 프로바이더 패키지는
  `{ providerId, defaultModel?, baseUrl? }`이고, 그 벤더를 잠금 해제하며
  (`marketplace.installedProviderIds`) 기본 모델을 정할 수 있습니다. 벤더의
  키는 `baseUrl`이 가리키는 곳으로 가므로, `baseUrl`은 공식 또는 관리 소스만
  https로 정할 수 있고, 바꾸면 프리셋의 base URL이 바뀔 때처럼 이전 주소에
  저장된 키를 지웁니다(설정 쓰기가 실패하면 키를 되돌리고 설정도
  이전 주소에 남음). 패키지를 제거하면
  벤더를 다시 잠그고, 패키지 주소용으로 입력됐을 수 있는 키도 지웁니다.
- **선택은 사용자의 몫입니다.** 설치해도 테마·언어·폰트를 선택하지 않습니다.
  선택된 것을 제거하면 그 설정은 기본값으로 돌아가고, 설치되지 않은 id가
  선택되어 있으면 기본값으로 그립니다.
- **자산 스킴.** `ave-content://<token>/<kind>/<name>/<path>`는 로드된 저장소가
  나열한 파일(폰트 페이스, 테마 미리보기)에만 `nosniff`로 답하고, 나머지는
  404입니다. CSP는 `img-src`와 `font-src`에만 이 스킴을 허용합니다. 앱이 여는
  웹 페이지도 기본 세션을 함께 쓰고 origin·referrer 없는 요청을 보낼 수 있으므로,
  모든 URL의 호스트는 실행할 때 뽑은 무작위 토큰이고 이 토큰은 앱의 렌더러만
  받습니다. 토큰이 없는 URL은 404이므로 웹 페이지는 설치된 파일을 가리키거나
  확인하거나 읽을 수 없습니다. 응답은 앱의 `file:` 창이 가진 불투명 origin만
  허용하고(`Access-Control-Allow-Origin: null`), http(s) origin이나 referrer가
  붙은 요청은 거부합니다. 프레임은
  커밋될 때 사용자 정의 스킴 로더를 묶으므로, 핸들러는 메인 창이 로드되기 전에
  IPC 핸들러와 함께 등록합니다.
- **로드 시점.** 저장소는 IPC를 등록할 때가 아니라 부팅 중 렌더러의 첫 요청
  (또는 첫 자산 요청) 때 로드합니다. 묻지 않는 프로세스는 `packages/` 아래를
  읽지 않습니다.
- 설치·제거 IPC는 설치 화면(§13)과 함께 들어옵니다. 그 전까지는 읽기 전용 채널
  두 개가 설치된 콘텐츠를 보여 줍니다.
- **6.2까지의 공존.** 기존 마켓플레이스 설정(`installedThemeBundleIds`,
  `installedLanguagePacks`, 자산 설치의 벤더·프리셋 경로)은 블루프린트 6.2가
  옮길 때까지(§16.2) 원장과 나란히 동작합니다. 위의 id 충돌 규칙이 둘이 같은
  id를 차지하지 않게 막습니다.
- **스냅샷 보존.** `contentLedgerOrigins`가 원장의 `retainedCommits`
  출처이고, 싱커는 블루프린트 6.1에서 설치 IPC와 함께 여기에 연결합니다.

### 5.6 플러그인 작성자를 위한 계약

코드 플러그인은 ave의 두 파일에 맞춰 컴파일합니다.

- `src/plugins/public-contract.ts`: 타입, 런타임 ABI 상수,
  `flattenAgentPluginsManifest`, 저장소 오류 클래스.
- `schemas/plugin-manifest.schema.json`.

두 파일 모두 아무것도 import하지 않습니다. 별도 SDK 패키지는 없습니다.
`ave-plugin-sdk` 저장소는 이 두 파일을 자기 버전 번호로 미러했습니다. SDK
태그가 어느 앱 릴리스에 해당하는지 대응시키는 것은 같은 계약에 번호를 두 번 매긴
셈이었고, 아무도 그 대응을 검사하지 않았습니다. 이 저장소는 첫 공개 릴리스 뒤
서버와 함께 보관합니다.

- **복사해 두기.** 플러그인 저장소는 두 파일을 ave 릴리스 태그 시점
  그대로 `contract/`에 복사합니다. 공식 모노레포일 수도 있고, 내부 `orion`
  플러그인을 담은 저장소 같은 다른 저장소일 수도 있습니다.
  `contract/sources.json`에는 저장소, 태그, 파일별 sha256을 기록합니다.
  플러그인 코드는 이 사본을 워크스페이스 패키지 `@ave/plugin-contract`로
  import합니다.
- **두 가지 검사.** 호스트가 스키마 스냅숏에 이미 쓰는 짝입니다.
  - 오프라인 검사는 모든 CI에서 돕니다. 커밋된 바이트가 `sources.json`의 해시와
    다르면, 즉 누가 사본을 고치면 실패합니다.
  - 네트워크 검사는 기록된 태그의 파일이 그 바이트가 아니면 실패합니다.
    `contract/`를 건드린 PR과 매일 돌고, 새 앱 릴리스가 계약을 바꿨는지도
    알려 줍니다.
  - 사본을 갱신하려면 새 태그로 동기화 스크립트를 돌립니다. 사본을 직접 고치지
    않습니다.
- **계약 버전 = 앱 버전.** 릴리스 X에서 처음 나온 멤버를 쓰는 플러그인은
  `requires.minAppVersion`을 X 이상으로 설정합니다. 호스트는 이미 설치와 로드
  때 `minAppVersion`을 검사하고, git 설치에서는 이 필드가 필수입니다(§5.3).
  그래서 더 새 계약에 맞춰 빌드한 플러그인이 그 계약이 없는 앱에서 로드되는
  일은 없습니다.
- **런타임.** 빌드는 플러그인이 런타임에 import하는 것을 `HOST_EXTERNAL_MODULES`만
  빼고 모두 플러그인 자신의 `dist/`에 번들합니다. 그래서 설치된 플러그인은 계약
  패키지에 의존하지 않고, 호스트는 지금처럼 설치와 로드 때 매니페스트를
  검증합니다.
- **빌드 헬퍼.** SDK의 tsup 프리셋인 `defineAvePluginConfig`는 공식 저장소의
  `tools/`로 옮깁니다. 복사해 둔 계약에서 `HOST_EXTERNAL_MODULES`와
  `BUNDLE_EVERYTHING_REGEX`를 읽습니다. 다른 저장소는 이를 복사하거나 직접
  작성하면 되고, 헬퍼 자체에는 계약이 없습니다.
- **패키지 스키마.** 마켓플레이스 배포에서는 디스크립터(§5.1–5.2)가 SDK의 스킬·
  에이전트 패키지 스키마를 대신합니다. 호스트에 여전히 필요한 것은 하나, 호스트가
  구현하는 SKILL.md front matter 정의입니다.
  - 그 정의는 폐기된 저장소 파일의 스냅숏인 `schemas/sdk/skill-package.schema.json`에서
    호스트 소유 `schemas/skill-package.schema.json`으로 옮겼습니다.
  - 스냅숏 게이트는 청사진 6.3에서 제거했습니다: `check:sdk-schemas`,
    `check:sdk-schemas:verify`, `sdk-schema-drift.yml`.
- **최종 상태가 아닌 과도기.** 코드 플러그인은 호스트 프로세스 안에 그대로
  있습니다. 여기서는 컴파일 타임 타입이 플러그인이 부르는 HostApi를 미리
  검사하는 유일한 수단입니다. 플러그인을 프로세스 밖으로 옮기는 일은 별도
  설계인 `docs/design/plugin-hostapi-protocol.md`에서 다룹니다. HostApi를 버전이
  있는 프로토콜로 바꾸고, 복사해 쓰던 타입 대신 공개된 프로토콜 스키마를
  씁니다.

## 6. 해석(Resolution)

### 6.1 버전 고르기

한 소스 스냅숏의 패키지 행에 대해:

1. `appVersionSatisfiesMin(appVersion, minAppVersion)`이 거짓인 버전을 뺍니다.
2. 회수된 버전을 뺍니다(이력에는 보이고, 이미 설치된 회수 버전은 계속 실행되며
   사유와 함께 "yanked"로 표시).
3. `platforms`가 현재 OS를 제외하는 버전을 뺍니다.
4. `marketplace.canaryOptIn`이 꺼져 있으면 프리릴리스 버전을 뺍니다.
5. 롤아웃이 이 설치본을 제외하는 버전을 뺍니다:
   `bucket = uint32(sha256("${installationId}:${sourceId}:${kind}:${name}:${version}")[0..4]) % 100`,
   `bucket < percent`일 때 대상.
6. 같은 소스가 폐기(revoke)한 버전을 뺍니다(§10.4).
7. 남은 것 중 가장 높은 버전이 **후보**입니다. 남은 게 없는데 1단계 때문에만
   빠진 버전이 있으면, 행은 가장 최신 버전의 `minAppVersion`과 함께
   `upgrade_required`로 표시합니다. 그 밖의 경우 행은 이유와 함께
   `unavailable`입니다. 모든 버전이 폐기되면 `revoked`, 모든 버전이 yank되거나
   폐기되면 `yanked`, 어떤 버전이 롤아웃이나 프리릴리스라는 이유만으로 빠지면
   `pending`, 나머지는 `withheld`입니다. 이 행을 설치하면 `PACKAGE_REVOKED`,
   `PACKAGE_YANKED`, `PACKAGE_INCOMPATIBLE` 중 하나로 실패합니다(§14).

### 6.2 플러그인 아티팩트 사다리

git 소스의 사다리입니다. 폴더 소스의 플러그인은 단계가 `folder` 하나이고
아무것도 내려받지 않습니다(§7.7).

```
plan = { snapshotCommit, versionCommit, rungs: [] }        // fixed at plan time
for rung in [release, archive, tree]:
  if rung not declared                               -> skip(rung, NOT_DECLARED)
  if rung in {release, archive} and no sha256 pin    -> skip(rung, ARTIFACT_NOT_PINNED)
  fetch rung                                          // every URL passes §7.4 first
    release: https GET (token only to the origin host; auth headers stripped on cross-host redirects;
             a private asset is fetched with the token only through the GitHub REST asset API
             on github.com; elsewhere the rung runs without it and a private asset falls to the next rung)
    archive: https GET (same rule)
    tree:    export `tree` at versionCommit (§9.3)
  on transport error                                 -> fail(rung, SOURCE_UNREACHABLE / …) and continue
  verify
    release/archive: sha256(zip) == pin, zip limits, entry paths
    tree:            file rules, no links, digest computed (§6.4)
  on verification error                              -> fail(rung, ARTIFACT_DIGEST_MISMATCH / …) and continue
  stage, then compare plugin.json with the descriptor:
    name, version, requires.minAppVersion, every PluginAuthority field
  on mismatch                                        -> stop with MANIFEST_MISMATCH (do not try lower rungs)
  return staged artifact
stop with NO_INSTALLABLE_ARTIFACT(rungs[])
```

- 계획은 `snapshotCommit`과 해당 버전의 커밋을 기록하고, 실행은 그 둘만
  씁니다. 계획과 실행 사이에 동기화가 핀을 옮겨도 설치 결과는 바뀌지 않습니다.
- 매니페스트 불일치는 사다리를 멈춥니다. 패키지 자체가 모순인데 다른 단계를
  시도하면 그 사실을 가리게 됩니다.
- 모든 단계의 결과(`used`, `skipped: 사유`, `failed: 코드`)는 사용자에게 보이는
  계획의 일부이고 영수증(receipt)에도 기록됩니다.
- 의존성 사전 점검(`dependency-resolver.ts`, `requires.capabilities`)은 지금
  카탈로그 행에서 하듯, 다운로드 전에 디스크립터의 authority로 실행합니다.
- 어느 단계보다 먼저, 버전 커밋의 디스크립터가 인덱스 사본과 같은 내용(kind,
  name, version, `minAppVersion`, `platforms`, `authority`, `artifact`)이어야
  합니다. 다르면 `MANIFEST_MISMATCH`입니다. 플러그인이 아닌 종류는 모두 그
  디스크립터에서 페이로드를 읽습니다.
- tree 단계는 `artifact.tree`로, 또는 패키지 디렉터리의 `plugin.json`(기본값)으로
  선언됩니다. `plugin.json`, `dist/**`, `assets/**`만 설치하고, 그 밖의 최상위
  항목이 있으면 그 단계가 실패하며, `ave-package.json`은 설치하지 않습니다.
  구성과 파일 수는 blob을 받기 전에 트리만 보고 확인하므로, 저장소 루트에 있는
  direct 소스라도 거부되기 전에 저장소 전체를 받게 만들 수 없습니다. 바이트
  합계는 blob이 도착해야 알 수 있으므로, §5.4처럼 fetch 제한 시간이 전송을
  묶습니다. 내보낸
  파일은 zip으로 묶으므로 모든 단계가 같은 zip 사전 점검과 설치 파이프라인을
  거칩니다.
- 스키마에서 `release.sha256`과 `archive.sha256`은 선택 항목입니다. 핀 없이
  선언된 단계는 `ARTIFACT_NOT_PINNED`로 건너뛰고 다음 단계로 갑니다.
- `url`이 없는 release는 `<origin>/<repo>/releases/download/<tag>/<asset>`에서
  받습니다. origin은 https 소스(또는 정책이 허용한 http 호스트)면 소스의
  origin이고, ssh 소스면 기본 포트의 `https://<host>`입니다. ssh 포트는 웹
  서버에 대해 아무것도 알려 주지 않기 때문입니다. `repo`는 `owner/name`이며 어느
  부분도 `.`이나 `..`일 수 없습니다. 소스가 `github.com`에서 토큰 인증을 쓰고
  토큰이 저장되어 있으면 GitHub REST API로 받습니다.
  `api.github.com/repos/<repo>/releases/tags/<tag>`에서 자산 id를 얻고
  `…/releases/assets/<id>`를 `Accept: application/octet-stream`으로 요청합니다.
  비공개 저장소를 내주는 경로가 이것이기 때문이며, 응답이 리디렉트하는 저장소
  호스트에는 토큰이 가지 않습니다(§7.4). 요청 전에
  `https://github.com/<repo>/releases/download/…`에 정책을 적용하므로 저장소
  차단 규칙이 이 경로에도 걸립니다. 이 경로에는 정책 허용 목록이
  `api.github.com`을 허용해야 합니다.
- release와 archive 다운로드는 아티팩트 한도를 넘을 수 없고, 60초 동안 데이터가
  없으면 실패합니다.

### 6.3 공식 릴리스 흐름

공식 플러그인은 공식 저장소에서 빌드합니다(§3.1). 소스, 릴리스 자산, 핀이 한
저장소에 있습니다.

1. PR이 `plugins/<name>/source/`를 바꾸고 `plugin.json`과 `package.json`의
   버전을 함께 올립니다. CI는 플러그인을 빌드하고 테스트합니다. 두 버전이
   다르거나, 새 버전이 디스크립터에 이미 있는 모든 버전보다 크지 않으면 검증이
   실패합니다.
2. 머지 후 `main`에서 릴리스 워크플로가 돕니다. 소스 버전에 해당하는
   `<name>-v<X.Y.Z>` 태그가 아직 없는 플러그인마다, 머지 커밋에서
   `{name}-{X.Y.Z}.zip`을 빌드합니다. 그다음 그 태그와 zip을 자산으로 담은
   릴리스를 만듭니다. 이미 있는 태그는 다시 빌드하거나 다시 올리지 않습니다.
3. 같은 워크플로가 `plugins/<name>/ave-package.json`에 대한 핀 PR을 엽니다.
   올린 자산에서 `version`, `minAppVersion`, `authority`, `artifact.release`를
   채웁니다. `repo`는 이 저장소이고, `tag`, `asset`, `sha256`을 함께 씁니다.
4. 핀 PR의 CI가 자산을 내려받아 해시를 검증하고, 풀어서 `plugin.json`을
   디스크립터와 대조하고, 인덱스를 다시 만듭니다.
5. 머지 = 게시.

소스 변경과 핀은 따로 머지합니다. 어떤 버전을 빌드하고 테스트했다고 해서 그
버전이 게시되지는 않습니다.

### 6.4 트리 다이제스트

tree 단계의 `artifactSha256`은 설치하는 모든 파일(디스크립터는 설치하지 않음)에 대해
`"<mode> <sha256(file)> <path>\n"` 줄을 경로 바이트 순으로 정렬해 이은 것의
`sha256`입니다(`mode` ∈ {`100644`, `100755`}). 영수증에 기록되며, 같은 버전을
나중에 다시 설치했을 때 같은 바이트를 받았음을 증명합니다.

## 7. 소스 수명주기

### 7.1 URL 정규화

함수 하나, `normalizeSourceUrl(input)`이
`{ scheme: "https" | "ssh" | "http", host, port, path }`와 저장용 문자열을
만듭니다.

- `owner/repo` → `https://github.com/owner/repo`.
- scp 형식 `user@host:path` → `ssh://user@host/path`.
- 호스트: 소문자, IDNA를 ASCII로, 기본 포트 제거.
- 경로: 퍼센트 인코딩 정규화, 끝의 `/`와 `.git` 제거.
- `http://`는 여기서 받습니다. 확인이 필요한지, 정책이 막는지는 게이트가
  정합니다(§7.4).
- 다음은 트래픽 전에 `SOURCE_URL_REJECTED`와 사유(§14)로 거부합니다.
  - `<helper>::` 전송(`ext::`, `fd::`, `hg::https://…`): `helper-transport`.
    `ext::`는 그 텍스트를 명령으로 실행하고, 다른 도우미는 검색 경로에서
    `git-remote-<helper>`를 실행합니다(§18.3 #1).
  - URL 안의 자격 증명(`https://user:secret@…`, `https://token@…`):
    `credentials-in-url`. ssh 사용자 이름(`git@`)은 자격 증명이 아닙니다
    (§18.3 #2).
  - 그 밖의 스킴(`git:`, …): `scheme-unsupported`.
  - 쿼리, 프래그먼트, 공백, 제어 문자, 역슬래시: `format`. 점·빈 경로
    세그먼트.

  `file:` URL이나 경로는 이 함수에 오지 않습니다. `normalizeSourceInput`
  (`src/marketplace/net/source-input.ts`)이 이를 §7.7의 폴더 단계로 보내고,
  `owner/repo`는 GitHub 약식으로 남깁니다.

정책 allow/block 매칭(§12), 예약 이름 검사, 토큰 조회, 중복 감지는 모두 정규화된
형태를 씁니다. 이 비교에서 저장소의 동일성은 호스트와 대소문자를 무시한 경로이며,
스킴과 포트는 따지지 않습니다(§12).

### 7.2 추가 (미리보기 → 확정)

1. 입력을 **정규화**하고(§7.1) 게이트의 거부와 관리 정책(§7.4)을 적용합니다.
   거부나 정책 차단이면 미리보기는 거기서 끝납니다.
2. **트래픽 전에 확인합니다.** 주소만으로 알 수 있는 경고가 있습니다. 평문
   `http`, 리터럴 주소의 분류, http 위의 토큰 로그인(`token-unencrypted`)입니다.
   요청의 `acknowledge`에 그중 하나가 없으면 미리보기는
   `{ type: "confirm", warnings }`로 답합니다. 그 전에 조회도 git 명령도 하지
   않습니다.
   다음으로 실행기의 사전 검사가 호스트를 한 번 해석합니다(ssh 원격은 §7.4의 ssh
   사전 검사). 확인이 필요한 분류이면 git 명령 전에 같은 방식으로 `confirm`을
   답합니다. 대화상자의 *계속*은 그 경고를 `acknowledge`에 더해 다시
   미리봅니다.
3. ref를 임시 bare 저장소로 **가져와** 루트를 읽습니다.
   - 인증 실패는 `SOURCE_AUTH_REQUIRED`이고 대화상자가 토큰을 묻습니다.
     `token-unencrypted` 없는 http에서는 자격 증명을 내주지 않고, 호스트의
     401에 대신 `token-unencrypted`로 `confirm`을 답합니다.
   - 모르는 SSH 호스트 키는 `SOURCE_SSH_HOST_UNKNOWN`입니다.
   - 없는 ref는 `SOURCE_REF_NOT_FOUND`입니다.
4. **분류**: 마켓플레이스(인덱스 또는 관례 레이아웃) → 미리보기, 단일 패키지(루트나
   지정한 하위 경로의 디스크립터, `plugin.json`, `SKILL.md`, `AGENTS.md`,
   `server.json`) → 직접 설치 미리보기, 그 밖에는 `SOURCE_NOT_A_MARKETPLACE`.
5. **미리보기**가 돌려주는 것:
   - `previewId`(1회용, 10분 뒤 만료, 만료나 취소 시 임시 저장소 삭제);
   - 해석된 커밋, 마켓플레이스 이름과 소유자;
   - 종류별 패키지 수, 코드를 실행하는 패키지 수(플러그인 + MCP);
   - 검증 진단;
   - `badges`: 추가한 뒤 소스가 보일 배지(http면 `unencrypted`, 그리고 확인한
     각 주소 분류).
6. **확정**하면 미리보기가 실은 확인을 그대로(`acknowledged`) 담아 항목을 쓰고,
   소스의 `state.json`을 쓴 다음 임시 저장소를 제자리로 옮기고 스냅숏을
   게시합니다. 상태 없이 `repo.git`만 있으면 상태를 잃은 것으로 읽습니다(§2.1).
   추가할 때 정책을 다시 검사하므로, 미리보기 뒤에 바뀐 정책이 적용됩니다.
   - id 기본값은 인덱스 `name`입니다.
   - 예약되었거나 이미 쓰는 id(`SOURCE_ID_TAKEN`)면 다른 id를 묻습니다.
   - 형식이 틀린 id는 `SOURCE_ID_INVALID`입니다.

### 7.3 동기화

모든 소스의 동기화가 **탐색**입니다. 탐색은 가져온 폐기를 집행하고(§10.4) 설치된
패키지의 업데이트를 계산합니다. 부팅 때(디스크에 이미 있는 폐기를 집행한 뒤, 기본·필수
설치 전, §10.2), 기한이 되었을 때, *지금 확인*에서 돌고, 소스 하나의 *새로 고침*은 그
소스만 동기화합니다. 스케줄러 하나(`src/marketplace/app/background.ts`)가 **기한 확인**을
한 시간을 넘기지 않는 간격으로, `powerMonitor` `resume` 때, `marketplace` 설정을 쓴 뒤,
*지금 확인*(`ave:marketplace:updates:check`)에서 실행합니다.

- **탐색의 기한**: 실패한 시도(`partial`, `offline`, `error`) 뒤에는 `lastSuccessAt`과
  관계없이 `lastAttemptAt`이 한 시간 지났을 때, 성공 뒤에는 `lastSuccessAt`이
  `marketplace.updateCheckIntervalMs`만큼 지났을 때입니다. 설정은 키를 유지합니다.
  비어 있으면 6시간, 저장값이 15분보다 작으면 15분으로 읽고, `0`이면 탐색은 부팅,
  *지금 확인*, 실패 뒤 매시간 재시도, 적용 확인에서만 돕니다. 선택 항목이고 기본으로
  비어 있으므로 이관할 저장값은 없습니다.
- **적용 확인의 기한**: 부팅 때, *지금 확인*에서, 마지막 성공한 적용 확인 24시간 뒤이며,
  실패한 탐색은 적용 확인도 같은 매시간 재시도에 묶습니다. 적용 확인은 언제나 새 탐색을
  얻고(진행 중인 탐색에 합류하거나 새로 시작) 그 탐색의 업데이트만 분류합니다. 결과가
  `ok`면 모두 분류하고 확인이 끝날 때 `applyCheckAt`을 쓰며, `partial`이면 닿은 소스의 업데이트만,
  `offline`이나 `error`면 아무것도 분류하지 않습니다. 이 빌드는 모든 업데이트를
  `manual`로 분류합니다. 자동 적용(§18.7.2–§18.7.4)이 구현되기 전에는 아무것도 스스로
  적용되지 않으므로, 각 업데이트는 검토(§15.6)를 기다립니다.
- **탐색 결과**: 모든 소스가 동기화되면 `ok`, 모든 소스가 `SOURCE_UNREACHABLE` 사유
  `offline`으로 실패하면 `offline`, 그 밖에는 `partial`, 패스가 예외를 던지면 `error`입니다.
  망가진 소스(§18.8)는 동기화하지 않고 오프라인도 아니어서 닿지 않은 것으로 세므로, 그런
  소스가 있는 탐색은 `partial`이고 카드는 소스 화면으로 안내합니다. 탐색 시각과
  `applyCheckAt`은 끝날 때 기록하므로, 느리게 실패한 탐색을 끝나자마자 다시 시도하지 않고
  절전을 넘긴 확인이 끝나자마자 다시 기한이 되지도 않습니다.
- **게시하는 것**은 마지막 탐색이 닿은 소스를 따릅니다. 닿은 소스의 업데이트는 분류하고,
  닿지 않은 소스의 업데이트는 그 소스의 캐시된 스냅샷에서 온 것이므로 새로 분류하지
  않습니다. 패키지가 같은 버전을 계속 제공하는 동안에만 이전 탐색이 보인 그대로
  `stale`로 표시해 보이고, 그렇지 않으면 보이지 않습니다. 예외를 던진 탐색은 어느 소스에도
  닿지 않은 것이므로 보이던 것은 모두 같은 방식으로 `stale`이 되고, 그 뒤 캐시된 버전은
  탐색이 그 소스에 닿을 때까지 분류하지 않습니다.
- **멈춘 스케줄러**(종료 때 `stop()`)는 더 아무것도 하지 않습니다. 생명주기 게이트 하나가
  바깥으로 나가는 모든 효과를 맡습니다. 네 가지 게시(`publishStatus`, `publishNotice`,
  `publishUpdates`, `publishUpdateStatus`), 스케줄러 밖의 상태를 읽거나 바꾸는 모든
  호출(서비스 열기, `enforceRevocations`, `discover`, `takeRevocationNotice`, `updates`,
  `applyBootInstalls`, 적용된 기본값 읽기, `updates.json` 읽기), `updates.json`의 모든
  쓰기(읽을 수 없는 파일의 교체 포함 — 로더는 알리기만 하고 스케줄러가 씀), 기한 확인
  타이머입니다. 멈춘 뒤 게이트는 게시를 버리고 작업을 거부하며, 진행 중이던 작업은 성공하든
  거부되든 멈춤으로 끝나므로 어떤 후속 작업도 게시·기록·로그·새 작업을 하지 않습니다.
  서비스는 `discover`, `enforceRevocations`, `applyBootInstalls`와 함께 게이트의 종료
  신호를 받습니다. 신호가 중단되면 다음 단계(동기화, 집행, 부팅 설치의 카탈로그, 다음 부팅
  설치, 다른 집행 뒤에 줄 서 있던 집행)를 시작하지 않고 동기화 진행도 보내지 않으며, 이미
  시작한 단계는 끝납니다. 내부 후속 작업이 그래도 보내는 것은 경계 한 곳에서 막힙니다. IPC
  도메인은 서비스, 동기화기, 폐기 싱크를 `marketplaceEvents`로 만들어, 그 바깥 콜백
  (`onSyncProgress`, `onInstallProgress`, 서비스·동기화기·싱크의 `onCatalogChanged`)과
  스케줄러의 게시 네 가지를 마켓플레이스 수명(`getMarketplaceLifetime`, 도메인·git 런타임·
  딥링크가 공유) 위의 `whileRunning`에 통과시킵니다. 플러그인 포트가 설치 완료를 알리는
  것(호스트 구독자에게 `plugin.installed`, 플러그인 브리지 새로 고침)도 같은 경계를 지나고,
  git 런타임의 설치 진행(`git-runtime:progress`)도 그렇습니다. 마켓플레이스 딥링크는 수명이
  끝나면 무엇을 붙잡거나 열거나 보내기 전에 거부됩니다. 종료 hook 하나
  (`git-marketplace-events`, 도메인 등록 때 등록)가 그 수명을 중단하고 같은 단계에서
  스케줄러를 멈춥니다. 동기화와 설치, 그 기록은 끝나지만 그것들이 보내는 것은 렌더러에도
  호스트 구독자에게도 닿지 않습니다.
  `updates.json` 로더는 쓰지도 로그를 남기지도 않고 리셋한 이유를 돌려주며, 스케줄러가
  게이트를 거쳐 알립니다. *다시 시도*(`ave:bootstrap:retry`)와 *지금 확인*은 선언된 거부
  응답으로 답합니다.

스케줄러는 시각을 `~/.ave/marketplaces/updates.json`에 두므로 주기가 재시작과 절전을
넘어 유지됩니다. 타이머는 기한 확인을 깨울 뿐이고, 기한 확인은 벽시계를 읽습니다.
타이머는 unref 상태로, 확인할 때마다 다시 걸리고 종료 때 지워집니다. 멈춘 스케줄러는
아무것도 시작하지 않습니다.

```
{ version: 1,
  discovery: { lastAttemptAt, lastSuccessAt, result: "ok" | "partial" | "offline" | "error" } | null,
  applyCheckAt: string | null,
  packages: { "<sourceId>:<kind>:<name>": { to, state, attempts, lastError?: { code, detail?, at }, appliedAt? } } }
```

파일은 엄격하게 읽습니다. 중복이나 모르는 키, 다른 버전, 해석되지 않는 시각,
§18.7.5의 여덟 상태 밖의 상태가 있으면 거부합니다. 읽을 수 없는 파일은 빈 파일로 바꾸고
업데이트 카드가 그렇게 알립니다(`historyReset`, §15.7.1). 그 영향은 확인 시각뿐이고
무엇이 적용되는지는 바뀌지 않습니다. `lastError.detail`의 사유가 코드에 속하지 않으면
`state.json`(§14)처럼 detail만 버리고 코드는 유지합니다.

설정 `marketplace.autoUpdate`(불리언, 비어 있으면 켬), `marketplace.autoUpdateSources`(소스
ID 키), `marketplace.autoUpdatePackages`(`packageUpdateSkipKey` 키,
`skippedPluginUpdates`처럼 정규화)는 값이 `"on"`이나 `"off"`이며 읽을 때 정규화합니다.
잘못된 키나 값은 버리고, 두 맵 모두 프로토타입이 없습니다. 자동 적용(§18.7.2) 전에는
아무것도 정하지 않습니다.

소스는 켜져 있을 때 **또는** 그 소스에 묶인 설치 패키지가 하나라도 있을 때
동기화하므로, 숨긴 소스에서 설치한 패키지에도 폐기와 업데이트 알림이 계속 도착합니다.

```
fetch ref with --filter=blob:none (full commit history, no --depth, no tags except the ref)
candidate = resolved commit
if candidate == pin: done
if not is_ancestor(pin, candidate):
  official, managed -> keep pin, SOURCE_HISTORY_REWRITTEN
  custom, direct    -> keep pin, set pendingRewrite; the user may accept it in the update review
parse + validate index at candidate
  invalid -> keep pin, SOURCE_INDEX_INVALID
write snapshots/<candidate>.json, then atomically set pin = candidate
emit marketplace:catalog-changed
```

- blob 없는 커밋과 트리는 작으므로 전체 이력을 가져오고, 객체가 없어서 조상
  검사가 실패하는 일은 없습니다.
- 공식 소스는 기본 URL을 먼저, 그다음 각 미러를 시도합니다. 어느 쪽이 후보를
  주든 이력 규칙은 그대로 적용됩니다.
- 전체 이력을 가져온 뒤에도 핀 커밋이 로컬 저장소에 없으면(저장소 디렉터리가
  사라졌고 원격에도 그 커밋이 없는 경우) 이력이 재작성된 것으로 봅니다. 객체가
  없으면 조상 관계를 증명할 수 없고, 첫 동기화는 어떤 이력도 받아들이기
  때문입니다. 후보가 핀의 후손이면 가져오기가 핀을 되살려 평소처럼 증명합니다.
- 업데이트 검토는 보여 준 커밋만 정확히 수락합니다
  (`ave:marketplace:sources:accept-rewrite`가 그 커밋을 싣습니다). 그 사이
  동기화가 다른 후보를 보았다면 검토는 만료됩니다(`PLAN_EXPIRED`).

### 7.4 네트워크 대상과 정책

하나의 게이트(`src/marketplace/net/network-gate.ts`)가 모든 git 원격,
release·archive URL, 관리 git 아카이브를 검사합니다. 서비스 엔드포인트는 자체
규칙을 따릅니다(§11).

1. **정규화**(§7.1). `https`·`http` 다운로드도 같은 호스트/포트/경로 규칙을
   따릅니다. 퍼센트 인코딩은 정규형으로 바꾸고, 빈 세그먼트·`.`·`..`는
   거부합니다.
2. **관리 정책**(§12): `marketplaces.block`, 그다음 `marketplaces.allow`(있을 때),
   그다음 `requireHttps`.
   - 다운로드에서는 정확한 저장소 패턴이 그 저장소 아래의 모든 경로
     (`…/acme/tools/releases/download/…`)도 덮습니다.
   - git 원격에서는 그 저장소만 가리킵니다. 하위 그룹이 있는 호스트에서는 중첩
     경로가 다른 저장소이기 때문입니다.
   - 정책을 읽을 수 없으면 공식 소스의 대상 말고는 모두 막습니다.
3. **주소 분류.** `classifyAddress`(`src/core/network-guard.ts`)가 리터럴
   주소나, 4단계의 조회 한 번이 돌려준 각 답을 분류합니다.

   | 분류 | 주소 |
   |---|---|
   | `public` | 전역 라우팅 가능 |
   | `internal` | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`, `100.64.0.0/10`, `198.18.0.0/15`(가짜 IP 프록시 도구가 모든 이름에 이 대역으로 답함). 메타데이터 주소는 제외 |
   | `this-computer` | `127.0.0.0/8`, `0.0.0.0/8`, `::1`, `::` |
   | `metadata` | `169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`, `100.100.100.200` |
   | `unroutable` | 그 밖의 특수 용도 대역(문서용, 멀티캐스트, 예약, 브로드캐스트, 프로토콜 할당) |

   IPv4 매핑 IPv6와 NAT64(`64:ff9b::/96`) 주소는 안에 담긴 IPv4 주소의 분류를
   따릅니다. 결과는 누가 대상을 골랐는가에 달려 있습니다.

   - **입력한 대상**: 사용자가 입력한 주소, 공식 빌드 상수, 관리 정책 항목.
     - https나 ssh의 `public`은 받습니다.
     - `internal`, `this-computer`, 평문 `http`는 각각 소스가 지닌 확인
       (`internal-network`, `this-computer`, `unencrypted`)이 필요합니다. 없으면
       `SOURCE_CONFIRMATION_REQUIRED`로 실패합니다.
     - 정책이 등록한 호스트(`allowHttpHosts`, `allow` 패턴, `additional`
       소스)는 이 셋 중 어느 것도 필요 없습니다.
     - `AVE_DEV=1`로 띄운 패키징 안 된 빌드는 `this-computer`에도, 루프백
       리터럴이나 `localhost`로 가는 http에도 확인이 필요 없습니다.
   - **카탈로그가 지정한 대상**: release·archive URL, §6.2의 파생 release
     URL, 다운로드의 모든 리다이렉트 홉.
     - `public`은 https와 http 모두 받습니다. http이면 전달 행에 암호화되지
       않은 다운로드이며 고정된 sha256으로 검증한다고 표시합니다. 고정값이 없는
       단계는 건너뜁니다(§6.2).
     - 소스 자신의 호스트는 소스의 확인을 물려받습니다. `this-computer`는 같은
       포트여야 합니다. ssh 소스의 파생 `https://<host>`는 443 포트의 https로
       칩니다.
     - 다른 `this-computer` 호스트나 포트는 거부합니다
       (`catalog-this-computer`, §18.3 #4). 이 거부는 모든 예외보다 먼저
       옵니다. 한 소스를 위해 `127.0.0.1`을 등록한 정책이 다른 카탈로그에 이
       컴퓨터의 다른 서비스를 열어 주지 않습니다.
     - 다른 `internal` 호스트는 정책이 등록했으면 받고, 아니면
       `internal-downloads`가 필요합니다. `internal-network`가 이를 함축하지
       않습니다.
     - 어느 소스도 지정하지 않은 다운로드(`catalog: null`)는 확인을 가질 수
       없으므로, 평문 http나 사내망 주소로 가는 홉은
       `SOURCE_CONFIRMATION_REQUIRED`로 실패합니다.
   - **모든 대상**:
     - `metadata`와 `unroutable` 주소는 정책이 등록한 호스트라도 거부합니다
       (`address-metadata`, `address-unroutable`, §18.3 #3).
     - `blockPrivateNetworks`는 정책이 등록한 호스트를 빼고 `internal`과
       `this-computer`를 정책 차단(`private-network-blocked`)으로 만듭니다.
     - `requireHttps`는 `allowHttpHosts`를 빼고 평문 http를 정책
       차단(`https-required`)으로 만듭니다.
     - 어떤 확인도 정책 차단을 통과하지 못합니다.

4. **검사를 연결에 묶습니다.** 게이트 자신은 이름을 해석하지 않습니다. 주소
   정책을 전송 계층에 넘기고, 전송 계층이 호스트를 한 번 해석해 통과한 답에만
   연결합니다.
   - **다운로드**는 고정 전송(`src/marketplace/net/pinned-fetch.ts`,
     `fetchAddressCheckedResponse` 경유)을 지납니다.
     - 홉마다 `dns.lookup(host, { all: true, verbatim: true })`를 한 번
       합니다.
     - 거부되거나 차단된 답은 버립니다. 전송은 남은 답에 주소로 연결하고, TLS
       `servername`은 호스트 이름입니다.
     - 남은 답이 없으면 버린 분류 중 가장 엄격한 것(metadata, unroutable,
       this-computer, internal 순)의 거부로 홉이 실패합니다.
     - 소스에 없는 확인이 필요한 답은 홉을 실패시킵니다.
     - 신뢰 저장소는 Node 기본 CA와 시스템 저장소이고, 인증서 검증을 명시적으로
       TLS 연결마다 직접 켜므로, 프로세스 전체에 물려받은 인증서 검증 끄기
       설정이 검증을 끄지 못합니다.
     - 경로는 세션 `resolveProxy(url)`의 첫 항목이며, 조용히 `DIRECT`로
       물러나지 않습니다.

       | PAC 종류 | 전송이 하는 일 |
       |---|---|
       | `DIRECT` | 검사한 답에 연결 |
       | `PROXY` | http는 절대형 요청, https는 `CONNECT` |
       | `HTTPS` | 프록시에 TLS를 연 뒤 `PROXY`처럼 동작 |
       | `SOCKS5` | 도메인 이름 주소 형식 사용 |
       | `SOCKS` / `SOCKS4` | 대상의 검사한 IPv4 답을 보냄 |

     - 프록시 자신의 주소도 검사합니다. `metadata`와 `unroutable`은
       거부하고, 나머지는 시스템 설정이 고른 것이므로 받습니다. 리터럴
       프록시 주소는 그 자체가 답 하나이며 같은 방식으로 판정합니다(IPv4 매핑과
       NAT64 형태 포함).
     - 그 밖의 PAC 종류는 `SOURCE_UNREACHABLE` 사유 `proxy`로 실패합니다.
     - 대상을 스스로 해석하는 프록시 너머는 프록시를 신뢰합니다.
       `trusted-proxy.test.ts`가 이 경계를 고정합니다.
   - **http(s) git**:
     - 호출마다 PAC 해석기에 한 번 묻습니다. git은 그 경로(`http.proxy`)로
       설정되고 묶기도 같은 경로를 검사하므로, 두 질문 사이에 바뀐 PAC 답이 git을
       검사하지 않은 프록시에 두지 못합니다.
     - 호출마다 호스트를 한 번 해석해 남은 답으로
       `-c http.curloptResolve=<host>:<port>:<address>[,…]`를 넘깁니다.
     - 프록시 호스트는 다운로드처럼 검사하고 같은 방식으로 고정합니다. 리터럴
       프록시 주소는 그 자체를 답 하나로 검사합니다.
     - 답이 모두 거부되면 git을 시작하지 않습니다.
   - **ssh git: 사전 검사만 합니다.**
     - git 호출과 같은 환경으로 `ssh -G [-p <port>] <user>@<host>`를 실행해
       실제 설정을 출력합니다.
     - 출력된 `hostname`을 한 번 해석합니다. ssh는 어느 답에든 연결할 수
       있으므로, 답 하나라도 거부되거나 차단되면 호출을 거부합니다. 확인이
       필요한 분류는 `SOURCE_CONFIRMATION_REQUIRED`로 실패합니다.
     - `proxycommand`나 `proxyjump`가 설정되어 있으면 대상을 해석하지
       않습니다.
     - ssh는 여전히 호스트 고정 없이 `ssh -o BatchMode=yes`로 실행합니다.
     - 남는 위험: 사전 검사와 ssh 자신의 조회 사이에 바뀐 답은 묶이지
       않습니다. 신뢰의 기준은 호스트 키입니다(§18.2.4).
5. **리다이렉트.**
   - git은 리다이렉트를 따라가지 않습니다(`http.followRedirects=false`).
   - 다운로드는 새 URL이 1–4단계를 통과한 뒤에만 리다이렉트를 따릅니다.
     다른 출처로 `Authorization`이나 `Cookie`를 넘기지 않습니다.

**http 위의 자격 증명.** 평문 http 소스는 `token-unencrypted`를 지닐 때만
로그인에 답합니다. 어떤 정책 등록도 이 확인을 함축하지 않습니다.

- 없으면 askpass가 그 호출에 티켓을 발급하지 않고, 모든 git 호출에
  `-c credential.helper=`가 붙습니다. 저장된 토큰도 OS 도우미의 비밀번호도
  평문으로 나가지 않고, 미리보기는 자격 증명 도우미가 이 호스트에 응답한다는
  안내를 보여 주지 않습니다.
- 그 결과의 인증 실패는 `SOURCE_AUTH_REQUIRED` 사유 `token-unencrypted`이고,
  소스 행이 *허용…*을 제시합니다.
- `GIT_ALLOW_PROTOCOL`은 게이트를 통과한 http 원격에만 `http`를 넣습니다.

**확인**은 분류 단위이며 해석된 주소 단위가 아닙니다. 소스마다 자기
`acknowledged` 기록을 저장합니다(§2.1). 사용자 지정·직접 소스는 `SourceEntry`에,
공식·관리 소스는 `SourceState`에 둡니다. 기록은 확인을 준 정규화된 소스
주소(스킴, 사용자, 호스트, 포트, 경로)를 담습니다. 주소가 다른 소스는 확인을
지니지 않습니다. 관리자가 다른 곳을 가리키게 바꾼 관리 항목이나 손으로 고친
`sources.json`은 재시작을 거쳐도 동의를 새 서비스로 옮기지 않습니다. 새 *허용…*은
옛 기록을 대체합니다.

- 대상이 나중에 소스에 없는 확인을 요구할 수 있습니다. 이름이 이제 사내망 주소로
  해석되거나, 카탈로그가 다른 사내망 호스트를 지정하는 경우입니다. 그러면 동기화,
  계획, 설치가 `SOURCE_CONFIRMATION_REQUIRED`로 실패합니다.
- `sources:acknowledge`가 확인을 더하고 다시 동기화합니다.
- 확인을 거두려면 소스를 제거하고 다시 추가합니다.

아이콘과 이미지는 git 트리에서만 읽습니다. 어떤 패키지 필드도 앱이 임의의 이미지
URL을 가져오게 만들지 못합니다.

### 7.5 오프라인

마지막 정상 스냅숏을 보여 줍니다. 아직 바이트를 받지 않은 패키지를 설치하면
`SOURCE_UNREACHABLE`로 실패하며, 다른 소스로 대신 가져오지 않습니다.

### 7.6 제거

소스를 제거해도 그 소스에서 설치한 패키지는 남습니다. "소스 제거됨 — 업데이트
없음"으로 표시되고, 설치됨 화면에서 제거할 수 있습니다. 같은 정규화 URL을 다시
추가하면 다시 묶입니다. 공식·관리 소스는 제거할 수 없습니다. 제거는 그 소스의
동기화나 수락이 진행 중이면 끝나기를 기다리므로, 디렉터리가 사라진 뒤에 옛
소스의 쓰기가 남지 않습니다.

### 7.7 로컬 폴더

폴더는 마켓플레이스(루트에 `marketplace.2.json`이나 §3.3의 관례 레이아웃)이거나
패키지 하나(직접 소스, §8)입니다. 주소를 넣는 곳 — *마켓플레이스 추가…*와
*Git URL에서 설치…* — 에 그대로 입력하고 `sources:preview`와 `sources:add`를
거칩니다. 폴더만의 채널은 없습니다(§13.1). 설계와 그 이유는 §18.4에 있고, 이
절은 구현된 동작입니다.

**입력** — `normalizeSourceInput(input, platform, home)`과 미리보기
(`MarketplaceService.previewFolder`)가 네 단계를 거칩니다. 1–3단계는 경로에
아무 호출도 하지 않으므로, 차단이나 확인 요청은 공유 서버에 연결하기 전에
미리보기를 끝냅니다.

1. **어휘 분석.** `file:` URL과 `/`, `~`, 드라이브(`C:\`, `C:/`), `\\`,
   `//`로 시작하는 입력은 폴더이고, 나머지는 git 주소입니다(§7.1). `~`는
   서비스가 받은 홈 디렉터리로 펼칩니다. `\\?\C:\…`와
   `\\?\UNC\server\share\…`는 접두사를 떼고, `.`·`..` 세그먼트는 어휘적으로
   적용합니다. 다음은 `SOURCE_URL_REJECTED`로 거부하며, 각각 대신 입력할 것을
   말합니다. 상대 경로(`./x`, `C:foo`, `~user`, `relative-path`), Windows 장치
   경로(`device-path`), macOS·Linux에서의 드라이브·UNC 경로(`windows-path`),
   거기서 다른 컴퓨터를 가리키는 `file:` URL(`network-file-url`), 공유 이름
   없는 UNC 경로(`unc-without-share`), 드라이브·공유·`/` 위로 올라가는 `..`
   (`outside-root`), 폴더와 함께 준 브랜치·하위 폴더·로그인(`folder-options`).
2. **네트워크 분류.** UNC 경로는 다른 컴퓨터에 있습니다. Windows 드라이브
   문자는 현재 매핑으로 분류하며, 도우미 `ave-path-kind.exe`
   (`native/windows-path-kind/`, `src/main/windows-path-kind-launcher.ts`가
   실행)가 `QueryDosDeviceW`로 읽습니다. 볼륨·CD-ROM·플로피는 로컬, `subst`
   드라이브는 대상 드라이브(정해진 횟수까지 따라감), 그 밖의 것 — 리디렉터,
   알 수 없는 장치, 실패한 조회 — 은 네트워크 폴더이고, 매핑이 서버를
   밝히면 그 서버를 함께 둡니다. macOS의 `/Network/…`와 macOS·Linux의
   `/net/<host>/…`는 자동 마운트 경로로 네트워크입니다. 그 밖의 경로는
   로컬입니다. 이미 마운트된 공유는 마운트할 때 인증했습니다.
3. **정책, 그다음 동의.** `allowLocalSources`와 `path:` 패턴(§12)을 어휘
   경로에 먼저 적용하므로, 차단된 폴더는 드라이브 매핑 조회조차 하지
   않습니다. 그다음 네트워크 폴더에는 `network-folder`가 필요하고, 없으면
   미리보기가 `{ type: "confirm" }`으로 답해 대화상자가 묻습니다.
4. **해석.** 경로를 `FolderFs`(`lstat`, `readdir`, `readlink`. `realpath`는
   없음)로 구성 요소마다 걷습니다. 각 구성 요소는 디스크의 철자를 따르고
   (Windows의 8.3 짧은 이름 `PROGRA~1`은 `dev`·`ino`가 같은 항목의 긴 이름으로),
   입력 경로 안의 링크는 텍스트로 따라갑니다. 텍스트가 네트워크 위치를
   가리키면 무엇도 닿기 전에 `CONTENT_RULE_VIOLATION` `link-to-network`로
   거부합니다. 정책은 정규 경로에 다시 적용합니다. 미리보기는 정규 `path`를,
   다르면 입력값인 `resolvedFrom`도 함께 담습니다.

**읽기** (`FolderTree`, `src/marketplace/sources/folder-tree.ts`. 규칙은
§18.4.5). 폴더 안의 링크는 대상에 어떤 호출도 닿기 전에 텍스트로 판정합니다.
폴더를 벗어나면 `link-outside-folder`, 다른 컴퓨터를 가리키면
`link-to-network`, 고리나 너무 많은 링크는 `limit`이고, 안에 머무는 링크는
대상의 바이트를 담은 일반 파일로 읽습니다. 파일은 마지막 링크를 따르지 않고
열며, `fstat`이 `lstat`이 본 파일이어야 하고, 읽을 때마다 루트부터의 디렉터리
사슬을 다시 확인합니다. 다르면 `SOURCE_LOCAL_UNREADABLE`
`changed-during-read`입니다. 그 확인 전에 되돌려진 교체는 §18.4.5가 밝힌 잔여
위험입니다. `.git/`, `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`는 읽지 않고
건너뛰고, 이름은 NFC이며, NFC 뒤 또는 대소문자를 무시하고 같은 두 이름은
`case-collision`, 장치·소켓·FIFO는 `special-file`입니다. 실행 비트는
유지합니다. 폴더에는 어떤 git 명령도 실행하지 않고, git의 `file` 전송은
`never`로 남습니다(§18.3 #5, #6).

**리비전과 동기화.** 폴더의 핀은 리비전입니다. `local-`에, 스냅숏이 읽은
파일과 패키지마다의 트리 다이제스트(§6.4)에 대한 sha256을 붙인 것이므로,
패키지가 설치하는 어떤 파일을 고쳐도 바뀝니다. 스냅숏은
`snapshots/<revision>.json`입니다. 읽기에는 이력 규칙이 없고, 폴더에 파일이
있는 버전만 제공합니다. 모든 읽기 — 백그라운드 동기화, 새로 고침, 계획 — 는
저장된 경로에 2–4단계를 다시 거칩니다. 지금 정책이 막거나, 확인 없는 네트워크
폴더면 추가할 때와 똑같이 실패합니다. 저장된 경로를 걸었을 때 다른
디렉터리에서 끝나거나, 추가한 뒤 `dev`/`ino`가 바뀌었으면
`SOURCE_LOCAL_UNREADABLE` `moved`이고 새 대상은 읽지 않습니다. 어떤 실패든
마지막으로 성공한 스냅숏을 유지합니다. 이유는 다른 동기화처럼
`lastSync.detail`에 저장되고(§14), 재시작 뒤에도 소스 행이 그 이유를 말합니다.

**식별.** 정규 경로가 바이트 단위로 같거나 두 디렉터리가 같은 0 아닌
`dev`·`ino`를 보고하면 같은 소스입니다. 플랫폼으로 접어 비교하지 않으므로,
대소문자를 구분하는 볼륨에서 `/Approved/Tools`와 `/approved/tools`는 둘입니다.
이미 소스인 폴더, 또는 소스를 포함하거나 그 안에 있는 폴더는
`SOURCE_ID_TAKEN`으로 거부합니다. 확인은 정규 경로에 묶입니다(§2.1).

**계획과 설치.** 계획은 폴더를 다시 읽고(바뀌었으면 새 스냅숏을 게시)
패키지를 작업 디렉터리 아래 사본으로 떠 둡니다. 사본의 다이제스트가 스냅숏과
같아야 하며, 다르면 계획이 `changed-during-read`로 실패합니다. 실행은 그
사본만 설치하고, 사본은 계획을 실행하거나 교체되거나 만료될 때 지웁니다.
그래서 검토 뒤의 수정은 설치에 닿지 않고, §18.8의 `PLAN_EXPIRED`
`folder-changed`를 일으키는 경우는 없습니다. 플러그인의 사다리는 `folder`
단계 하나입니다. `plugin.json`, `dist/**`, `assets/**`. 선언된 release·archive
단계는 시도하지 않고 아무것도 내려받지 않습니다. 그 밖의 최상위 항목(`src/`,
`package.json`, `node_modules/`. 디스크립터는 제외)은 빠지고 계획의
`notInstalled`에 나열됩니다. `plugin.json`이 없는 폴더는
`NO_INSTALLABLE_ARTIFACT` `folder-has-no-build`이고, `process` 진입점은 단계와
설치기 양쪽에서 `process-entry-requires-pinned-artifact`로 거부합니다
(§18.4.9). 스킬, 에이전트 플러그인, MCP 서버도 같은 사본에서 설치합니다.

**직접 폴더.** 패키지 하나인 폴더는 직접 소스입니다. 버전은 디스크립터의
것이거나 트리 다이제스트로 만든 `0.0.0+t<digest12>`입니다(§8.2). 파일이 읽기
규칙을 어기면 미리보기가 그 이유로 실패합니다. 마켓플레이스라면 그 패키지만
진단과 함께 빠집니다(§2.2).
`allowDirectInstall: false`는 미리보기, 추가, 계획에서 이를 거부합니다(§12).

폴더 선택기, *표시(Reveal)*, 폴더 배지와 폴더 행의 출처 표시는 슬라이스
D2입니다(§18.4.8). 그때까지 시트는 `notInstalled`를 나열하지 않고, 폴더 행은
git 행이 주소를 보이는 자리에 경로를 보입니다.

## 8. 직접 설치 (마켓플레이스 매니페스트 없음)

### 8.1 입력

| 입력 | 감지 | 결과 |
|---|---|---|
| Git URL(+ 선택적 하위 경로, ref) | 경로에서 처음 맞는 것: `ave-package.json` → `plugin.json`(Agent Plugins) → `SKILL.md` → `AGENTS.md` → `server.json` | 그 패키지에 대한 `direct` 소스 항목 |
| 폴더 경로(§7.7) | 같은 순서로, 폴더 루트에서 | 그 패키지에 대한 `direct` 폴더 소스 |
| MCP: 명령 / URL 폼 | 기존 MCP 탭 폼 | MCP 서버 항목(경로 변경 없음) |
| MCP: `server.json` 붙여넣기 | MCP Registry 스키마 | MCP 서버 항목. npm/PyPI/OCI 패키지는 `npx`/`uvx`/`docker`로, `remotes`는 `http`로 대응 |
| MCP: 클라이언트 설정 붙여넣기 | `mcpServers` 객체(데스크톱 클라이언트 설정이나 프로젝트 `.mcp.json`) | `claude-desktop-import.ts` 미리보기/적용 재사용 |

### 8.2 합성 디스크립터

- `ave-package.json`이 있으면 그대로 씁니다.
- `plugin.json` → `kind: "plugin"`. `name`, `version`, `authority`,
  `minAppVersion`을 거기서 가져옵니다(`requires.minAppVersion`이 없으면
  `PACKAGE_COMPAT_UNDECLARED`). 아티팩트는 tree 단계인데, 해석된 커밋에
  `artifact.release.sha256`이 있는 `ave-package.json`도 있으면 그걸 씁니다.
  보통 순서는 태그 → 릴리스 자산 게시 → 핀을 담은 디스크립터 커밋이고, 사용자의
  ref는 그 나중 커밋을 포함해야 합니다.
- `SKILL.md` / `AGENTS.md` → front matter에 `version`이 있으면 그것, 없으면
  git 소스에서는 `0.0.0+g<commit12>`, 폴더에서는 `0.0.0+t<digest12>`(패키지의
  트리 다이제스트, §6.4). 코드를 실행하지 않는 종류이므로 `minAppVersion`
  기본값은 `0.0.0`.
- `server.json` → 파일의 `version`, `minAppVersion`은 `0.0.0`.

직접 설치 패키지는 ref가 더 높은 버전을 선언한 후손 커밋으로 움직이면(합성
`0.0.0+g…` 버전이면 새 커밋마다) 마켓플레이스 패키지와 같은 업데이트 검토를 거쳐
업데이트됩니다. 직접 폴더는 파일이 바뀌어 합성 버전이 바뀔 때마다 업데이트를
제안합니다.

`allowDirectInstall: false`(§12)는 git이든 폴더든 직접 소스를, 입력이 패키지
하나로 판명된 미리보기에서, 추가에서, 그리고 그 전에 추가된 직접 소스의 모든
계획에서 거부합니다.

## 9. Git 런타임

### 9.1 감지와 최소 버전

쓸 수 있는 최소 git은 **2.45.1**입니다. `GIT_NO_LAZY_FETCH`(§9.3)를 처음
지키는 릴리스로, 이것이 없으면 부분 클론에서 없는 객체를 로컬로 읽을 때 git이
네트워크 게이트를 거치지 않고 스스로 원격에서 가져옵니다.
CVE-2024-32002/32004/32465를 고친 릴리스이기도 합니다. `blob:none` 부분 클론,
`rev-list --missing=print`, 프로토콜 v2, `protocol.file.allow`는 그보다 훨씬
전부터 §9.3이 기대하는 대로 동작합니다.

```
mode = settings.marketplace.git.mode   // "auto" | "system" | "managed"
system: first `git` on PATH (plus /usr/bin/git, /opt/homebrew/bin/git,
        C:\Program Files\Git\cmd\git.exe); require `git --version` >= 2.45.1
managed: ~/.ave/runtime/git/<pinnedVersion>/ present and smoke-tested
auto: system if usable, else managed if present, else state "missing"
      (a system git older than 2.45.1 is reported as too old and auto uses managed)
```

macOS에서 Command Line Tools 없는 `/usr/bin/git`은 설치 대화상자를 여는 shim입니다.
감지 단계는 먼저 `xcode-select -p`를 실행하고, CLT가 없으면 대화상자를 띄우지 않고
"시스템 git 없음"으로 취급합니다.

### 9.2 관리형 설치

```ts
// src/marketplace/git/managed-git-pins.ts — updated deliberately, reviewed like a dependency bump
const RELEASE = "https://github.com/desktop/dugite-native/releases/download/v2.53.0-4/dugite-native-v2.53.0-4098283";
const MANAGED_GIT = {
  version: "2.53.0",
  assets: {
    "darwin-arm64": { url: `${RELEASE}-macOS-arm64.tar.gz`,    sha256: "f9dc6463…", size: 62348987 },
    "darwin-x64":   { url: `${RELEASE}-macOS-x64.tar.gz`,      sha256: "ae668671…", size: 66136060 },
    "linux-x64":    { url: `${RELEASE}-ubuntu-x64.tar.gz`,     sha256: "cca76aa3…", size: 65269219 },
    "linux-arm64":  { url: `${RELEASE}-ubuntu-arm64.tar.gz`,   sha256: "a161f45a…", size: 23223345 },
    "win32-x64":    { url: `${RELEASE}-windows-x64.tar.gz`,    sha256: "7b76bc5c…", size: 47119821 },
    "win32-arm64":  { url: `${RELEASE}-windows-arm64.tar.gz`,  sha256: "1abbeb3a…", size: 45084825 },
  },
};
```

모든 플랫폼에 하나의 출처를 씁니다. GitHub Desktop이 싣는 git 빌드인
desktop/dugite-native입니다. 이 빌드의 Windows 아카이브는 MinGit(Git for
Windows)을 tar.gz로 다시 묶은 것이므로 추출기 하나로 모든 플랫폼을 처리합니다.
각 `sha256`은 릴리스에 함께 올라온 `<asset>.sha256` 파일에서 읽고 GitHub가
보고하는 자산 digest와 대조했습니다. `size`는 정확한 값이라 더 긴 본문은 잘리고
더 짧은 본문은 해시에서 실패합니다.

UI에 보고하는 단계: `checking → downloading(bytes) → verifying → extracting →
smoke-testing → ready | failed(code)`. 다운로드는 PAC를 인식하는 단일 홉 전송과
§7.4 게이트를 거칩니다(GitHub는 자산 호스트로 리다이렉트하고, 게이트가 그 홉을
다시 검사합니다). 압축은 대상 옆 스테이징 디렉터리에 풀며, 일반 파일, 디렉터리,
형제를 가리키는 심볼릭 링크(`git-fetch -> git`)만 받아들입니다. 스모크 테스트는
스테이징된 사본을 실행해 `--version`이 핀과 같고, `hash-object --stdin`이 git
객체 형식과 일치하고, https 전송 헬퍼가 있는지 확인합니다. 그다음에야 준비
표시를 쓰고 디렉터리 이름을 바꿔 제자리에 둡니다. 실패하거나 중간에 끊긴 설치는
동작 중인 사본을 절대 대체하지 않습니다. 강제 재설치는 동작 중인 사본을 옆으로
옮겨 두었다가 마지막 이름 바꾸기가 실패하면 되돌립니다. 다운로드·검증·추출·
스모크 테스트 실패는 모두 `GIT_RUNTIME_INSTALL_FAILED`이고, 정책 차단만
`SOURCE_POLICY_BLOCKED`로 남습니다. 본문이 60초 동안 아무것도 보내지 않으면
설치를 붙잡아 두지 않고 실패시킵니다. 다운로드는 공식 소스처럼 게이트를
거칩니다. `block`과 `allow`는 적용되고, 정책이 무효여도 막히지 않습니다. 공식
소스에 git이 필요하고 아카이브는 해시로 고정되어 있기 때문입니다.

관리형 모드에서 매 호출에 설정하는 환경:

- macOS·Linux는 `bin/git`을 `GIT_EXEC_PATH` = `libexec/git-core`로 실행합니다.
  Windows는 `cmd/git.exe`를 `GIT_EXEC_PATH` = `mingw64/libexec/git-core`로
  실행하고, `PATH` 앞에 `mingw64/bin`과 `usr/bin`(`ssh.exe`가 있는 곳)을
  붙입니다. `GIT_TEMPLATE_DIR`은 어디서나 Ave 소유의 빈 디렉터리입니다.
- CA 루트(핀 고정 빌드에서 측정, 2026-09-23):
  - macOS: `git-remote-http`가 시스템 libcurl(SecureTransport)에 링크되어
    키체인을 그대로 씁니다. System 키체인의 사내 루트도 포함됩니다. CA 파일은
    설정하지 않습니다. 설정하면 신뢰 범위가 좁아집니다.
  - Linux: 사본이 `ssl/cacert.pem`을 싣고 OS 저장소는 읽지 않습니다.
    `GIT_SSL_CAINFO` = 그 루트와 `src/main/corp-ca-extract.ts`가 찾은 사내
    루트를 합쳐 Ave가 만든 번들.
  - Windows: `-c http.sslBackend=schannel`, 즉 Windows 인증서 저장소. 사본의
    system config도 같은 값을 두지만 `GIT_CONFIG_NOSYSTEM=1` 때문에 읽히지
    않으므로, 매 호출에 이 설정을 넘깁니다.

### 9.3 호출 계약

모든 호출은 함수 하나, `runGit(args, { cwd, sourceId })`를 지납니다.
예외는 런타임을 고르기 전에 도는 버전 확인(`git --version`, §9.1) 하나로,
저장소도 네트워크도 쓰지 않고 같은 축소 환경에서 실행합니다.

환경(두 모드 공통):

- `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=<Ave가 만든 파일>`(아래), `LC_ALL=C`.
- `GIT_ASKPASS=<Ave askpass 헬퍼>`, `SSH_ASKPASS_REQUIRE=never`,
  `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`(모르는 호스트 키는 프롬프트를
  기다리지 않고 `SOURCE_SSH_HOST_UNKNOWN`으로 바로 실패).
- `GIT_ALLOW_PROTOCOL=https:ssh`, 네트워크 게이트를 통과한 http 원격에만 `http`
  추가(§7.4). 원격이 없는 호출은 `none`.
- `GIT_LFS_SKIP_SMUDGE=1`.
- `GIT_NO_LAZY_FETCH=1`: 없는 객체는 오류일 뿐, 게이트가 보지 못한 가져오기가
  되지 않습니다. blob은 게이트를 거치는 명시적 `ensureBlobs` 단계에서만
  가져옵니다.
- 저장소를 다루는 호출에는 `GIT_DIR=<소스 repo.git>`을 넘겨, git이 망가진
  저장소에서 위로 올라가며 다른 저장소를 찾지 않게 합니다. 그 밖의 호출은 빈
  디렉터리에서 돌고 `GIT_CEILING_DIRECTORIES`가 거기서 탐색을 멈춥니다.

설정 플래그: `-c protocol.file.allow=never -c submodule.recurse=false
-c core.fsmonitor=false -c core.hooksPath=<빈 디렉터리> -c http.followRedirects=false
-c http.proxy=<PAC> -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false
-c gc.auto=0 -c maintenance.auto=false`(고정값이 옮겨간 뒤 자동 gc가 설치본이 아직
참조하는 커밋을 지울 수 있기 때문), 그리고 저장된 토큰으로 답하는 호출에는
`-c credential.helper=`(아래). `<PAC>`는 Chromium이 그 원격에 대해 해석한 첫
항목입니다. `PROXY`, `HTTPS`, `SOCKS5`, 그리고 `SOCKS`/`SOCKS4`는 `socks4://`로,
`DIRECT`는 빈 값으로 씁니다. 그 밖의 종류는 설정이 프록시를 고른 곳으로 직접
나가지 않도록 호출을 `SOURCE_UNREACHABLE`로 실패시킵니다.

**전역 설정.** 사용자의 전역 git 설정은 읽지 않습니다. Ave가
`GIT_CONFIG_GLOBAL`이 가리키는 파일을 만들고, 거기에 `credential.helper`와
`credential.<url>.*` 항목(OS 자격 증명 헬퍼가 계속 동작하도록),
`http.sslCAInfo`, `http.sslBackend`만 system, global 수준 순서로 읽어 복사합니다
(Apple과 Homebrew의 git은 키체인 헬퍼를 system 수준에 두므로,
`GIT_CONFIG_NOSYSTEM=1`만으로는 그 헬퍼가 빠집니다). 나머지(`url.*.insteadOf`,
`http.extraHeader`, `http.sslVerify`, `core.sshCommand`, 별칭, 훅)는 버립니다.
따라서 OS에 저장된 한 호스트의 자격 증명은 그 호스트의 모든 소스에서 쓸 수 있고,
자격 증명 헬퍼가 설정되어 있으면 추가 대화상자가 이를 알려 줍니다.

**Askpass 프로토콜.** 헬퍼는 메인 프로세스가 시작할 때 새 `0700` 디렉터리에
실행기와 함께 써 두는 작은 스크립트입니다. 실행기는 앱 바이너리를 Node 모드
(`ELECTRON_RUN_AS_NODE`)로 띄워 이 스크립트를 돌리므로, 앱에 따로 동봉할 것은
없습니다. 티켓은 소스가 토큰 인증을 선언했고 원격 호스트에 저장된 토큰이 있을
때만 만듭니다. 다른 호스트의 미러는 주 호스트의 토큰을 받지 않습니다. 그런
호출에는 `-c credential.helper=`도 붙습니다. 마지막에 읽히므로 복사해 온 헬퍼를
모두 끄고, git이 헬퍼에 먼저 묻거나 자격 증명을 승인하며 토큰을 헬퍼에 넘기는
일이 없습니다. 저장된 토큰이 없으면 헬퍼가 평소대로 답합니다. 메인 프로세스는
그런 호출마다 `(정규화된 호스트, sourceId)`에 묶인 1회용 티켓을 만들고,
자식 환경에 `AVE_ASKPASS_TICKET`과 `AVE_ASKPASS_ENDPOINT`(`0700` 디렉터리 안의
로컬 소켓)를 넘깁니다. 헬퍼가 티켓과 git의 프롬프트 문구를 보내면, 메인
프로세스는 프롬프트가 티켓의 호스트를 가리킬 때만 저장된 토큰으로 답하고, 아니면
빈 답을 돌려줍니다. 티켓은 git 프로세스가 끝나면 만료됩니다.

**쓰는 명령**(이 외에는 없음):

- `ls-remote`
- `init --bare`
- `fetch --filter=blob:none --no-tags <remote> <ref>`
- `rev-parse`, `merge-base --is-ancestor`, `cat-file`, `ls-tree`
- **커밋의 한 경로 내보내기:**
  `rev-list --objects --missing=print --no-walk --sparse <commit> -- <path>`로
  아직 없는 blob을 나열하고(`--no-walk`는 과거 버전을 빼고, `--sparse`는 그
  커밋이 경로를 바꾸지 않았어도 커밋을 남깁니다), 한 번의 요청으로 가져온 뒤
  (`fetch --filter=blob:none --no-tags <remote> <oid>…`, 부분 클론의 지연 가져오기가
  보내는 것과 같은 요청. 필터와 객체 id 로 가져오기를 허용하는 서버가 필요하며
  호스팅 서비스는 허용합니다. 필터를 무시하는 자체 ssh나 `git daemon` 서버는 전체
  blob을 보내므로 느리지만 결과는 같습니다), 목록을 다시 떠서 빠진 것이 없음을
  확인하고, `archive --format=tar --prefix=<path>/ <commit>:<path>`로 트리를
  스테이징 디렉터리에 씁니다(`<commit> -- <path>` 형태는 경로 밖 blob도 읽습니다).
  워크트리도 sparse-checkout도 만들지 않습니다. 일반 파일과 디렉터리만 받고,
  트리에 symlink나 서브모듈 항목이 있으면 내보내기를 멈춥니다.

타임아웃: `ls-remote` 20초, `fetch` 120초(설정 가능), 내보내기 60초. 출력 한도와
중단 신호는 기존 프로세스 헬퍼를 따릅니다.

## 10. 특권 패키지 없음

공식 소스는 앱에 하드코딩되고 **Ave Official** 배지를 답니다. 배지가 주는 것은
그것뿐입니다. 공식 소스의 패키지도 다른 소스의 패키지와 똑같이 해석하고, 검증하고,
동의를 받습니다. 예전에 카탈로그와 함께 오던 결정은 이제 앱 자체의 소스 코드나
기기의 시스템 정책 파일, 즉 git 저장소가 닿을 수 없는 곳에 있습니다.

### 10.1 제거: 관리 패키지

지금은 `installPolicy: "admin"`인 카탈로그 행이 사용자 조작 없이 부팅 때
설치되고(`ensureManagedInstalled`), 사용자가 제거할 수 없고(`deployment-guard.ts`),
시크릿 게이트의 grant 단계를 건너뛰고(`secret-gate.ts` admin bypass), 사용자의
업데이트 클릭을 관리 액터로 승격하고, 목록에서 내려가면 제거됩니다. 이 전부를
제거합니다.

- `installPolicy`는 매니페스트 스키마에서(§5.3), `installSource: "admin"`은
  레지스트리에서(§16.3) 빠집니다.
- 어떤 패키지도 스스로 제거를 막을 수 없습니다. 패키지를 필수로 지정할 수 있는
  것은 기기의 시스템 정책 파일뿐입니다(§10.2). 어떤 패키지도 매니페스트
  허용 목록, 앱의 grant 표(§10.3), 활성 공급자 검사를 거치지 않고는 호스트
  시크릿에 닿지 못합니다.

제거 지점(현재 트리에서 확인): `src/boot/managed-marketplace.ts`,
`src/plugins/marketplace.ts`의 관리 분기(부팅 설치·업데이트, 목록 제외 시 제거,
user→it-admin 액터 승격), `update-condition.ts`(`eligible_managed_install`,
`eligible_managed_boot_update`, `normalizeInstallPolicy` 검사),
`runtime/index.ts`의 `isManaged`, `runtime/manifest-validation.ts`의
`normalizeInstallPolicy`, `src/ui/renderer/types.ts`의 `installPolicy` 필드,
`src/boot/steps/plugin-runtime/host-api-factory.ts`의 `installSource` 연결과
`admin-bypass` 감사 경로, `deployment-guard.ts`의 admin 분기, `secret-gate.ts`의
tier-3 우회, 스킬 패키지 스키마의 `installPolicy` 속성. 이 스키마는
`schemas/sdk/`에서 빼서 호스트 소유 `schemas/skill-package.schema.json`으로
둡니다(§5.6). 관리 동작을 검증하던 테스트는 지우지 않고
§10.2를 검증하도록 다시 씁니다: `marketplace-managed-bootstrap`,
`marketplace-install-actor-escalation`, `deployment-guard`, `registry-migration`,
`secret-gate`.

### 10.2 기본 설치와 필수 설치

새 설치본이 무엇을 갖고 시작할지는 어떤 저장소에도 없는 목록이 정합니다. 두 가지가
있습니다.

**기본 설치(default install)**는 한 번 설치된 뒤 사용자의 것이 됩니다. 앱에서
옵니다.

```ts
// src/marketplace/default-installs.ts — changed only by an app release
export const DEFAULT_INSTALLS: readonly PackageKey[] = [
  { kind: "plugin", name: "meeting", source: "ave" },
  { kind: "plugin", name: "local-indexer", source: "ave" },
];
```

그리고 시스템 정책 파일의 `marketplaces.defaultInstalls`(§12)에서도 옵니다. 정책
목록은 공식 또는 관리 소스의 패키지를 지정할 수 있습니다.

- 부팅 때 `packages/default-installs.json`에 아직 기록되지 않은 키를 일반
  계획(사다리, 검증, 영수증)으로 설치하고 기록합니다. 사용자는 설치된 항목을
  나열하고 항목마다 제거 버튼이 있는 알림을 한 번 봅니다.
- 기록된 키는 다시 설치하지 않습니다. 기본 패키지를 제거하면 사용자가 다시
  설치하지 않는 한 그대로입니다.
- 패키지가 없거나 호환되지 않는 키는 `skipped`로 기록하고, 목록 항목이 바뀔
  때만 다시 시도합니다.
- 소스에 아직 스냅숏이 없거나(오프라인 첫 부팅), 버전이 롤아웃이나
  프리릴리스라는 이유만으로 빠져 있거나(행이 이유 `pending`으로 `unavailable`이며,
  앱이 바뀌지 않아도 달라질 수 있음), 설치가 실패한 키는 기록하지 않고 다음
  부팅에서 다시 시도합니다. 읽을 수 없는 `default-installs.json`은 기본
  설치를 멈춥니다. 빈 목록으로 읽으면 사용자가 지운 것을 다시 설치하게 됩니다.

**필수 설치(required install)**는 시스템 정책 파일의
`marketplaces.requiredInstalls`(§12)에서만 옵니다. 이 파일은 기기 관리자(root나
기기 관리 도구)가 소유하며, 어떤 git 저장소도 쓸 수 없습니다. 항목마다:

- 없으면 부팅 때 설치하고, 부팅 때 소스의 후보 버전(§6.1)으로 일반 계획을 통해
  업데이트합니다. 필수 패키지의 권한 동의는 정책이 대신하며, 검토 화면에는
  "조직에서 필수로 지정"으로 표시합니다.
- 사용자는 제거하거나 비활성화할 수 없습니다. `deployment-guard.ts`는 액터
  모델을 유지하되, 사용자 조작을 거부하는 유일한 사유가 "`requiredInstalls`에
  있음"(`PACKAGE_REQUIRED_BY_POLICY`)이 됩니다. 이 사유는
  `PluginDeploymentGuard.canUninstall`과 `canDisable`이 돌려주고, 따라서
  `canDisable`을 호출하는 자유 함수 `assertDisableAllowed`도 돌려줍니다.
- 지정된 패키지가 다른 소스에서 설치되어 있으면(`PACKAGE_ID_CONFLICT`) 부팅
  단계가 §15.1의 소스 전환(플러그인 데이터 유지)을 수행하고 부팅 알림에 적습니다.
  사용자의 소스 선택보다 정책이 우선합니다. 관리자가 설치한 플러그인
  (`installSource: "admin"`)을 바꿀 수 있는 것도 이런 필수 설치뿐이며, 항목은
  계속 관리자 설치로 남습니다. 그 밖의 git 설치로 덮어쓰려 하면
  `PACKAGE_ID_CONFLICT`로 거부합니다. 설치 과정은 이 판단을 전달받은 관리
  정책(해당 플러그인의 `requiredInstalls` 항목과 계획의 소스)에서 직접 읽으며,
  호출자가 주장할 수 없습니다.
  같은 상황의 `defaultInstalls` 항목은
  사용자의 설치가 이미 목적을 채우므로 `skipped`로 기록합니다.
- 필수 업데이트는 §15.6의 업데이트 검토 없이 적용됩니다. 정책 파일이 동의를
  대신하기 때문입니다. 따라서 침해된 관리 소스는 자기 패키지를 필수로 지정한 모든
  기기에 확인 없이 코드를 보낼 수 있습니다. 그 소스와 브랜치 보호는 조직의
  책임입니다(아키텍처 제안서 §9.1).
- 항목은 공식 또는 관리 소스만 지정할 수 있습니다.
- 정책 파일에서 항목을 빼면 필수 지정이 끝납니다. 패키지는 설치된 채 남고 일반
  사용자 설치가 됩니다.

기본이나 필수로 지정되었다고 해서 호스트 시크릿 grant가 생기지는 않습니다.
grant는 §10.3만 따릅니다.

### 10.3 호스트 시크릿 grant

서명된 화이트리스트 grant(지금: `meeting`과 `local-indexer`가 활성 공급자의
`llm.apiKey.*`를 읽을 수 있음)를 앱 안으로 옮깁니다.

```ts
// src/plugins/secret-access/grants.ts — changed only by an app release
export const HOST_SECRET_GRANTS: readonly HostSecretGrant[] = [
  { plugin: "meeting", keys: ["llm.apiKey.openai", "llm.apiKey.claude", "llm.apiKey.gemini", "llm.apiKey.azure-foundry", "llm.apiKey.vertex-ai"] },
  { plugin: "local-indexer", keys: [/* same set */] },
];
```

grant는 다음이 모두 참일 때만 적용됩니다.

1. 레지스트리 항목의 `origin.sourceOrigin`이 `official`;
2. 설치된 아티팩트의 sha256이 공식 스냅숏이 그 버전에 핀한 sha256, 곧 release나
   archive 핀(Ave가 게시한 바로 그 아티팩트) 중 하나와 같음. 값은 `origin.artifactSha256`에서, `legacy` 항목이면
   기존 설치 영수증의 `artifactSha256`에서 읽습니다. tree 단계 설치는 절대
   해당하지 않습니다;
3. 실행 중인 매니페스트의 정규화 SHA-256이 설치 때 기록한 `manifestSha256`과
   같음(지금의 tier-3 핀, 유지);
4. 키가 매니페스트의 `hostSecrets.read`에 있고(tier 2) 활성 공급자를
   가리킴(tier 4) — 변경 없음.

`canonical-json.ts`와 `secret-gate.ts`는 남고 `src/plugins/secret-access/`로
옮깁니다. tier-3 조회는 `whitelistRegistry` 대신 위 표를 읽습니다.

- 조건 2는 결국 공식 저장소 `main`에 머지할 수 있는 사람이 정합니다. D4에서는
  grant 대상 플러그인 이름에 다른 아티팩트를 핀하는 머지가 그 아티팩트에 grant를
  줍니다. grant 표는 피해 범위를 나열된 플러그인 이름과 키로 한정하며, 제안서의
  위협 표에 이를 적어 둡니다.
- grant 대상 기본 패키지를 제거했다가 공식 소스에서 다시 설치하면, 조건 1–4가
  맞을 때 grant가 돌아옵니다. 의도된 동작입니다.
- 표에 플러그인이나 키를 추가하려면 앱 릴리스가 필요합니다.

### 10.4 폐기(Revocation)

모든 소스는 `policy/revocations.json`을 게시할 수 있습니다. 이 파일은
`origin.sourceId`가 그 소스인 설치본에**만** 적용되므로, 어떤 저장소도 다른
저장소의 패키지를 끌 수 없습니다. 공식 소스도 더 넓은 권한이 없습니다.

```ts
interface RevocationsFile {
  schemaVersion: 1;
  revocations: Array<{ kind: PackageKind; name: string; versions: string; // semver range
                        reason: string; at: string; action: "disable" | "uninstall" }>;
}
```

`versions`는 다음 문법의 범위입니다.

```
range       := alternative ("||" alternative)*
alternative := "*" | comparator (" " comparator)*
comparator  := (">=" | ">" | "<=" | "<" | "=")? semver
```

한 alternative 안의 비교식은 모두 성립해야 하고, alternative 중 하나만 맞으면
됩니다. 순서는 호스트의 `compareSemver`를 따르므로 pre-release는 그 릴리스보다
앞에 옵니다. 파싱할 수 없는 범위는 파일 전체를 무효로 만듭니다(§2.2).

폐기된 설치 버전은 부팅 때 기존 `revocationRegistry` 인터페이스(서명 피드 대신
스냅숏에서 공급)를 통해 비활성화(또는 제거)되고, 사용자에게 사유를 알립니다.

소스를 가로지르는 긴급 차단(kill switch)은 의도적으로 두지 않습니다. 공식 소스도
서비스 엔드포인트도 다른 소스가 게시한 패키지를 끌 수 없습니다. 커스텀 소스의
해로운 패키지는 사용자가(제거, 소스 제거) 또는 기기 관리가(`marketplaces.block`은
소스의 추가와 동기화를 막음, 설치된 파일 제거는 기기 관리 작업) 처리합니다.

### 10.5 공식 소스가 여전히 다른 점

| 항목 | 공식 | 관리 | 커스텀 / 직접 |
|---|---|---|---|
| 배지 | Ave Official | 조직 라벨 | 소스 id |
| 사용자가 제거 가능 | 아니오 | 아니오 | 예 |
| 사용자가 숨기기 가능 | 정책이 허용할 때만 | 아니오 | 예 |
| 다시 쓴 이력 | 거부 | 거부 | 사용자 검토 |
| 기본 설치가 지정 가능 | 앱 목록과 정책 목록 | 정책 목록 | 아니오 |
| 필수 설치가 지정 가능 | 정책 목록 | 정책 목록 | 아니오 |
| 제거·비활성화 잠금 | 정책 `requiredInstalls`로만 | 정책 `requiredInstalls`로만 | 없음 |
| 호스트 시크릿 grant 적용 | 예(§10.3) | 아니오 | 아니오 |
| 다른 소스의 패키지 폐기 | 불가 | 불가 | 불가 |

## 11. 서비스 엔드포인트

```jsonc
// GET {serviceBase}/.well-known/former-service.json
{
  "schemaVersion": 1,
  "announcements": "/announcements/v1.json",   // path on the same origin
  "telemetry": null,                            // or "/telemetry/events" (same origin) when an ingestion service exists
  "movedTo": null,                              // or "https://new-domain.example" for a domain change
  "movedFrom": null                             // on the new domain: the previous base, confirming the move
}
```

- `serviceBase` 결정 순서: 관리 정책 `service.baseUrl` → 현재 빌드 상수에 대해
  기록된 이전(아래) → 빌드 상수 `AVE_SERVICE_BASE_URL`(기본
  `https://former-site.invalid`). 사용자 설정은 없습니다. base는 https 오리진입니다.
  정책 섹션은 정확히(`{ "baseUrl": … }`) 읽고, 잘못되면 공개 base로 물러나지
  않고 서비스를 쓸 수 없는 상태(공지 없음, 텔레메트리 없음)가 됩니다. 패키징되지
  않은 빌드는 개발용 변수 `AVE_SERVICE_BASE_URL`로 스테이징 base를 지정할 수
  있고, 이때는 루프백 호스트의 평문 http도 됩니다. 패키징된 빌드는 이 변수를
  읽지 않습니다.
- **도메인 변경.** `movedTo`는 현재 base에서 https로 받은 경우에만, 그리고 새
  base의 서비스 문서가 `movedFrom`에 현재 base를 적어 확인해 준 뒤에만
  받아들입니다. 공유 네트워크 게이트(§7.4)가 서비스 base를 다루기 전까지 대상은
  IP 리터럴이나 단일 레이블 호스트가 아닌 공개 DNS 이름이어야 합니다. 받아들인
  이전은 그때의 빌드 상수와 함께 저장되며(`~/.ave/marketplaces/service.json`,
  스테이징 base는 `service.staging.json`을 따로 써서 소스 실행이 운영 이전을
  지우지 않음), 앱 업데이트가 다른 상수를 싣고 오면 버립니다. 파일로 읽을 수
  없는 기록은 믿지 않고 무시합니다. 빌드 상수당 최대 한 번만 따르고, 정책 base는
  이전을 따르지 않습니다.
- `announcements`와 `telemetry`는 서비스 오리진의 경로여야 합니다. 요청은
  리디렉션을 따르지 않고(3xx는 실패), 문서는 64 KB, 공지는 1 MB로 제한합니다.
  문서의 모르는 키는 무시하고, 호환되지 않는 변경은 `schemaVersion`으로
  구분합니다.
- **유지되는 것.** 새로 고침이 실패하면 텔레메트리 엔드포인트는 남지 않고,
  마지막 공지는 그 공지를 준 base가 여전히 유효한 base일 때만 유지합니다.
  따라서 세션 도중 정책이 잘못되거나 닿을 수 없는 base를 가리키게 되어도 이전
  base는 부팅 때와 마찬가지로 멈춥니다.
- 텔레메트리는 자격 증명 없이 `telemetry` 엔드포인트로 보내며, 문서가
  엔드포인트를 적지 않은 동안에는 동작하지 않습니다. 텔레메트리를 위한 문서
  읽기는 사용자가 동의한 뒤 첫 이벤트나 전송 때 합니다(실패하면 최대 10분마다
  다시, 유효한 문서가 6시간 지나면 다시 읽어 공지를 꺼 둔 경우에도 정책 변경이
  텔레메트리에 닿음). 문서가 유효해질 때까지 이벤트는 최대 500개까지 보관하고, 문서가
  엔드포인트를 적지 않으면 버립니다.
- 공지는 `MarketplaceAnnouncement` 계약(수준, `startsAt`/`endsAt`, 최대 세 개의
  탐색 전용 액션, 앱 버전 필터 액션)과 닫은 id 동작을 유지합니다. 활성 로케일이
  공지에 없는 설치 언어이면 액션 라벨은 `en` 라벨로 대체합니다. 업데이트 확인
  스위치가 켜져 있는 동안 부팅 직후와 6시간마다 가져오고, 가져오기에 실패하면
  아직 유효한 base에서 마지막으로 읽은 목록을 유지합니다.
- 정적 파일은 ave `web/` 사이트(`web/public/.well-known/`,
  `web/public/announcements/`)에 두고, `web/**` 변경이 머지되면 사이트 배포
  워크플로가 배포합니다. Pages `_headers` 규칙이 두 파일을 JSON으로, 5분
  캐시로 제공합니다.

## 12. 관리 정책 추가 항목

```jsonc
// policy.json (system scope)
"marketplaces": {
  "allow": ["https://github.com/acme/*", "host:git.corp.example", "path:/srv/ave/*"],  // absent = no restriction
  "block": ["host:git.example.org", "path:/tmp/*"],
  "allowHttpHosts": ["git.corp.example"],                           // plain-http hosts that need no confirmation; default none
  "requireHttps": false,                                            // true: plain http is a policy block, allowHttpHosts excepted
  "blockPrivateNetworks": false,                                    // true: internal and this-computer targets are a policy block, policy-listed hosts excepted
  "allowDirectInstall": true,
  "allowLocalSources": true,                                        // false: no folder is a source or a direct install
  "allowDisablingOfficial": false,
  "additional": [
    { "id": "corp", "url": "https://git.corp.example/ave/marketplace.git" },
    { "id": "team-share", "path": "\\\\files.corp\\ave\\marketplace" }      // a folder: `path` instead of `url`
  ],
  "defaultInstalls": [{ "kind": "plugin", "name": "wiki-search", "source": "corp" }],
  "requiredInstalls": [{ "kind": "plugin", "name": "orion-api", "source": "corp" }]
},
"service": { "baseUrl": "https://ave.corp.example" }
```

- 패턴은 저장소 동일성(§7.1)과 비교합니다. 호스트와 대소문자를 무시한 경로이며
  스킴과 포트는 따지지 않습니다. `https://github.com/acme/tools`,
  `git@github.com:acme/tools`, `https://github.com/ACME/Tools`는 Ave가 다루는
  모든 호스팅 서비스에서 같은 저장소이므로, 호스트 URL의 표기를 바꿔 규칙을 피할
  수 없습니다. 같은 저장소에 닿는 다른 이름(`ssh://git@ssh.github.com:443/…`,
  `altssh.gitlab.com`, DNS 별칭, `~/.ssh/config`의 `HostName`)까지 규칙이 다 알
  수는 없으므로, 꼭 지켜야 하는 통제는 그런 이름이 통과하지 못하는 `allow`로
  겁니다.
  `host:<host>`는 그 호스트를, URL 패턴은 그 저장소를, `*`로 끝나는 URL은 `*`
  앞 텍스트로 경로가 시작하는 모든 저장소를 맞춥니다. 그 밖의 위치에 있는 `*`는
  거부합니다. `block`이 `allow`보다 우선합니다.
- 정책이 등록한 호스트는 `allowHttpHosts`, `allow` 패턴, `additional` 소스에
  나오는 호스트입니다. 이들은 `unencrypted`, `internal-network`,
  `this-computer` 확인이 필요 없습니다(§7.4). 메타데이터와 라우팅 불가 주소는
  이들에게도 계속 거부합니다. 등록은 `token-unencrypted`를 함축하지 않습니다.
  정책은 전송을 승인할 뿐, 그 위로 사용자의 자격 증명을 보내는 것까지 승인하지
  않습니다.
- `requireHttps`와 `blockPrivateNetworks`는 입력한 대상과 카탈로그가 지정한
  대상 모두에, 다운로드와 리다이렉트 홉까지 적용됩니다(§7.4).
  `blockPrivateNetworks`는 Ave가 소유한 전송(다운로드, http/https git)의 직접
  연결에서는 실제 연결 주소에 강제합니다. ssh에서는 사전 검사만 합니다. 대상을
  스스로 해석하는 프록시 너머는 신뢰한 프록시가 강제합니다. 둘 다 0.12의 거부를
  어떤 확인도 통과하지 못하는 차단으로 되살립니다. 0.13.0까지의 앱은 모르는 키를
  섹션 무효로 읽으므로, 슬라이스 C를 담은 릴리스 이상에만 배포하세요.
- 호스트 필드(`host:` 패턴, `allowHttpHosts`, `auth.host`)에는 포트를 쓰지
  않습니다. 토큰의 `auth.host`는 소스 자신의 호스트여야 합니다.
- **폴더**(§7.7). `path:<folder>`는 그 절대 폴더와, `path:<prefix>*`는 `*`
  앞의 텍스트로 시작하는 모든 폴더와(한 폴더 아래의 폴더들을 뜻하려면
  `path:/srv/ave/*`처럼 구분자로 끝냄), `path:*`는 모든 폴더와 맞습니다. 그 밖의
  자리의 `*`는 거부합니다. `/`와 `\`는 같은 구분자이고 드라이브 문자는
  대소문자를 가리지 않습니다. 두 목록 모두 유니코드 NFC 형태로 비교합니다.
  `allow` 패턴은 적힌 철자와만 맞고, `block` 패턴은 대소문자도 무시하므로
  철자를 바꿔 빠져나갈 수 없습니다. `path:` 패턴은 폴더에만, 호스트·URL
  패턴은 git 주소에만 적용되므로 `path:` 패턴이 없는 `allow` 목록은 어떤
  폴더도 허용하지 않습니다. 폴더는 무엇도 닿기 전에 입력 경로로, 걸은 뒤에
  정규 경로로 다시 판정합니다(§7.7 3–4단계).
- `allowLocalSources`(기본값 `true`): `false`면 모든 폴더를 소스로도 직접
  설치로도 `local-sources-blocked`로 거부하며, 드라이브 매핑 조회를 포함해
  어떤 파일 시스템 호출보다 먼저입니다.
- `allowDirectInstall`(기본값 `true`): `false`면 git이든 폴더든 직접 소스를
  미리보기, 추가, 그리고 먼저 추가된 소스의 모든 계획에서 거부합니다
  (`direct-install-blocked`, §8.2).
- 이 섹션은 적힌 그대로만 읽습니다. 알 수 없는 키, 중복 키, 목록 자리의 `null`,
  파싱되지 않는 패턴,
  정책 자신의 목록이 막는 `additional` 소스, 공식도 `additional`도 아닌 소스를
  지정한 설치 항목이 하나라도 있으면 섹션 전체가 무효이고, 파일을 고칠 때까지
  공식 외 모든 소스가 `SOURCE_POLICY_BLOCKED`입니다. 오타가 열린 쪽으로 실패해서는
  안 됩니다.
- `additional` 소스는 `managed` 출처로 미리 등록됩니다. 사용자는 제거하거나 숨길
  수 없고, 이력 규칙은 공식 소스와 같습니다. `additional` 소스는 그 자체가
  등록이므로 평문 http 소스도 `allowHttpHosts` 항목이 필요 없습니다.
  `requireHttps: true`일 때만 그 호스트가 `allowHttpHosts`에 있어야 하고, 없으면
  섹션이 무효입니다.
- `url` 대신 `path`가 있는 `additional` 항목은 관리 폴더입니다. `ref`·`auth`가
  없고, 경로는 절대 경로이며(시스템 파일에서 `~`는 어떤 홈도 가리키지 않음)
  실행 중인 플랫폼 기준으로 읽고, 항목을 통해 `network-folder`를 가집니다.
  `allowLocalSources: false`일 때, 정책 자신의 목록이 막을 때, 다른
  `additional` 폴더와 같거나 그것을 포함하거나 그 안에 있을 때 섹션을
  무효로 만듭니다.
- `defaultInstalls`와 `requiredInstalls`는 §10.2를 따르며 공식·관리 소스만 지정할
  수 있습니다. 두 목록에 모두 있는 키는 필수로 취급합니다.
- **정책 변경은 재시작 없이 다음 작업부터 적용됩니다.**
  - 서비스는 `PolicySource`(`FilePolicySource`,
    `src/marketplace/sources/policy.ts`)로 정책을 읽습니다. 모든 작업(미리보기,
    추가, 확인 추가, 동기화, 계획, 실행, 목록) 시작 때 파일 크기, 수정 시각과
    상태 변경 시각, inode와 장치를 지난 읽기와 비교합니다. 그래서 권한 변경이나
    바꿔 놓은 파일도 변경으로 칩니다. 다르면 파일을 읽어 내용의 sha256을
    비교합니다.
  - 기록한 시각은 그 읽기가 파일의 마지막 변경보다 3초 이상 뒤에 시작했을 때만
    믿습니다. 파일 시각은 거친 시계(NTFS와 Linux는 커널 틱, FAT는 2초, SMB와
    NFS는 서버 시계)로 찍히므로, 읽기가 본 변경과 같은 틱 안에서 크기를 유지하고
    수정 시각을 되돌려 다시 쓰면 비교하는 필드가 모두 그대로입니다. 그 구간 안에서
    읽었거나 변경 시각이 시계보다 앞서 있었으면 다음 확인은 파일을 읽어 sha256을
    다시 비교하고, 구간 밖의 첫 읽기부터 다시 지름길을 씁니다. 확인할 때 시계가
    기록한 읽기의 시작 시각보다 뒤로 가 있어도 파일을 읽습니다.
  - 이 규칙은 시각 단위, 쓰는 쪽 시각 시계가 이 컴퓨터 시계보다 늦은 정도, 읽기
    뒤에 이 시계가 뒤로 물러난 정도의 합이 3초 미만일 때 성립합니다. 그 범위를
    벗어나면(파일 서버 시계가 더 늦거나, 두 확인 사이에 시계가 뒤로 갔다가 다시
    앞으로 온 경우) 다시 쓴 내용을 늦게 알아챌 수 있습니다. 비교하는 필드를 바꾸는
    다음 변경 때 알아챕니다.
  - 바뀐 정책은 서비스의 배타적 작업 잠금 아래에서 적용합니다. 게이트, 레지스트리의
    관리 소스와 필터, 설치기에 한꺼번에 반영되므로, 어떤 작업도 섞인 정책을 보지
    않습니다.
  - 갱신은 하나의 큐를 거쳐 한 번에 하나씩 돕니다. 갱신마다 파일을 읽고 비교하며,
    바뀌었으면 다음 갱신이 시작되기 전에 적용합니다. 그래서 가장 최근의 읽기가 늘
    마지막으로 적용되고, 순서가 뒤바뀌어 끝나는 읽기가 없습니다.
  - 모든 작업은 자신보다 늦지 않게 시작한 갱신을 기다린 뒤, 그 갱신이 적용해 둔
    정책 아래에서 돕니다.
    - 이미 돌고 있는 갱신은 파일을 너무 일찍 읽었을 수 있으므로, 작업은 그다음
      갱신을 기다립니다.
    - 그사이 도착한 모든 작업은 줄 서 있는 그 갱신 하나를 함께 씁니다. 그래서
      계속 겹치는 작업들 사이에서도 읽기는 한 번만 더 들고, 그 안에서 변경을
      봅니다.
    - 호출자는 취소될 수 있습니다(업데이트 스케줄러의 호출은 종료 신호를
      지닙니다). 취소된 호출자는 갱신을 시작하지 않습니다. 도착할 때 거부되고,
      기다리는 동안 모든 호출자가 취소된 대기 갱신은 시작하지 않습니다. 살아 있는
      호출자가 하나라도 있으면 갱신은 돕니다. 갱신이나 잠금을 기다리는 동안 취소된
      호출자는 작업 본문에 들어가지 않습니다.
  - 형식이 잘못되었거나 읽을 수 없는 파일은, 한 번 읽었을 때와 똑같이 경고와 함께
    닫힌 쪽으로 적용합니다. 변경은 누가 기다리든 적용하지만, 경고는 그 갱신을
    기다리는 호출자가 살아 있을 때만 남기므로 종료 뒤에 끝난 갱신은 아무것도 말하지
    않습니다.
  - 잠금 순서는 마켓플레이스 작업이 어떤 플러그인 수명 주기 잠금보다 먼저입니다.
    - 설치는 작업의 공유 잠금을 잡은 뒤 플러그인 잠금을 잡습니다.
    - 플러그인 잠금을 잡은 채 서비스를 부르는 코드는 이 순서를 뒤집습니다. 그러면
      설치가 공유 잠금을 쥐고 같은 플러그인 잠금을 기다리는 동안, 정책 변경의 배타
      잠금을 기다릴 수 있습니다.
    - 그래서 그런 코드(알림에서 은퇴한 이전 플러그인 제거)는 먼저 작업 하나에
      들어가고(`asOneOperation`), 그 안에서 플러그인 잠금을 잡으며, 두 잠금 아래에서
      권한을 다시 확인합니다.
  - 작업은 자신이 도는 동안에만 중첩 호출을 소유합니다.
    - 서비스는 카탈로그 변경을 작업 밖에서 알리므로, 그 알림이 시작하는 백그라운드
      업데이트 확인은 갱신과 공유 잠금을 거쳐 자기 작업에 들어갑니다.
    - 작업이 시작한 일이 작업이 끝난 뒤에도 돌고 있으면 그 일도 같은 길을 갑니다.
    - 백그라운드 스케줄러(§7.3: 부팅 패스, 탐색, 적용 확인, 업데이트 목록)는 모든
      진입(지금 확인, 재시도, 재확인, 설정 변경)과 재개, 기한 확인 타이머를 자신이
      시작된 컨텍스트, 곧 어떤 작업 밖에서 돌립니다. 어느 작업 안에서(스냅숏을
      게시한 동기화, 설치) 확인을 요청하든, 그 작업이 아직 도는 중에 확인이 시작되더라도
      확인의 서비스 호출은 각각 자기 작업입니다.
  - 계획은 만들어질 때의 정책 다이제스트를 기록합니다. 다른 다이제스트 아래에서
    실행하면 `PLAN_EXPIRED` 사유 `policy-changed`로 실패하고, 시트가 *다시 검토*를
    제시합니다.
  - 정책을 읽을 수 없거나(권한 변경 포함) 무효가 되면 시작 때 무효 정책과 같이 동작합니다. 공식
    소스만 쓰고 `policy-invalid`를 보여 줍니다. 파일을 고친 뒤 첫 작업에서
    회복합니다.
- `autoUpdate`(§18.6)는 슬라이스 F의 몫입니다.

## 13. IPC 계약

| 채널 | 요청 | 응답 |
|---|---|---|
| `ave:marketplace:sources:list` | — | `SourceView[]` |
| `ave:marketplace:sources:preview` | `{ input: string; ref?: string; token?: string; acknowledge?: SourceWarning[] }` | `SourcePreview \| DirectPackagePreview \| { type: "confirm"; warnings }` |
| `ave:marketplace:sources:add` | `{ previewId: string; id?: string }` | `SourceView` |
| `ave:marketplace:sources:acknowledge` | `{ id; warnings: SourceWarning[] }` | `SourceView`, 동기화 뒤 |
| `ave:marketplace:sources:remove` | `{ id }` | `{ orphanedPackages: PackageKey[] }` |
| `ave:marketplace:sources:set-enabled` | `{ id; enabled }` | `SourceView` |
| `ave:marketplace:sources:refresh` | `{ id? }` | `SyncResult[]` |
| `ave:marketplace:sources:accept-rewrite` | `{ id; commit }` | `SourceView` |
| `ave:marketplace:sources:set-token` / `delete-token` | `{ host; token? }` | `{ ok: true }` |
| `ave:marketplace:catalog:list` | `{ kind?; sourceId?; query?; installedOnly? }` | `CatalogRow[]` |
| `ave:marketplace:package:detail` | `PackageKey` | `PackageDetail`(버전, 호환성, 출처, authority, 단계 미리보기) |
| `ave:marketplace:install:plan` | `PackageKey & { version? }` | `InstallPlan`(`snapshotCommit`, `versionCommit` 포함) |
| `ave:marketplace:install:execute` | `{ planId }` | `InstallResult` |
| `ave:marketplace:update:plan` | `PackageKey` | `UpdatePlan`(커밋 범위, authority 변화, 대기 중인 이력 재작성) |
| `ave:marketplace:uninstall` | `PackageKey` | `UninstallResult` |
| `ave:marketplace:direct:preview` | `{ input; subdir?; ref? } \| { serverJson: string } \| { mcpConfig: string }` | `DirectPackagePreview` |
| `ave:marketplace:announcements` | — | `MarketplaceAnnouncement[]` |
| `ave:marketplace:content:installed` | — | `{ ok: true; content: InstalledContent } \| { ok: false; error: "installed-content-unavailable" }` (themes, languages, fonts, broken packages; §5.5) |
| `ave:marketplace:content:language-messages` | `locale` | `{ ok: true; messages } \| { ok: false; error: "installed-content-unavailable" \| "language-not-installed" }` |
| `ave:marketplace:updates:status` | — | `UpdateStatusView`(§13.1) |
| `ave:marketplace:updates:check` | — | 적용 확인의 탐색과 분류가 끝날 때 `UpdateStatusView`(§7.3) |
| `ave:git:runtime:status` | — | `GitRuntimeStatus` |
| `ave:git:runtime:install` | — | `GitRuntimeStatus`(진행은 이벤트로) |

이벤트: `marketplace:sync-progress`, `marketplace:catalog-changed`,
`marketplace:install-progress`(`{ planId, rung, phase, bytes? }`),
`marketplace:updates-available`(업데이트마다 상태 포함, §13.1),
`marketplace:update-status`(바뀔 때 `UpdateStatusView`),
`marketplace:boot-installs-applied`(기본·필수 설치), `git-runtime:progress`.

모든 채널은 호스트 렌더러 전용(`validateHostRendererSender`)이고 지금처럼 감사
로그를 남깁니다. `ave:git:runtime:install`은 여기에 더해 실시간 키보드 제스처를
요구합니다. 마켓플레이스가 실행할 바이너리를 내려받기 때문입니다. `planId`와 `previewId`는 1회용이고 10분 뒤 만료됩니다
(`PLAN_EXPIRED`). 현재 채널의 처리는 §16.2에 있습니다. 폴더 소스는 채널을
더하지 않습니다. 폴더는 `sources:preview`에 입력하고 `sources:add`로
추가합니다(§13.1). 폴더 대화상자(`sources:pick-folder`, `sources:reveal`,
슬라이스 D2)와 자동 업데이트 채널(슬라이스 F)은 §18.9에 있습니다.

### 13.1 구현 결과

위 표와 출시된 계약(`CHANNELS.gitMarketplace`, `src/shared/git-marketplace.ts`의
`GitMarketplaceApi`)이 다르면 계약이 기준입니다.

- 모든 응답은 봉투입니다. `{ ok: true, value }` 또는
  `{ ok: false, code, message, detail? }`입니다. `code`는 §14 코드이거나,
  `invalid-request`(서비스에 닿기 전에 요청 형태가 거부됨), `unauthorized-frame`,
  `unavailable`(서비스가 시작하지 못했거나 마켓플레이스 오류가 아닌 이유로 실패함)입니다.
  `detail`은 사유와 그 문장이 쓰는 값입니다(§14). `parseGitMarketplaceResult`는
  사유가 그 코드에 속하고 필드가 선언된 타입인 `detail`만 남기고, 나머지는 코드와
  메시지를 둔 채 버립니다. `message`는 main의 영어 문장이며 *세부 정보 복사*로만
  보입니다.
- `sources:preview`는 `{ input; ref?; subdir?; auth: "none" | "token" | "ssh";
  token?; acknowledge? }`를 받습니다. 마켓플레이스 미리보기나 단일 패키지
  미리보기(각각 `badges` 포함)를 돌려주거나, 주소가 `acknowledge`에 없는 확인을
  요구하면 `{ type: "confirm"; warnings }`를 돌려줍니다(§7.2 2단계). git 폴더에서
  직접 설치하는 경로도 `subdir`를 붙여 이 채널을 씁니다. `acknowledge`에는
  §2.1의 경고만 한 번씩 들어가고, *추가*는 미리보기가 실은 것을 그대로
  저장합니다.
- 폴더도 같은 미리보기를 거칩니다(§7.7). `ref`, `subdir`, 로그인, 토큰을 받지
  않으며(`SOURCE_URL_REJECTED` `folder-options`), 다른 컴퓨터의 폴더는
  `{ type: "confirm"; warnings: [{ warning: "network-folder", host, address
  }] }`로 답합니다(`host`는 서버, 드라이브 매핑이 서버를 밝히지 않으면
  `null`). 모든 미리보기와 `SourceView`는 `transport: "git" | "folder"`를
  담고, 폴더의 것은 `url: null`과 정규 `path`를, 미리보기는 `resolvedFrom`
  (걸으며 링크를 해석했을 때의 입력값) 또는 `null`을 더 담습니다. 폴더의
  `commit`과 `pinnedCommit`은 `local-` 리비전입니다. `InstallPlan`은
  `notInstalled`(폴더 플러그인에서 빠진 최상위 항목, 그 밖에는 빈 목록)를
  담고, `RungView`와 설치 진행은 `folder` 단계를 가리킬 수 있으며, 패키지
  출처는 `repository`나 `folder` 중 하나를 담고 다른 하나는 `null`입니다.
- `remove`, `set-enabled`, `accept-rewrite`, `set-token`, `delete-token`,
  `acknowledge`는 위치 인자(`id`, `enabled`, `commit`, `host`, `token`,
  `warnings`)를 받고, `refresh`는 `SourceView[]`를 돌려줍니다.
  `acknowledge`(preload의 `acknowledgeSource`)는 어느 출처의 소스에든 확인을 더하고
  다시 동기화합니다. IPC 도메인은 빈 목록이나 모르는 경고를 `invalid-request`로
  거부합니다.
- `SourceView`는 `acknowledged`와 `badges`를, 카탈로그 항목은 소스의 배지를
  `sourceBadges`로 싣습니다(§15.1). `RungView`는 평문 http 다운로드에
  `unencrypted`를 싣습니다(§15.2).
- `catalog:list`는 `{ entries, counts, sourceCount, syncedAt }`을 돌려줍니다.
  `uninstall`은 `{ sourceId | null; kind; name; removeData? }`를 받습니다.
  `sourceId: null`은 어떤 소스에도 묶이지 않은 패키지이고, `removeData`는 MCP
  서버에만 적용됩니다(§5.2).
- `direct:preview`는 `{ serverJson; select?: { package? | remote? } }`만 받아
  실행될 명령과 `planId`를 돌려주고, 이 `planId`는 `install:execute`가 소비합니다.
  MCP 설정 붙여넣기는 MCP 설정의 가져오기를, git 폴더는 `sources:preview`를 씁니다.
- MCP 서버가 저장됐지만 연결되지 않으면 `InstallResult.connectionWarning`이
  채워지고, 결과는 "설치됨"이 아니라 그 사실을 알립니다.
- 추가: `deep-link:take`, `boot-installs:notice`, `boot-installs:dismiss`와 이벤트
  `marketplace:deep-link`, `marketplace:boot-installs-applied`. 메인은 딥링크나
  부팅 단계의 알림을 탭이 읽을 때까지 보관합니다. 그래서 창이나 탭이 생기기 전에
  도착한 링크도 도착합니다. 거부된 프레임은 아무것도 소비하지 않습니다.
- 딥링크는 확인 UI만 엽니다. `ave://install|uninstall/<kind>/<name>@<source>`는
  패키지 시트를, `ave://marketplace/add?url=`는 주소만 채우고 검사는 하지 않은
  추가 대화상자를 엽니다. 주소가 경로나 `file:` URL인 링크는 거부합니다
  (§18.3 #7). 이 링크는 `{ action: "add-refused"; reason: "deep-link-path" }`로
  전달되고, 대화상자는 빈 채로 열려 이유를 말합니다. 기존 `ave://install/<slug>` 링크는 자기 파서를 그대로
  쓰며, 두 형태는 겹치지 않습니다.
- 공지는 요청 채널이 아니라 기존에 밀어 주는 공지 이벤트로 렌더러에 닿습니다.
- 계획은 쓰이거나, 만료되거나, 대체될 때까지 유효합니다. 같은 패키지를 다시
  계획하면 이전 계획은 버려집니다. 쓰이지 않은 계획과 미리보기는 다른 일이 없어도
  만료 시점에 버려지므로, 버려진 미리보기의 클론과 입력한 토큰이 남지 않습니다.
- `updates:status`와 `updates:check`는 스케줄러가 답합니다(§7.3).

  ```ts
  interface UpdateStatusView {
    discovery: { lastAttemptAt: string | null; lastSuccessAt: string | null;
                 result: "ok" | "partial" | "offline" | "error" | null;
                 nextAt: string };     // the earlier of the discovery and apply-check due times, not before now
    applyCheckAt: string | null;
    running: boolean;                  // a discovery or an apply check is in flight
    historyReset: boolean;             // updates.json could not be read and was started again
    packages: PackageUpdateView[];     // updates from the sources the last discovery reached, minus skipped versions,
                                       // each with its state; an unreached source's only as shown before, `stale: true`
  }
  ```

  패키지의 `state`는 §18.7.5의 여덟 가지 중 하나입니다(`UPDATE_PACKAGE_STATES`).
  `stale: true`는 마지막 탐색이 소스에 닿지 못한 패키지를 표시하며, 그 상태는 새 분류가
  아니라 이전 탐색의 것입니다(§7.3). 창이 로드되기 전과 격리된 E2E 실행에는 스케줄러가
  없어서 둘 다 `unavailable`로 답하고, 그 메시지("update checks have not started")는
  *세부 정보 복사* 뒤에 있습니다. `marketplace:update-status`는 같은 보기를 바뀔
  때마다 보냅니다.
- `marketplace:updates-available`은 `state`가 있는 `PackageUpdateView`를 보내며, 사용자가
  필요한 상태만 담습니다(`updateNeedsUser`: `needs-review`, `manual`, `failed`,
  `applied-not-running`, `approval-pending`). `manual`은 업데이트 알림이 켜져
  있을 때만(`updateCheckEnabled`) 보냅니다. 건너뛴 버전은 main에서 뺍니다.
- 마켓플레이스가 설치한 MCP 서버는 `packages/mcp-installs.json`에 기록됩니다.
  붙여넣은 서버는 소스 없이 기록되고, 기록된 서버만 여기서 업데이트·제거할 수
  있습니다. MCP 거버넌스 정책(Layer 1)은 계획할 때와 설치할 때 두 번
  확인합니다(`PACKAGE_POLICY_BLOCKED`).
- 메시지 키는 P6가 옛 탭의 `marketplace.*` 키를 걷어낼 때까지 `gitMarketplace.*`
  아래에 있습니다(예: `gitMarketplace.error.authRequired`). 탭은 P6 전까지
  `AVE_GIT_MARKETPLACE=1`(`window.ave.env.gitMarketplace`)일 때만 보입니다.

## 14. 오류 코드

모든 코드에는 사유 없는 문장이 있고, 사유가 있는 코드는 실패가 `detail`을 담을 때
고르는 사유별 문장이 하나씩 있습니다(§13.1). 문장은 무슨 일이 있었고 무엇을 하면
되는지 말합니다. main의 영어 `message`는 *세부 정보 복사*로만 볼 수 있습니다.
`failureText`(`labels.ts`)는 `default` 없이 코드와 사유를 빠짐없이 다루고,
`labels.test.ts`가 `MARKETPLACE_ERROR_CODES`와 `MARKETPLACE_ERROR_REASONS`
(`errors.ts`)를 나열해 검사합니다. 키는 `gitMarketplace.error.*`에, 소스 정책 차단은
`gitMarketplace.policy.*`에 두어 MCP 거버넌스 문장(`gitMarketplace.error.policyBlocked`)과
섞이지 않습니다.

소스 실패의 문장은 그 실패가 무엇에 관한 것인지(`FailureSubject`)에 따라서도
달라집니다. 입력 중인 주소(마켓플레이스 추가, Git URL로 설치), 출처·로그인
방식·저장된 토큰 여부를 아는 목록의 소스, 또는 특정 소스가 없는 경우입니다.
사용자가 바꿀 수 없는 칸을 확인하라고 하지 않습니다. 주소·브랜치·폴더 안내는
입력 중인 주소와 사용자가 추가한 소스(*소스 제거* 후 다시 추가)에만 씁니다.
공식 소스는 *새로 고침*과 마켓플레이스 운영자, 조직 소스는 관리자를 안내합니다.
로그인 문장은 행이 제공하는 단계를 말합니다. 토큰 소스의 행에는 *토큰 설정…*
(추가, 또는 권한이 없을 수 있는 저장된 토큰 교체), 토큰 없이 직접 추가한 소스는
*소스 제거* 후 토큰과 함께 다시 추가, 토큰 없이 설정된 조직 소스는 관리자입니다.
변형은 키 접미사(`.custom`, `.managed`, `.owned`, `.entry`, `.setToken`,
`.rejected`, `.readd`, `.other`)이고, `labels.test.ts`가 모든 코드와 사유를 모든
대상에 대해 두 카탈로그에서 검사합니다.

| 코드 | 언제 | 사유(detail 필드) | 문장 키 |
|---|---|---|---|
| `GIT_RUNTIME_MISSING` | 쓸 수 있는 git 없음 | — | `gitMarketplace.error.gitMissing` |
| `GIT_RUNTIME_TOO_OLD` | `system` 모드에서 시스템 git이 2.45.1 미만 | — | `.gitTooOld` |
| `GIT_RUNTIME_INSTALL_FAILED` | 관리형 다운로드/검증/압축 해제/스모크 테스트 실패 | 단계: `checking`, `downloading`, `verifying`, `extracting`, `smoke-testing`, `installing`(마지막 제자리 이동) — 필드 없음 | `.gitInstallFailed`, `.gitInstallFailed.<phase>` |
| `SOURCE_URL_REJECTED` | §18.3 #1–4와 #7의 거부, 그리고 지원하지 않는 입력. 확인이 없음 | 정규화기에서: `credentials-in-url`, `helper-transport`(scheme), `scheme-unsupported`(scheme), `format`(쿼리, 프래그먼트, 공백, 제어 문자, 백슬래시). 게이트에서, 연결이 쓸 주소에 대해: `address-metadata`(host, address), `address-unroutable`(host, address), `catalog-this-computer`(source, host). 딥링크에서: `deep-link-path`. 폴더 경로에서(§7.7): `relative-path`, `device-path`, `windows-path`, `network-file-url`, `unc-without-share`, `outside-root`, `folder-options`. 다운로드 URL 자체의 거부는 담지 않음 | `.urlRejected`, `.urlRejected.<reason>`. 두 주소 사유는 입력 중인 주소와 사용자가 추가한 소스에만 "주소를 확인하세요"라고 하고, 그 밖에는(`.network`) VPN·프록시·hosts 파일과 관리자를 안내 |
| `SOURCE_POLICY_BLOCKED` | 관리 정책 allow/block, `requireHttps`, `blockPrivateNetworks`, `allowLocalSources`, `allowDirectInstall`, 또는 공식이 아닌 대상에 대해 읽을 수 없는 정책 | `blocked-by-pattern`(target, pattern, policyPath), `not-in-allow-list`(target, policyPath), `https-required`(target, policyPath), `private-network-blocked`(target, address, policyPath), `local-sources-blocked`(target, policyPath), `direct-install-blocked`(target, policyPath), `policy-invalid`(error) | `gitMarketplace.policy.blocked`, `.blockedByPattern`, `.notInAllowList`, `.httpsRequired`, `.privateNetworkBlocked`, `.localSourcesBlocked`, `.directInstallBlocked`, `.policyInvalid` |
| `SOURCE_CONFIRMATION_REQUIRED` | 대상이 소스에 없는 확인을 요구함(§7.4): 동기화, 계획, 설치 때, 또는 어느 소스도 지정하지 않은 다운로드 | 경고: `unencrypted`(host), `token-unencrypted`(host), `internal-network`(host, address), `this-computer`(host, address), `internal-downloads`(source, host), `network-folder`(server, path: 다른 컴퓨터의 폴더, 그 확인이 없는 폴더 소스를 읽을 때) | `.confirmationRequired`. 사유가 있으면 `gitMarketplace.warning.<warning>`(그 확인 자신의 질문, `198.18.0.0/15` 주소는 `internalNetwork.proxyRange`, 드라이브 매핑이 서버를 밝히지 않으면 `networkFolder.unknownServer`, macOS·Linux에서는 `networkFolder.automount`) |
| `SOURCE_NAME_RESERVED` | 예약된 id | — | `.nameReserved` |
| `SOURCE_ID_INVALID` | id가 2–63자의 소문자·숫자·`-`가 아니거나, 그런 소스가 없음 | — | `.idInvalid` |
| `SOURCE_ID_TAKEN` | 이미 쓰는 id나 이미 추가된 저장소. 이미 소스인 폴더, 또는 소스를 포함하거나 그 안에 있는 폴더(§7.7) | — | `.idTaken` |
| `SOURCE_AUTH_REQUIRED` | 401/403, ssh 거부. Ave가 저장된 토큰을 건넸는데 "저장소 없음"이 돌아올 때 | `token`(host), `token-no-access`(host: 저장된 토큰에 호스트가 "저장소 없음"으로 답함, 토큰에 권한이 없을 수 있음), `token-unencrypted`(host: 호스트가 평문 http로 로그인을 요구하는데 소스에 `token-unencrypted`가 없어 자격 증명을 내주지 않음), `ssh`(host) — git 메시지에서. 다운로드 거부는 담지 않음(다운로드 호스트가 토큰의 호스트와 다를 수 있음) | `.authRequired`, `.authRequired.token`, `.authRequired.tokenNoAccess`, `.authRequired.ssh`와 아래 변형. `.authRequired.tokenUnencrypted`와 `.entry`, `.setToken` |
| `SOURCE_SSH_HOST_UNKNOWN` | known_hosts에 없거나 다른 호스트 키 | `unknown`(host, port), `changed`(host, port) — ssh가 "remote host identification has changed"를 출력하면 `changed`. 문장에 `ssh-keyscan`이나 `ssh-keygen -R` 명령이 들어가고 *명령 복사*가 그것을 복사함 | `.sshHostUnknown`, `.sshHostUnknown.unknown`, `.sshHostUnknown.changed` |
| `SOURCE_REF_NOT_FOUND` | 브랜치나 태그 없음 | `missing`(ref, repository, available) — fetch가 실패한 뒤 `ls-remote`로 브랜치, 그다음 태그를 최대 10개 나열 | `.refNotFound`, `.refNotFound.missing` |
| `SOURCE_UNREACHABLE` | 네트워크, DNS, 타임아웃, 저장소가 없다고 답하는 호스트 | `offline`, `dns`, `refused`, `timeout`, `http-status`(status), `tls`, `proxy`(proxy), `not-found`와 `not-found-ssh`(Ave 토큰 없이 호스트가 "저장소 없음"으로 답함. 비공개 저장소에도 같은 답을 하므로 어느 쪽이라고 단정하지 않음) — `offline` 외에는 host 포함. git 메시지, 게이트의 이름 풀이 오류, 실행 자체의 타임아웃, 쓸 수 없는 PAC 항목, 다운로드 상태 코드에서 | `.unreachable`, `.unreachable.<reason>` |
| `SOURCE_NOT_A_MARKETPLACE` | 인식할 수 있는 것이 없음 | — | `.notAMarketplace`와 그 변형 |
| `SOURCE_INDEX_INVALID` | 인덱스 검증 실패 | — | `.indexInvalid` |
| `SOURCE_HISTORY_REWRITTEN` | 후손이 아닌 후보 | — | `.historyRewritten` |
| `SOURCE_DISABLED` | 숨긴 소스에서 설치·업데이트 요청(그 소스에 묶인 패키지를 위해 동기화는 계속함, §7.3) | — | `.sourceDisabled` |
| `SOURCE_LOCAL_DATA_DAMAGED` | 소스의 다운로드한 사본을 쓸 수 없음(§2.1), 또는 복구가 그것을 옮기거나 유지한 핀을 되쓰지 못함 | 핀 잃음: `state-missing`, `state-invalid`, `state-unreadable`; 핀 유지: `snapshot-invalid`, `snapshot-unreadable`, `repository-damaged`; 복구: `repair-failed`(유지한 핀 있음), `repair-failed-unpinned`(유지할 핀 없음), `repair-write-failed`(sourceId) — 메시지는 파일을 소스 기준 상대 이름으로, fs 오류는 코드로만 밝히며 홈 경로를 쓰지 않음. 문장은 소스를 행과 같은 이름으로 부름(공식 소스는 출처 이름, 그 밖은 라벨, 목록의 소스를 모를 때만 id) | `.localDataDamaged`, `.localDataDamaged.<reason>` |
| `SOURCE_LIST_UNREADABLE` | 사용자가 추가한 소스 목록 `marketplaces/sources.json`을 읽을 수 없거나 Ave 형식이 아님. 사용자가 고치거나 지울 때까지 모든 소스 변경을 거부(사용자 데이터이므로 복구하지 않음) | `unreadable`(fsCode), `invalid` — 메시지는 파일 이름과 fs 오류 코드만 밝히며 홈 경로를 쓰지 않음 | `.listUnreadable`, `.listUnreadable.<reason>` |
| `SOURCE_LOCAL_UNREADABLE` | 폴더 소스나 추가 중인 폴더를 읽을 수 없음(§7.7). 마지막으로 성공한 스냅숏은 계속 제공하고 다음 읽기에서 다시 시도 | `not-found`(path), `permission`(path, message), `io`(path, message), `moved`(path, target: 저장된 경로가 이제 다른 곳을 가리키며, 그곳은 읽지 않음), `not-a-directory`(path), `ambiguous-case`(path: 대소문자를 구분하는 볼륨에서 대소문자를 무시하면 입력 이름과 맞는 항목이 둘), `changed-during-read`(path) — `message`는 시스템의 것을 정리(scrub)한 것 | `.localUnreadable`, `.localUnreadable.<reason>`. `notFound`는 `.entry`(입력 중인 폴더)와 `.managed`, `moved`는 `.managed` 변형 |
| `PLAN_EXPIRED` | 만료되었거나 재사용된 계획/미리보기 id, 또는 다른 관리 정책 아래에서 만든 계획(§12) | `policy-changed` | `.planExpired`, `.planExpired.policyChanged` |
| `PACKAGE_INCOMPATIBLE` | 이 설치에 제공되는 버전이 없음: `minAppVersion`이 앱 버전보다 높음, 다른 플랫폼, canary 없이 프리릴리스, 이 설치를 제외하는 롤아웃 | `min_app_version`(name, version), `platform`(name, platform), `host_protocol`(name) — 제외된 버전을 알 때 | `.incompatible`, `.incompatible.minAppVersion`, `.incompatible.platform`, `.incompatible.hostProtocol` |
| `PACKAGE_COMPAT_UNDECLARED` | `requires.minAppVersion` 없는 git 설치 플러그인 | — | `.compatUndeclared` |
| `PACKAGE_YANKED` / `PACKAGE_REVOKED` | 모든 버전이 회수되거나 폐기됨(모두 폐기면 revoked) | — | `.yanked` / `.revoked` |
| `PACKAGE_ID_CONFLICT` | 같은 `(kind, name)`이 다른 소스에서, 또는 소스 없이 설치됨. git에 묶인 플러그인 위로 서명 카탈로그의 설치·업데이트·롤백을 할 때도 | — | `.idConflict` |
| `PACKAGE_REQUIRED_BY_POLICY` | `requiredInstalls` 패키지의 제거·비활성화 | — | `.requiredByPolicy` |
| `PACKAGE_POLICY_BLOCKED` | MCP 거버넌스 정책(Layer 1)이 서버를 거부함. 계획할 때와 설치할 때 확인 | — | `.policyBlocked` |
| `ARTIFACT_NOT_PINNED` | 단계 건너뜀: git에 sha256 없음 | — | `.artifactNotPinned` |
| `ARTIFACT_DIGEST_MISMATCH` | sha256 불일치 | — | `.digestMismatch` |
| `MANIFEST_MISMATCH` | plugin.json과 디스크립터 불일치 | — | `.manifestMismatch` |
| `process-entry-unconfined` | OS 도구 샌드박스가 꺼져 있거나 Windows에서의 `process` 진입점(§18.4.9) | — | `formatIpcError.processEntryUnconfined` |
| `process-entry-requires-pinned-artifact` | sha256으로 고정된 릴리스·아카이브 아티팩트에서 설치되지 않은 `process` 진입점(§18.4.9) | — | `formatIpcError.processEntryRequiresPinnedArtifact` |
| `NO_INSTALLABLE_ARTIFACT` | 모든 단계가 건너뛰어졌거나 실패(실패한 단계가 모두 로그인을 요구했으면 대신 `SOURCE_AUTH_REQUIRED`) | `folder-has-no-build`(name: `plugin.json`이 없는 폴더 플러그인, §7.7) | `.noArtifact`, `.noArtifact.folderHasNoBuild` |
| `CONTENT_RULE_VIOLATION` | 콘텐츠 종류 파일 규칙 위반, 폴더 읽기 규칙 위반(§7.7) | `link-outside-folder`(path, target), `link-to-network`(path, target), `special-file`(path), `case-collision`(path), `limit`(path, limit) — `path`는 폴더 기준 상대 경로, `target`은 링크 자신의 텍스트 | `.contentRule`, `.contentRule.<reason>` |
| `invalid-request`, `unauthorized-frame`, `unavailable` | 봉투에만(§13.1) | — | `.invalidRequest`, `.unauthorizedFrame`, `.unavailable` |

실패는 `MarketplaceProblem`이 세 가지 톤 중 하나로 보여 줍니다(§18.8): 정책
(`SOURCE_POLICY_BLOCKED`, `PACKAGE_POLICY_BLOCKED`, `PACKAGE_REQUIRED_BY_POLICY`),
경고, 오류. 경고 톤은 *취소*와 *계속*으로 묻습니다(추가 대화상자의 확인 단계).
사용자가 허용할 수 있는 실패는 사유가 있는 `SOURCE_CONFIRMATION_REQUIRED`, 또는
`SOURCE_AUTH_REQUIRED` `token-unencrypted`입니다. 이 실패는 노란색으로 *허용…*
버튼과 함께 보입니다(`internal-downloads`는 *사내 다운로드 허용*). 버튼은 그
경고로 `sources:acknowledge`를 부릅니다(`allowableWarning`, `labels.ts`). 이 코드 밖의 실패(설정 저장, 플러그인 파일, 붙여넣은 MCP 설정)는 자기
문장으로 오류 톤을 씁니다. 모든 메시지는 `scrubDiagnosticSecrets`(`src/shared/dlp.ts`:
URL userinfo, authorization·토큰 값, 자격 증명 도우미 줄)로 지워집니다. main이 봉투에
넣기 전에, 정규화기가 거부한 주소를 되풀이하기 전에, 그리고 *세부 정보 복사*가 복사하기
전에 `MarketplaceProblem`이 다시 지웁니다.

백그라운드 동기화의 실패는 `sources:list`로 소스 화면에 닿습니다. `SyncResult`가
detail을 담고, 동기화기가 그것을 `state.json`의 `lastSync.detail`에 저장하고, 상태
검증기는 사유가 `lastSync.result`에 속할 때만 남기고 아니면 코드는 두고 버리며,
`sourceStatus`가 `unreachable`과 `auth-required` 보기에 복사합니다(§15.4).

폴더 소스의 백그라운드 읽기도 같은 길로 실패합니다. `SOURCE_LOCAL_UNREADABLE`
세부 정보는 `lastSync.detail`에 저장되고, 행은 이유(*폴더 없음*, *폴더를 읽을
수 없음*, *폴더가 옮겨짐*)와 위 문장을 보입니다. 이후 슬라이스가 이 빌드가 아직
구분하지 않는 상황에 대해 §18.8이 나열한 업데이트 사유를 더합니다. 코드나
사유를 더하는 슬라이스가 그 문장도 더합니다(§18.8, §18.10).

## 15. UI 명세

목업은 아래 모든 상태를 보여 줍니다. 설정 → 마켓플레이스가 앱 안의 스토어가
됩니다(웹 스토어는 없어짐). 폴더 소스의 행은 git 행이 주소를 보이는 자리에
경로를 보입니다(§15.4). 폴더 선택기, *표시(Reveal)*, 폴더 배지와 출처 행은
슬라이스 D2입니다(§18.4.8). 업데이트 카드(§15.7.1)는 구현됐고, 0.13.0 다음
릴리스에 들어갑니다.

### 15.1 둘러보기

- 헤더: 검색창, **Sources** 버튼, **Add** 메뉴(Add marketplace…, Install from
  Git URL…, Add MCP server…), 소스 필터 칩(All sources + 켜진 소스마다 하나).
- 종류 탭: Plugins, MCP, Skills, Agents, Themes, Fonts, Languages, Providers,
  Messaging — 각각 개수 표시.
- 카드: 아이콘, 표시 이름, 한 줄 설명, **소스 배지**(`Ave Official`은 방패
  글리프, 관리 소스는 건물 글리프와 라벨, 커스텀 소스는 id), 버전, 상태 칩:
  `Install`, `Installed`, `Update 1.4.2`, `Requires Ave 0.12`, `Yanked`,
  `Installed from <다른 소스>`, `Source removed`, `Required by your organization`
  (제거·비활성화 컨트롤 없음, 툴팁이 정책 파일을 알려 줌). 카드에는 소스의
  배지도 붙습니다(§15.4).
- 두 소스에 같은 이름: 배지가 각각 붙은 카드 두 장. 행을 합치지 않습니다. 두 번째
  것을 설치하면 소스 전환이 됩니다(`PACKAGE_ID_CONFLICT`가 설명하고 전환을 제안).
  전환은 플러그인의 데이터 디렉터리를 유지하므로, 동의 문구는 새 소스의 코드가
  설치된 플러그인이 저장한 데이터를 받는다고 알려야 합니다. 앱이 git
  마켓플레이스로 옮겨 가기 전에는 서명 카탈로그가 git에 묶인 플러그인을 바꾸지
  않았습니다(설치·업데이트·롤백 모두). 사용자는 묶인 소스로 업데이트·롤백하거나
  먼저 제거했습니다.
- 부팅 설치 알림(§10.2)은 설치·업데이트한 항목을 나열하는 배너로 한 번
  나타나며, "Installed for you"(기본 설치, 제거 버튼 있음)와 "Required by your
  organization"으로 나뉩니다.

### 15.2 패키지 상세(시트)

섹션: 개요, **출처**(소스, 저장소 — 폴더 소스는 그 폴더 — , 경로, 짧은 커밋 SHA — 툴팁에 전체 SHA와 복사
버튼, 게시일), **호환성**(`minAppVersion`과 판정), **권한**(다운로드 전에
디스크립터의 authority에서), **전달**(단계 목록과 쓰일 단계. 평문 http
release나 archive에는 "암호화되지 않은 다운로드 — 고정된 sha256으로 검증"이라고
표시, 폴더 플러그인의 단계 하나는 "폴더의 빌드된 트리"), **버전**(회수·비호환 표시가 있는 이력).

소스가 허용할 수 있는 설치 실패(§14)는 *허용…*을 제시합니다. 카탈로그가 다른
사내망 호스트를 지정하면 버튼은 *사내 다운로드 허용*입니다. http에서 보류된
로그인이면 버튼 옆에 자격 증명 위험을 적습니다. 버튼은 `sources:acknowledge`를 부른
뒤 다시 계획합니다. 정책이 바뀌어 만료된 계획
(`PLAN_EXPIRED` `policy-changed`)은 새 계획을 만드는 *다시 검토*를 제시합니다.

### 15.3 설치 진행

시트 안에서: `skipped`/`failed`/`using` 단계 행과 다운로드 진행 막대, 그다음 기존
권한 검토 단계, 그다음 결과. 실패하면 모든 단계의 사유와 복사할 수 있는 진단을
보여 줍니다.

### 15.4 소스

표: 소스(라벨, URL 또는 폴더 소스의 경로, 출처 배지), 핀 커밋(툴팁이 있는 짧은
SHA — 폴더의 리비전은 `local-` 접두사를 뺌 — , 마지막 동기화 상대 시각), 패키지 수, 상태(`Up to date`, `Syncing`, `Auth required`,
`History rewritten — review`, 그 밖의 동기화 실패는 코드별 칩: 호스트에 닿지
못했을 때만 `Unreachable`, 그 외에는 `Repository not found`,
`No marketplace found`, `Branch or tag not found`, `Marketplace index invalid`,
`SSH host key not verified`, `Blocked by policy`, `Address refused`,
`Needs your confirmation`, `Git unavailable`, 폴더 소스는 `Folder not found`,
`Folder moved`, `Folder unreadable`, 다른 코드는 `Update failed`. 핀의
스냅숏을 보여 주는 동안에는 각각 `— showing cached`를 붙임),
연결할 수 없음·인증 필요 상태 아래에는 저장된 detail로 만든 실패 문장(§14),
켜기 스위치, 더보기 메뉴(Refresh, Set token, Remove). 공식·관리 행에는 Remove가
없고, 공식 스위치는 정책이 허용하지 않으면 잠겨 있고, 관리 행에는 자물쇠가
표시됩니다.

- **배지**는 행과 그 패키지 카드에 붙습니다. 색만이 아니라 텍스트 라벨과 툴팁을
  함께 씁니다.
  - 소스가 http인 동안 *암호화 안 됨(http)*;
  - 지닌 확인마다 *사내망*, *이 컴퓨터*, *사내 다운로드*.

  http 툴팁: "네트워크 경로에 있는 누구나 이 소스가 보내는 내용을 읽고 제공하는 내용을
  바꿀 수 있습니다. 이 소스의 업데이트는 자동으로 설치되지 않습니다."
- **허용…**은 마지막 동기화가 소스가 지닐 수 있는 확인 때문에 실패했을 때
  나타납니다(§14). 경고의 질문을 묻고, `sources:acknowledge`를 부른 뒤 다시
  동기화합니다. http에서 보류된 로그인(`SOURCE_AUTH_REQUIRED`
  `token-unencrypted`)이면 질문은 *토큰 설정…*처럼 `token-unencrypted` 경고
  전체, 곧 로그인 정보가 암호화되지 않은 채 전송되어 네트워크 경로의 누구나 복사할
  수 있다는 것입니다(`allowRisk`, `labels.ts`).
- **http 소스의 토큰 설정…**은 소스가 이미 `token-unencrypted`를 지니지 않았다면
  먼저 그것을 묻습니다.

### 15.5 마켓플레이스 추가 대화상자

1단계: URL 입력(`owner/repo`, 그리고 폴더 경로나 `file:` URL 허용, §7.7), 선택적
ref, 인증 라디오(None / Token / SSH). 폴더는 ref와 로그인을 받지 않고, 거부
문장이 그렇게 말합니다. 다른 컴퓨터의 폴더는 같은 확인 단계에서
`network-folder`를 묻습니다. *폴더 선택…*과 폴더를 해석한 원래 경로 표시는
슬라이스 D2입니다.
주소가 확인을 요구하면(§7.2 2단계) 트래픽 전에 확인 단계가 나옵니다. "Ave가
연결하기 전에"와 경고마다 질문 하나를 경고 톤(*취소* / *계속*)으로 보여 줍니다.
*계속*은 그 확인을 실어 다시 미리봅니다. 어느 칸이든 바꾸면 준 확인은
버려집니다. 각 답은 물었을 때의 칸에 속합니다. 칸을 고치거나, 다시 확인하거나,
대화상자를 다시 열면 아직 오는 중인 답은 버리므로, 이전 주소에 대한 늦은 경고가 새
주소에 표시되거나 확인되지 않습니다. 대화상자를 열거나 닫으면 그 답을 기다리는
상태도 끝나므로, 다시 연 대화상자는 바로 주소를 확인할 수 있습니다. 대화상자를
닫았거나 다른 주소로 다시 연 뒤에 끝난 추가는 소스 목록을 새로 고치지만, 지금 보이는
대화상자를 닫거나 패키지 시트를 열지는 않습니다.

2단계(미리보기):
- 마켓플레이스 이름, 소유자, 커밋, 종류별 개수;
- 소스의 배지;
- "N개 패키지가 이 컴퓨터에서 코드를 실행할 수 있음" 경고;
- 이 호스트에 OS 자격 증명 헬퍼가 응답할 때의 안내;
- 진단;
- id 입력.

확정 버튼: **Add marketplace**. 입력이 단일 패키지면
2단계가 직접 설치 미리보기로 바뀝니다. git이 없으면 차단 단계(§15.7)가 먼저
나옵니다.

### 15.6 업데이트 검토

커밋 범위, 버전 변화, 강조된 authority 변화(권한, 네트워크, 시크릿, 도구), 그리고
커스텀 소스라면 명시적인 체크박스가 필요한 "history rewritten" 배너.

### 15.7 Git 런타임

설정 → 마켓플레이스 → 유지 관리의 카드이자 추가 대화상자 안의 차단 단계: 감지
상태(`System git 2.50.1`, `Managed git 2.53.0`, `Not found`,
`System git 2.34.1 is too old — using managed git`), 모드 선택(Auto / System /
Managed), `smoke-testing`을 포함한 §9.2 단계 진행이 붙은
**Install Git (<크기>)**(이 플랫폼용 핀 고정 아카이브 크기, 23–66 MB), 오류와
Retry가 있는 `failed` 상태.

### 15.7.1 업데이트 카드

설정 → 마켓플레이스 → 유지 관리에서 Git 런타임 카드 위에 있는 카드(`UpdatesCard.tsx`)로,
`updates:status`를 읽은 뒤 `marketplace:update-status`를 따릅니다.

- "시작할 때와 하루에 한 번 업데이트를 확인합니다 · 마지막 확인 <시각> · 다음 확인
  <시각>"(마지막 확인은 마지막으로 성공한 탐색);
- *지금 확인*(`updates:check`), 확인 중에는 비활성;
- 마지막 결과가 `ok`가 아닐 때 그 결과: 오프라인("오프라인 — 마지막 확인 <시각>.
  네트워크가 돌아오면 다시 확인합니다."), 일부(닿지 못한 소스가 있음, 행마다 이유가 있는
  소스 화면으로 가는 *소스 보기*, §15.4), 끝내지 못한 확인; 그리고 잃어버린 `updates.json`;
- 업데이트마다 버전 변화와 상태(§18.7.5); `manual`과 `needs-review` 행에는 업데이트
  검토(§15.6)를 여는 *검토*가 있습니다. `stale` 행에는 "마지막 확인에서 소스에 연결하지
  못해 이전 확인의 상태로 표시합니다."가 붙습니다. `ok` 확인 뒤 목록이 비면 "검토할
  업데이트가 없습니다."라고 씁니다. 건너뛴 버전은 목록에서 빠지므로 "최신"이라고 하지
  않습니다;
- 스케줄러가 답하지 않으면 "지금은 업데이트를 확인할 수 없습니다. Ave를 다시 시작하고,
  계속되면 세부 정보를 복사해 알려 주세요."라고 쓰며, main의 메시지는 가린 채(scrub)
  *세부 정보 복사* 뒤에만 둡니다(§18.8).

카드는 읽기 전용입니다. 자동 업데이트 스위치와 최근 자동 업데이트는 자동 적용과 함께
옵니다(§18.9). 도구 모음 알약(`PluginUpdatesPill.tsx`)은 무엇을 받든 사용자가 필요한
업데이트만 셉니다(`updateNeedsUser`, §13.1).

### 15.8 공지

배너 컴포넌트는 그대로이고, 가져오는 오리진만 다릅니다.

### 15.9 접근성과 문구

모든 대화상자는 라벨이 붙은 단계와 함께 포커스를 가둡니다. 소스 배지는 색만이
아니라 텍스트 라벨을 가집니다. SHA는 고정폭 글꼴과 전체 값 툴팁을 씁니다. 상태
칩은 기존 토큰 색을 씁니다. 새 문구는 생성기를 통해 i18n 카탈로그에 추가하며,
원시 키를 노출하지 않습니다.

## 16. 이관과 처분

### 16.1 서버 기능

| 지금(서버) | 이후 |
|---|---|
| `GET /api/v1/catalog`, `/plugins/{slug}` | 소스 스냅숏 |
| `…/download`, `…/download.sig` + `prod-v1` | 사다리 단계 + git 안의 sha256 핀 |
| `POST /plugins/{slug}/versions` + 승인 큐 | PR + 머지(D8) |
| yank / unyank / rollback | `versions[].yanked`, `policy/revocations.json`, 새 버전 |
| 카나리 롤아웃 비율, `channel: "canary"` | `versions[].rollout.percent` + 로컬 버킷, 프리릴리스는 `canaryOptIn` 뒤 |
| `min_app_version` 열 | 디스크립터의 `minAppVersion`과 플러그인 매니페스트의 `requires.minAppVersion` |
| 관리(`installPolicy: "admin"`) 카탈로그 행 | 앱의 `DEFAULT_INSTALLS`, 정책 `defaultInstalls`, 정책 `requiredInstalls`(§10.2) |
| 사내 공개 범위(CIDR) | 사내 관리 또는 커스텀 마켓플레이스 |
| 조직 허용 플래그 | 관리 정책 `marketplaces.allow` |
| 공지 | 서비스 엔드포인트 |
| 텔레메트리 `/telemetry/events`, `register-device` | 서비스 문서의 `telemetry`(수집기가 생길 때까지 null) |
| DLP 적중 보고, API 키, `/me`, 게시자 라우트 | 서버와 함께 제거 |
| 서명된 화이트리스트 grant | 앱의 `HOST_SECRET_GRANTS`(§10.3) |
| 서명된 admission / revocation 피드 | §6 해석, 소스별 `policy/revocations.json` |

### 16.2 앱 코드와 설정

| 항목 | 처분 |
|---|---|
| `cloud-marketplace-fetcher.ts` | 삭제. 사설망 가드는 공용 §7.4 게이트로 이동 |
| `LocalCatalogMarketplaceFetcher`, `DisabledMarketplaceFetcher`(`marketplace.ts`) | 삭제. 개발 빌드는 개발 플래그 아래 로컬 디렉터리를 direct 소스로 등록 |
| `marketplace-fetcher.ts` 인터페이스 | 통합 카탈로그 뷰로 대체 |
| `marketplace-installer.ts` | 서버 다운로드와 `.sig` 처리 삭제. zip 한도와 엔트리 검사는 release/archive 단계용으로 유지 |
| `envelope-verifier.ts`, `marketplace-keys.ts`, `publisher-keys.ts`, `signed-doc-fetcher.ts`, `signed-doc-cache.ts` | 삭제. `plugin-artifact-store.ts`와 `mcp-setup.ts`는 공개 키를 받지 않음 |
| `admission/` | 삭제(설치 승인은 §6 해석) |
| `whitelist/` | 전송과 레지스트리 삭제. `canonical-json.ts`와 `secret-gate.ts`는 grant 표와 함께 `src/plugins/secret-access/`로 이동 |
| `revocation/` | 전송 삭제. `revocationRegistry`는 스냅숏에서 공급 |
| `src/boot/steps/{admission,whitelist,revocation}-bootstrap.ts` | 스냅숏에서 폐기를 공급하는 단계 하나로 대체 |
| `src/boot/managed-marketplace.ts`, `ensureManagedInstalled`, 관리 액터 승격, 목록 제외 admin 제거 | 부팅 설치 단계(§10.2)로 대체 |
| `update-condition.ts` 관리 종류, `runtime/index.ts` `isManaged`, 렌더러 `installPolicy` 타입 | 제거. 필수 설치는 자체 부팅 단계 사용 |
| `deployment-guard.ts` admin 분기 | 제거·비활성화의 `requiredInstalls` 검사로 대체 |
| `secret-gate.ts` admin 우회, host-api-factory `admin-bypass` 감사 경로, `normalizeInstallPolicy` | 삭제 |
| `mcp-marketplace-install.ts`(`readRuntimeFromVerifiedZip`) | `resolve/mcp.ts`로 대체 |
| `offline-cache.ts` | 스냅숏과 보존 아티팩트로 대체. `offlineCacheEnabled`는 "내려받은 아티팩트 보관"을 뜻함 |
| `update-detector.ts`, `update-condition.ts` | 유지, 스냅숏에 다시 연결 |
| `dependency-resolver.ts` | 유지. 디스크립터의 authority로 실행(§6.2) |
| 설정 `backend`, `cloudBaseUrl`, `cloudAllowPrivateNetwork` | 설정 이관으로 제거 |
| 설정 `updateCheckEnabled`, `updateCheckIntervalMs`, `canaryOptIn`, `skippedPluginUpdates`, `dismissedAnnouncementIds` | 위 의미로 유지 |
| 설정 `installedThemeBundleIds`, `installedLanguagePacks`, `installedProviderPresets`, `installedProviderIds` | 원장(ledger) 항목으로 변환 |
| `moonstone`, `gallery` 밖의 컴파일된 테마 번들 14개(`theme/bundles/*.ts`, `styles.css` 블록, `MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS`) | 제거. 공식 테마 패키지가 같은 id를 가짐 |
| 벤더 id `nousResearch`, `v0` | 공급자 패키지 이름이 벤더 id이므로 `nous-research`, `vercel-v0`로 바꾸고 설정·시크릿을 한 번 이관 |
| 시크릿 `marketplace.apiKey`와 그 IPC(`ipc/domains/settings.ts`) | 삭제. 텔레메트리도 더는 읽지 않음 |
| IPC `ave:plugins:marketplace:list`, `ave:plugins:install`, `ave:plugins:rollback` | `catalog:list`와 `install:plan/execute`로 대체. 롤백 = 목록의 이전 버전 설치 |
| IPC `ave:marketplace:ping` | `sources:refresh` 결과로 대체 |
| IPC `ave:mcp:catalog:list`, `ave:mcp:install-from-marketplace`, `ave:agents:install`, `ave:skills:install` | 종류로 거른 `catalog:list`와 `install:*`로 대체 |
| IPC `ave:plugins:install-local`, MCP 폼, 데스크톱 설정 가져오기 | 유지 |
| 딥링크 `ave://install/<type>/<slug>`, `ave://uninstall/<type>/<slug>` | `ave://install/<kind>/<name>@<source>`, `ave://uninstall/<kind>/<name>@<source>`로 변경. 둘 다 확인 UI를 엶 |
| `.github/workflows/marketplace-e2e.yml` | 전환과 같은 변경에서 로컬 git 픽스처를 쓰는 저장소 내 E2E로 대체 |
| `resources/AGENTS.md`(최신 버전 출처로서의 "marketplace API") | 설치된 소스의 스냅숏을 가리키도록 변경 |
| `web/app/docs/servers/marketplace/*` | 서버 관리자·게시자 페이지 제거, git 마켓플레이스용 패키지 작성자 페이지로 대체 |
| `docs/architecture/architecture.md`, 플러그인 개발·게시 가이드, `docs/ko/references/plugin-tool-schema-design.md`, `docs/ko/architecture/architecture.md`와 `docs/ko/guides/plugin-development.md`의 `installPolicy: "admin"` 예시 | 새 모델에 맞게 다시 씀 |

### 16.3 기존 설치본

새 버전의 첫 부팅 때:

- id가 공식 스냅숏에 있는 레지스트리 항목은 `rung: "legacy"`,
  `artifactSha256: null`로 `ave`에 묶입니다. 다음 업데이트가 사다리로 설치하면서
  출처를 채웁니다. 이관은 아무것도 다시 설치하지 않으며 오프라인에서도 동작합니다.
  이 설치본의 매니페스트에는 아직 `installPolicy`가 있고, 로더는 경고 한 번과 함께
  무시합니다(§5.3).
- grant 연속성: `legacy` 항목은 설치 영수증의 `artifactSha256`이 설치된 버전에
  대한 공식 인덱스의 `artifact.release.sha256`과 같으면 호스트 시크릿 grant를
  유지합니다(§10.3 조건 2). 그래서 공식 인덱스는 현장에 아직 설치되어 있는 grant
  대상 플러그인의 모든 버전에 대해 `versions[]` 항목을 가지며, 각 버전마다 현재
  서버가 제공하는 zip을 그대로 그 버전의 릴리스 자산으로 올리고 그 sha256으로
  공식 저장소를 채울 때 핀합니다. "모든 버전"은 앱이 불러올 수 있는 버전을 뜻합니다.
  Agent Plugins 매니페스트 이전 릴리스(`minAppVersion` 0.7.0 아래 라인으로,
  `plugin.json`에 `extensions["ai.agent-connector.ave"]`가 없음)는 전환 전후 모두
  `parsePluginJson`에서 실패하므로 지킬 grant가 없고 핀하지 않습니다. 맞는 핀이
  없는 항목은 업데이트할 때까지 grant를 잃고, 부팅 알림이 어느 플러그인이 어느
  키를 잃었는지 알려 줍니다.
- `installSource: "admin"`은 `user`가 되고, 그 패키지들의 키는
  `packages/default-installs.json`에 이미 적용된 것으로 기록되므로 다시 설치하거나
  제거하지 않습니다.
- 어떤 공식 패키지와도 맞지 않는 항목(지금은 사내 `orion` 플러그인)은 "출처 모름 —
  업데이트 없음"으로 계속 실행되고, grant를 받지 않으며, 더는 잠기지 않습니다.
  조직이 사내 마켓플레이스를 등록하고(`additional`) `requiredInstalls`에 올릴
  때까지 그렇게 남고, 그다음 부팅에서 그 소스에 묶입니다. 부팅 알림은 이 항목들을
  한 번 알립니다: "<name> is no longer managed by Ave. Your organization can
  keep it up to date by registering its marketplace."
- 설치된 공급자 프리셋과 테마·언어 활성화는 원장 항목이 됩니다.

### 16.4 구현 결과

위 절들과 출시된 코드가 다르면 코드가 기준입니다.

- **잠금은 소스를 가리킵니다(§10.2).** `requiredInstalls` 항목은 그 항목이 가리키는
  소스에서 설치된 패키지만 잠급니다. 같은 종류·이름이라도 다른 소스에 묶였거나 어느
  소스에도 묶이지 않은 패키지는 제거하고 끌 수 있습니다. 플러그인 탭
  (`PluginDeploymentGuard`)과 마켓플레이스 제거가 같은 규칙을 쓰고, 확인할 때마다
  정책 파일을 읽습니다. 읽을 수 없는 정책 파일은 아무것도 잠그지 않습니다. 배포
  가드에는 더 이상 행위자 모델이 없고 관리자 설치도 없습니다. 첫 부팅이
  `installSource: "admin"`을 `user`로 바꾸므로(§16.3), 패키지가 다른 소스에 묶인
  것을 본 필수 설치는 평범한 소스 전환을 합니다.
- **폐기된 매니페스트 필드(§5.3).** 로더는 스키마 검증 전에 `installPolicy`와
  `publisher`를 모두 떼고 플러그인마다 경고를 한 번 남깁니다. git 스테이징과 저장소
  검사는 둘 중 하나라도 있는 매니페스트를 필드 이름을 밝혀 거부합니다.
- **폐기 목록(§10.4)** 은 부팅 때만이 아니라 백그라운드 동기화가 끝날 때마다
  적용합니다. 폐기된 설치는 세션마다 한 번 알립니다. 설치 중인 패키지는 설치하려는
  소스 아래로 레지스트리에 넘기므로, 소스를 바꿔도 옛 소스의 폐기 목록이나 빈 목록으로
  판정받는 순간이 없습니다. 고정된 스냅숏 파일이 사라졌으면 빈 목록이 아니라
  오류입니다.
- **`update-condition.ts`** 는 관리형 업데이트 종류만 담고 있어 삭제했습니다.
  `update-detector.ts`는 남습니다.
- **개발 중의 로컬 마켓플레이스(§16.2).** 패키징하지 않은 빌드를 `AVE_DEV=1`로
  띄우면 루프백의 평문 HTTP 마켓플레이스에 닿을 수 있습니다. 작성자의 체크아웃을
  `git http-backend`로 서비스하거나 E2E 테스트의 픽스처가 그 예입니다. file
  프로토콜은 계속 거부하므로, 로컬 디렉터리는 직접 소스로 등록하지 않고 루프백으로
  서비스합니다.
- **E2E 테스트(§17).** `test/e2e/ui/git-marketplace-lifecycle.spec.ts`가
  `marketplace-e2e.yml`을 대신하며, 야간 `e2e.yml`에서 다른 Playwright 스펙과 함께
  돕니다. 마켓플레이스 MCP 서버를 구성할 수 있는지는 여전히 MCP 거버넌스가
  정하므로(§13, `PACKAGE_POLICY_BLOCKED`), 스펙은 조직이 하듯 실행의 `AVE_HOME`에
  그 서버를 승인하는 거버넌스 정책을 씁니다.
- **서버 스택과 함께 지운 것(§16.2 외):** Doctor의 서버 설치 정리 동작, 합성 설치
  실패 카드, `plugins.installProgress` 채널(보내는 곳이 없었음), 렌더링되지 않던
  플러그인 그리드와 웹 스토어 링크, 서버 시절의 아티팩트 저장소. 부팅은 그 스택이
  디스크에 남긴 것을 지웁니다. 입장·화이트리스트·폐기 문서, 카탈로그 캐시, 각 패키지
  트리의 tarball 캐시와 검증된 다운로드입니다. `AVE_ADMISSION_OFFLINE`은 다른 폐기
  변수처럼 환경에서 지웁니다.
- **첫 부팅 마이그레이션(§16.3)** 은 공식 소스의 스냅숏이 생긴 뒤에 돌고,
  `packages/legacy-migration.json`에 기록합니다. 모든 항목을 옮기면
  `{ version: 1, completedAt }`, 아니면 `{ version: 1, reportedUnmanaged }`를 쓰고,
  다음 실행이 다시 시도하되 관리되지 않는 항목을 두 번 알리지 않습니다.
- **앱 버전 사이의 언어 키.** 업그레이드 실행에서, 카탈로그의 키가 줄어든
  빌드(전환에서 157개를 지움)의 첫 부팅 때 설치된 언어가 모두 깨지는 것을
  찾았습니다. 인터페이스 집합 밖의 키는 이제 기기에서 무시하고 저장소 검사만
  거부합니다(§5.5).
- **웹 문서.** 사이트의 서버 마켓플레이스 페이지와 스크린샷 12장을 지웠습니다.
  `/docs/marketplace`가 소스·설치·업데이트를, `/docs/marketplace/authors`가 패키지
  작성자 안내를 맡습니다(한국어와 영어). 마켓플레이스 계정, slug 설치 딥링크, 퍼블리셔
  서명을 설명하던 페이지는 git 마켓플레이스를 설명하도록 고쳤습니다.

## 17. 테스트 계획

§18 슬라이스의 테스트는 §18.10의 슬라이스마다 적었습니다.

| 계층 | 무엇으로 증명하는가 |
|---|---|
| 스키마 | 모든 종류의 픽스처 세트: 정상, 규칙별 위반, 알 수 없는 키. `installPolicy`가 있는 매니페스트는 설치와 인덱스 CI에서 필드 이름과 함께 거부, 필드가 있는 legacy 설치본은 경고 한 번과 함께 로드 |
| 버전 선택 | `minAppVersion`, 회수, 플랫폼, 프리릴리스 옵트인, 롤아웃 버킷, 소스별 폐기 표 테스트 |
| 사다리 | 단계별 사용/건너뜀/실패 조합, authority 필드 하나라도 불일치하면 사다리 중단, 계획이 커밋에 묶임, 영수증에 단계 결과 기록 |
| Git 런타임 | 버전 게이트용 가짜 `git` 바이너리(2.45.0 거부, 2.45.1 허용), 환경/플래그/전역 설정 계약, askpass 티켓의 호스트 바인딩, 로컬 픽스처 서버를 쓴 관리형 설치와 잘못된 해시 거부 |
| 업데이트 스케줄러 | 가짜 시간(`background.test.ts`): 오프라인 탐색은 간격 뒤가 아니라 한 시간 뒤 재시도; 최근 성공 뒤 오프라인 *지금 확인*도 한 시간 뒤 재시도; 성공은 간격 동안 반복하지 않음; 적용 확인은 부팅 때와 마지막 확인 24시간 뒤; 정확히 24시간 경계에서도, 탐색과 위상이 어긋나도 적용 확인은 분류 전에 탐색; 기한이 된 적용 확인은 진행 중인 탐색에 합류하고, 그 탐색이 `partial`이면 닿은 소스만 분류하고 기한이 남음; 시계가 30시간 뛴 뒤 `resume`이 탐색을 실행; *지금 확인*은 탐색과 분류가 끝날 때 답함; 절전을 넘긴 성공한 확인은 끝난 시각으로 기록; 닿은 소스만 게시하고 닿지 않은 소스의 업데이트는 이전 탐색이 보인 그대로 `stale`로만, 상태와 `updates-available` 이벤트 모두에서; 예외를 던진 탐색은 보이던 것을 `stale`로 바꾸고 그 뒤 캐시된 것은 분류하지 않음; 부팅 패스·recheck·*지금 확인*·기한이 된 적용 확인의 어느 기다림에서 멈추든(그 기다림이 성공하든 거부되든) 더는 게시·기록·로그·새 작업·타이머가 없음(모든 기다림을 도는 표 하나; `service.test.ts`는 실제 서비스의 동기화와 집행에서, 그리고 실제 동기화기와 설치기의 정리(prune)와 부팅 콘텐츠 설치에서 붙잡고 같은 표를 돌려 더 이상의 진행·단계·게시·기록·경계를 지나는 어떤 이벤트도 없고 설치와 그 기록은 끝남을 확인; 다른 집행 뒤에 줄 선 집행은 신호가 중단되면 취소됨), 읽기가 끝나기 전에 멈추면 읽을 수 없는 파일은 그대로 두고 알리지도 않음; `git-marketplace.test.ts`: 멈춘 뒤 다시 시도와 지금 확인은 선언된 거부 응답으로 답하고, 종료 hook 뒤에 끝난 플러그인 설치는 `plugin.installed`나 브리지 새로 고침 없이 끝남; `git-runtime.test.ts`: 런타임 진행은 마켓플레이스 종료 hook에서 멈춤; `ave-deep-link.test.ts`: 수명이 끝나면 마켓플레이스 링크는 거부됨; 읽을 수 없는 `updates.json`은 `historyReset`을 켬. `history.test.ts`: 파일의 엄격한 모양과 기한 규칙. `service.test.ts`: `ok`, `partial`, `offline`, 그리고 망가진 소스와 나머지 모두 오프라인이면 `partial`. `PluginUpdatesPill.test.tsx`: 사용자가 필요한 상태만 셈. `GitMarketplaceTab.test.tsx`: 카드의 상태, "검토할 업데이트가 없습니다", `stale` 행, 답하지 않는 스케줄러를 자체 문장으로 쓰고 main의 메시지는 *세부 정보 복사* 뒤에만 |
| 동기화 | 로컬 bare 저장소: 핀이 팁보다 한참 뒤인 fast-forward, 재작성(공식·관리는 거부, 커스텀은 검토), 잘못된 인덱스는 핀 유지, 미러 대체, 설치 패키지가 있는 숨긴 소스도 동기화 |
| 네트워크 게이트 | 정규화 동치(scp/ssh/https, 대소문자, `.git`). `<helper>::` 전송과 URL 안의 자격 증명 거부. block이 allow보다 우선. `requireHttps`와 `blockPrivateNetworks`가 확인한 소스도 차단. 입력한 대상과 카탈로그가 지정한 대상의 주소 분류별 결과(`198.18.0.0/15`는 사내망, 등록된 호스트라도 메타데이터 거부, 다른 포트의 루프백 다운로드 거부, `internal-network`가 `internal-downloads`를 함축하지 않음, 등록이 `token-unencrypted`를 함축하지 않음). 차단된 호스트로의 리다이렉트 거부. 호스트 간 인증 헤더 없음 |
| 연결 묶기(§7.4) | `pinned-fetch.test.ts`가 실제 로컬 서버로: 홉마다 조회 한 번, 검사한 답에만 연결, 메타데이터 답은 버림, PAC 종류별(`PROXY`의 http·https 대상, `HTTPS`, `SOCKS5`, `SOCKS4`, 모르는 종류는 `proxy`로 실패), `DIRECT`로 물러나지 않음, 메타데이터·라우팅 불가 리터럴 프록시는 조회 없이 거부, 이름에 대한 인증서 검사, TLS 연결마다(대상과 `HTTPS` 프록시) 검증과 호스트 이름을 직접 요청, 평문 http 요청에는 TLS 연결 없음. `network-gate.test.ts`: https 요청과 같은 호스트라도 http 홉에는 로그인 정보를 싣지 않음. `trusted-proxy.test.ts`가 프록시 경계를 고정. `run-git.test.ts`: 리터럴 프록시는 git 시작 전 거부(IPv4, IPv6, 매핑, NAT64), 호출마다 PAC 답 하나로 설정과 묶기가 같은 경로, `http.curloptResolve` 고정, 거부된 답만 남으면 git을 시작하지 않음, `token-unencrypted` 없는 http에는 자격 증명 없음(등록된 호스트의 저장 토큰 포함), 그리고 게이트 판정부터 끝까지: http 소스는 조회 전에 묻고, `unencrypted`가 있어야 검사한 주소로만 닿으며, `token-unencrypted`까지 있어야 로그인함. `ssh-preflight.test.ts`: git 전 사전 검사, 거부된 답 하나라도 실패, `proxyjump` 뒤에서는 조회 없음, 명시한 남는 위험 |
| 확인과 정책 갱신 | `service.test.ts`: 확인이 필요한 미리보기는 git 명령도 조회도 없이 `confirm`으로 답함. *추가*는 실은 확인을 그대로 저장. 조회가 사내망 주소를 찾은 호스트는 묻고, *허용…*이 동기화함. 정책 파일을 다시 쓰면 다음 미리보기가 막히고 기존 계획이 `policy-changed`로 만료. 무효 파일 다음 고친 파일이면 공식만 썼다가 되돌아옴. 갱신마다 다음 작업과 겹쳐도 모든 작업이 디스크의 정책 아래에서 돎(엄격하면 git 사전 검사 없음). 형식이 잘못되었거나 읽을 수 없는 파일이면 모두 닫힌 쪽으로 실패하고 경고는 한 번. 파일이 다시 엄격해진 뒤 시작한 작업은 이전 갱신이 허용으로 읽었어도 엄격하게 돎. 계속 도착하는 작업도 줄 선 갱신 하나 안에서 변경을 봄. 카탈로그 변경이 시작한 업데이트 확인과 작업이 끝난 뒤 남아 도는 일은 그사이 바뀐 정책을 읽음. 동기화가 아직 열려 있는 동안 게시한 스냅숏이 요청한 실제 스케줄러의 업데이트 확인은 스스로 정책을 갱신하고, 그사이 정책이 뺀 소스의 업데이트를 내놓지 않음. `background.test.ts`: 스케줄러의 모든 진입은 호출자의 비동기 컨텍스트 밖에서 돎. `alert-predecessor.test.ts`: 한쪽이 플러그인 잠금을 쥐고 다른 쪽이 그 잠금을 기다리는 동안 정책이 바뀌어도 이전 플러그인 제거와 설치가 모두 끝남(실제 잠금, 시간 제한). `policy.test.ts`: 크기·수정 시각이 같은 재작성과 권한 변경을 알아챔, http `additional` 소스는 그 자체가 등록. `registry.test.ts`: 관리 항목이나 `sources.json`이 소스를 다른 주소로 가리키면 확인을 버림. `network-gate.test.ts`: `127.0.0.1`을 등록해도 다른 카탈로그가 다른 로컬 포트에 닿지 못함. UI: 칸을 고친 뒤 늦게 온 미리보기 답은 버림, 확인 중에 닫았다 다시 연 대화상자는 바로 확인할 수 있음, 이전 추가가 끝나도 다른 주소로 다시 연 대화상자는 그대로이고 목록만 새로 고침, http 로그인 *허용…*은 자격 증명 위험을 말함 |
| 특권 없음 | grant 대상과 같은 이름의 커스텀 패키지는 grant 없음, 다른 아티팩트 해시·tree 단계 설치·바뀐 매니페스트면 grant 실패, legacy 항목은 영수증 해시가 맞을 때만 grant 유지, 한 소스의 폐기는 다른 소스 패키지를 무시, 어떤 패키지도 자기 제거를 막지 못함, `installPolicy`가 있는 매니페스트는 설치에서 거부 |
| 기본·필수 설치 | 기본: 사다리로 한 번 설치, 제거 후 재설치 없음. 필수: 부팅 때 재설치·업데이트, 제거·비활성화는 `PACKAGE_REQUIRED_BY_POLICY`로 거부, 항목을 빼면 사용자 설치가 됨. 두 목록 모두 공식·관리 소스로 제한. 이관은 이전 admin 설치를 적용됨으로 기록하고 맞지 않는 항목의 잠금을 해제 |
| 식별 | 예약 이름, 소스 간 같은 `(kind, name)`, `PACKAGE_ID_CONFLICT`, 업데이트 바인딩, 소스 전환 시 플러그인 데이터 유지 |
| 직접 설치 | 감지 분기별, npm/pypi/oci/remote에 대한 `server.json` 대응. `folder-direct.test.ts`: 직접 폴더의 합성 `0.0.0+t…` 버전이 파일과 함께 바뀜, `allowDirectInstall: false`가 미리보기(마켓플레이스 폴더는 여전히 미리보기 됨)·추가·계획에서 거부 |
| 로컬 폴더(§7.7) | `source-input.test.ts`를 `path.posix`와 `path.win32` 규칙으로: 받아들이는 폴더 형태는 모두 정규화되고 거부하는 형태는 모두 사유를 밝히며, `a/b`는 GitHub 약식으로 남음. 모든 호출을 기록하는 `fixtures/folder-fs.ts`의 볼륨으로: `folder-consent.test.ts` — UNC 경로는 호출 없이, 공유에 매핑된 드라이브는 `queryDosDevice`만으로 `confirm`을 답함, 같은 입력이 `allowLocalSources: false`에서 호출 없이 차단됨, 확인한 폴더는 읽기 도구 자신의 호출로만 읽힘(`realpath` 없음), `/tmp → private/tmp`와 그 자체가 링크인 루트가 해석됨, `\\attacker\share`로 가는 상위 링크는 그곳에 호출 없이 `link-to-network`, 정규 경로에서만 보이는 차단은 파일을 열기 전에 미리보기를 끝냄, Windows 8.3 짧은 이름은 긴 이름으로 표기됨. `folder-real-fs.test.ts` — 이 컴퓨터의 실제 파일 시스템에서(macOS와 Windows에서 실행): 네트워크 경로는 호출 전에 답함, 안쪽 링크(Windows는 정션)는 읽고 폴더를 벗어나는 링크는 읽지 않고 거부, 두 번 닿는 디렉터리는 고리, 볼륨 자신의 대소문자 규칙. `folder-tree.test.ts` — 안쪽 링크는 파일로 읽힘, 바깥 링크와 공유로 가는 링크 사슬·정션은 대상에 호출 없이 텍스트에서 멈춤, 매핑으로 판정한 네트워크 드라이브, 고리, `fstat` 불일치, 그대로 남은 상위 교체(`changed-during-read`, 바깥 바이트는 패키지에 없음)와 재확인 전에 되돌린 교체라는 잔여 위험, 건너뛰는 목록, NFD/NFC와 충돌, 특수 파일, 플러그인에서 빠진 항목. `folder-identity.test.ts` — 대소문자 구분 볼륨은 두 철자를 두 소스로 둠, `allow` `path:`는 그 철자만, `block`은 모든 철자, 대소문자 무시 볼륨과 별칭 디렉터리는 디스크 철자와 `dev`/`ino`로 한 소스, 중첩 거부. `folder-sync.test.ts` — `SKILL.md`를 고치면 리비전이 바뀜, git 명령과 다운로드 없음, 폴더의 버전만 제공, 백그라운드 `permission` 실패가 다시 불러온 뒤에도 이유를 지니고 표시됨, 이제 다른 곳을 가리키는 저장 경로는 대상을 읽지 않고 `moved`. `folder-plan.test.ts` — 계획과 실행 사이에 고친 플러그인 파일과 `SKILL.md`는 계획한 바이트로 설치됨, 선언한 릴리스를 내려받지 않음, 실행 비트 유지, `process` 진입점은 `process-entry-requires-pinned-artifact`로 거부, `plugin.json` 없는 폴더는 `folder-has-no-build`, 사본은 지워짐. `plugin-ladder.test.ts` — `src/`가 있는 git 트리는 여전히 tree 단계에서 실패. `policy.test.ts` — `allowLocalSources`, `path:` 없는 `allow` 목록, `path:` 접두사와 Windows 철자, `path:`와 git 패턴의 분리, `additional[].path`와 그 거부. `registry.test.ts` — 폴더 항목과 식별자의 왕복, 경로에 묶인 확인, 전송과 짝지은 핀, `network-folder`를 지닌 관리 폴더. `windows-path-kind-launcher.test.ts`, 그리고 Windows에서 `scripts/test-windows-path-kind.mjs`(CI 단계 *Verify Windows folder classification*): `C:`는 볼륨으로, `subst` 드라이브(그리고 그 `subst`)는 대상으로, 쓰지 않거나 지운 드라이브는 닫힌 쪽으로 실패 |
| 서비스 | `former-service.json` 파싱, `movedFrom` 있을 때와 없을 때의 `movedTo`, 빌드 상수 변경 시 초기화, 정책 우선, 공지 동등성, 라벨 대체 |
| E2E | 패키징된 개발 빌드(개발 플래그로 루프백 허용)에서 로컬 HTTP git 마켓플레이스를 추가하고, 종류별로 하나씩 설치하고, 업데이트하고, 소스를 제거. 개발 플래그 없이는 같은 종류의 소스가 픽스처 서버가 요청을 받기 전에 `unencrypted`와 `this-computer`를 묻고, 미리보기·카드·소스 행이 배지를 보임 |

## 18. 소스 수용, 로컬 폴더, 자동 업데이트 (0.13.0 이후)

> 상태: 2026-10-01에 처음엔 앱 릴리스 0.13.0을 위해 **설계됨**. 0.13.0은
> 슬라이스 B만 담아 출시됐고, 슬라이스 C와 E는 다음 릴리스에, 그 뒤 슬라이스는 더
> 나중에 들어갑니다. 이 절이 0.13.0이라고 말하는 곳은 그 슬라이스를 담는 릴리스로
> 읽으세요.
> - 슬라이스 B(메시지), 슬라이스 C(대상 분류, 경고, 연결 묶기), 슬라이스 E(탐색과
>   상태), 슬라이스 D1(폴더 소스: 엔진과 동의)은 구현됐습니다. §7, §12–§15, §17이
>   구현된 모습을 설명합니다. §18.2, §18.3 #1–4와 #7, §18.5의 분류·결과·묶기는
>   §7.4가, §18.6의 `requireHttps`, `blockPrivateNetworks`, 정책 갱신은 §12가,
>   §18.7.1과 §18.9의 업데이트 스케줄러, `updates.json`, 업데이트 카드는 §7.3과
>   §15.7.1이, §18.3 #5–6, §18.4, §18.6의 폴더 키는 §7.7, §8, §12, §13.1, §14,
>   §15가 맡습니다.
> - 나머지(폴더 대화상자와 표시, 자동 적용과 그 설정이 정하는 것, 슬라이스 D2와
>   F)는 구현 전입니다. 이 절과 앞 절이 다르면 앞 절은 빌드를, 이 절은 목표를 설명합니다.
> - §18.10의 각 슬라이스가 같은 변경에서 해당 절을 고쳐 쓰고 이 절을 가리키는
>   문구를 지웁니다. 코드는 `e10c823e2` 기준으로 인용합니다.

### 18.1 소유자 결정 (2026-09-28, 확정)

1. 평문 `http://` git 소스와 로컬 폴더를 마켓플레이스로도, 단일 패키지로도
   받습니다. 마켓플레이스를 올리는 평범한 방법 때문에 사용자가 "왜 안 되지?"를
   묻게 두지 않습니다.
2. 주소 가드는 거부 대신 경고합니다. 사용자가 어떤 결정을 해도 안전해지지 않는
   대상만 거부로 남습니다(§18.3).
3. 설치한 패키지는 자동으로 업데이트합니다. 앱은 부팅 때와 하루 한 번 업데이트를
   확인합니다.
4. 동의는 우회하지 않습니다: 실행하는 것이나 접근 범위를 바꾸는 업데이트는 사용자를
   기다립니다.
5. 관리자는 관리 정책으로 엄격한 동작을 유지합니다(§18.6).

### 18.2 결과, 그리고 대상을 누가 골랐는가

> git과 다운로드에 대해 슬라이스 C에서 구현됐고, §7.4가 구현된 모습을
> 설명합니다. `network-folder`는 슬라이스 D1에서 구현됐고(§7.7),
> `unencrypted-updates`는 슬라이스 F의 몫입니다.

| 결과 | 의미 | 바꿀 수 있는 주체 | UI 톤 |
|---|---|---|---|
| **수용** | 진행 | — | 없음 |
| **경고** | 한 번 확인한 뒤 진행. 확인은 소스에 저장되고, 적용되는 동안 배지로 보임(§18.5) | 사용자 | 주황; *계속* / *취소* |
| **거부** | 절대 하지 않음; 확인 경로 없음(§18.3) | 앱 릴리스 | 빨강; *계속* 없음 |
| **정책 차단** | 시스템 정책 파일이 금지(§18.6) | 관리자 | 자물쇠 아이콘, "조직에서 설정함"; *계속* 없음 |

- **입력한** 대상: 사용자가 입력하거나 붙여 넣거나 고른 것(추가 대화상자,
  *Git URL이나 폴더에서 설치…*, 대화상자에 표시된 뒤의 딥 링크), 그리고 공식 소스의
  빌드 상수와 관리 소스의 정책 항목.
- **카탈로그가 지정한** 대상: 마켓플레이스 파일이 지정한 것 — `artifact.release.url`,
  `artifact.archive.url`, §6.2의 파생 릴리스 URL — 과 다운로드의 모든 리다이렉트 홉.
  제3자가 썼고, 사용자는 요청 전에 보지 못합니다.

#### 18.2.1 주소 분류

새 함수 `classifyAddress(address)`를 `src/core/network-guard.ts`의
`isGloballyRoutableAddress`(`:257`) 옆에서 내보내 각 주소를 분류합니다. 여러 주소로
해석되는 이름은 경고에 대해서는 가장 엄격한 분류를 따르고, 어느 응답에 연결해도
되는지는 §18.2.4의 규칙을 따릅니다. IPv4 매핑 IPv6와 NAT64(`64:ff9b::/96`)는 지금처럼
안에 담긴 IPv4 주소의 분류를 따릅니다.

| 분류 | 주소 |
|---|---|
| `public` | `isGloballyRoutableAddress`가 참 |
| `internal` | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`, `100.64.0.0/10`, `198.18.0.0/15`(fake-IP 프록시 도구가 모든 이름을 이 범위로 응답) — 아래 두 메타데이터 주소 제외 |
| `this-computer` | `127.0.0.0/8`, `::1`, `0.0.0.0/8`, `::` |
| `metadata` | `169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`, `100.100.100.200` |
| `unroutable` | `network-guard.ts:116-150`의 나머지 특수 용도 범위(문서용, 멀티캐스트, 예약, 브로드캐스트, 프로토콜 할당) |

구현에서는 별도의 `fetchAddressCheckedResponse(url, { addressPolicy, fetchImpl })`가
세 개의 `allow*` 축 대신 `addressPolicy(address, hop) => "allow" | NetworkGuardError`를
받습니다. 리다이렉트 반복은 `fetchPublicHttpResponse`와 공유하고, 그 시그니처는
바뀌지 않습니다. 마켓플레이스 게이트만 이것을 부르고, 다른 호출자는 지금 동작을
유지합니다.

#### 18.2.2 입력한 대상

| 대상 | 결과 |
|---|---|
| `https`나 `ssh`, `public` | 수용 |
| `internal` | 경고 `internal-network` |
| `this-computer` | 경고 `this-computer` |
| 스킴 `http` | 주소 분류에 더해 경고 `unencrypted` |
| 토큰 로그인이 있거나, 그 호스트에 응답하는 OS 자격 증명 헬퍼가 있는 `http`(§9.3) | 추가로 경고 `token-unencrypted` |
| 네트워크 폴더(§18.4.1 3단계) | 경고 `network-folder` |
| `metadata`, `unroutable` | 거부(§18.3) |

- 정책에 등재된 호스트(`allowHttpHosts`, `allow` 패턴, `additional` 소스; §12)는
  `unencrypted`, `internal-network`, `this-computer` 경고 없이 받습니다. `metadata`는
  §12대로 그 호스트에도 거부합니다. **`token-unencrypted`는 등재로 생기지 않습니다**:
  정책은 전송 방식을 허락할 뿐, 사용자의 자격 증명을 그 위로 보내는 것까지 허락하지
  않습니다.
- `AVE_DEV=1`로 시작한 패키징 전 빌드는 `this-computer`와 그곳으로의 평문 http를
  경고 없이 받으므로(§16.4) E2E 픽스처는 소스 자체에 대한 확인이 필요 없습니다.
  `unencrypted-updates`(§18.7.2)는 면제하지 않습니다.
- **http 위 자격 증명**: 관리 소스를 포함한 모든 출처에 같은 규칙입니다.
  - askpass(§9.3)는 소스가 `token-unencrypted`를 가질 때만 `http` 원격에 응답합니다.
  - 그것이 없는 `http` 원격의 모든 호출은 `-c credential.helper=`를 달아, OS 헬퍼가
    저장된 비밀번호를 평문으로 보내지 않게 합니다.
  - 그것이 없는 http 소스의 저장된 토큰은 쓰지 않습니다. 동기화는
    `SOURCE_AUTH_REQUIRED` 사유 `token-unencrypted`로 실패하고, 행은 그 경고의
    *허용…*을 보여 줍니다.
  - http 소스의 *토큰 설정*은 토큰을 저장하기 전에 `token-unencrypted`를 묻습니다.
  - 401로 응답하는 http 소스의 미리보기는 자격 증명을 보내기 전에
    `token-unencrypted`를 묻습니다.

#### 18.2.3 카탈로그가 지정한 대상

| 대상 | 결과 |
|---|---|
| `public`, `https` | 수용 |
| `public`, `http` | 수용; 전달 행(§15.2)에 "암호화되지 않은 다운로드 — 고정된 sha256으로 검증"을 표시. 핀은 소스 자신의 전송으로 소스에서 오고, 핀 없는 단계는 건너뜀(§6.2) |
| 소스 자신의 호스트(정규화한 같은 호스트; `this-computer`는 같은 포트까지; ssh 소스의 파생 `https://<host>` 포함) | 소스의 확인을 물려받음 |
| `internal`, 다른 호스트 | 소스가 `internal-downloads`를 가질 때만 수용. 없으면 그 단계는 호스트를 명시한 `SOURCE_CONFIRMATION_REQUIRED`로 실패하고, 소스 행이 *사내 다운로드 허용*을 보여 줌. `internal-network`로 생기지 **않음**: 한 소스가 예상한 사내 서버라는 확인은 그 카탈로그가 지정할 다른 호스트에 대해 아무것도 말하지 않음 |
| `this-computer`, 다른 호스트나 포트 | 거부(§18.3 #4) |
| `metadata`, `unroutable` | 거부(§18.3) |

단계 의미는 그대로입니다(§6.2): 실패한 단계는 기록되고 사다리는 다음으로 넘어갑니다.

#### 18.2.4 검사를 연결에 묶기

해석된 주소에 따라 정해지는 거부와 정책 차단(§18.3 #3·#4, `blockPrivateNetworks`)은
연결이 실제로 쓰는 주소에 적용합니다. 연결 주소에 대한 적용은 Ave가 소유한
전송(다운로드, http/https 위 git)에 해당합니다. SSH는 사전 검사만 합니다(아래 ssh 위
git). 지금은 검사와 연결이 따로입니다:
`ensurePublicHttpUrl`이 해석한 뒤 `fetchPublicHttpResponse`가 호스트 이름을 Chromium
전송에 넘기고(`network-guard.ts:435-455`, `boot/steps/desktop-network-fetch.ts:79`),
git은 원격을 스스로 해석합니다. 그래서 검사에는 공개 주소를, 연결에는 루프백이나
메타데이터 주소를 응답하는 이름이 통과합니다. 경고는 권고이므로 추가 시점 검사로
충분하지만, 거부와 정책 차단은 그렇지 않습니다.

- **연결마다 조회 한 번.** Ave가 소유한 연결은 호스트를
  `dns.lookup(host, { all: true, verbatim: true })`로 한 번 해석하고, 모든 응답을
  분류해 거부나 정책 차단이 금지하는 응답을 버린 뒤, 남은 응답에만 연결합니다. 남은
  응답이 없으면 버린 것 중 가장 엄격한 분류의 거부입니다. 남은 응답의 분류에 소스가
  갖지 않은 확인이 필요하면 `SOURCE_CONFIRMATION_REQUIRED`(§18.5)입니다.
- **http 다운로드**(`MarketplaceNetworkGate.fetch`, `network-gate.ts:138-172`).
  Chromium 전송에는 해석과 연결 사이에 끼어들 지점이 없으므로, 마켓플레이스 다운로드는
  새 고정 전송 `src/marketplace/net/pinned-fetch.ts`로 옮깁니다. 호스트에 이미 있는
  고정 연결 패턴 `createA2AStrictTransport`(`src/api/a2a-remote-transport.ts:74-232`)를
  따릅니다. 한 번 해석하고 모든 응답을 검사하며(`:102-106`), 고른 응답만 돌려주고 두
  번째 호출은 실패시키는 `lookup`으로 연결하고(`:135-142`), SNI와 인증서 검사에는
  호스트 이름을 유지합니다(`servername`, `:131`). 신뢰 저장소는
  `tls.getCACertificates("default")`와 `tls.getCACertificates("system")`을 합친 것이라,
  OS 저장소에 설치한 회사 루트 인증서가 계속 동작합니다(§9.2). Electron 44가 싣는
  Node 24.20.0에 둘 다 있습니다. 리다이렉트 홉마다 새 연결이고, 조회와 검사도 새로
  합니다.
- **Ave가 소유한 전송의 프록시는 그 소켓 너머를 신뢰합니다.** PAC가 다운로드나 http(s)
  위 git 연결을 http(s)나 SOCKS 프록시(로컬이든 원격이든)로 보내면, 프록시로 가는 소켓은
  Ave가 소유합니다: 프록시 자신의 주소를 검사하고 프록시에만 연결하며, 그 너머의
  **목적지 제한은 프록시가 지킨다고 신뢰합니다**. Ave는 프록시가 연결하는 주소를 보지
  못합니다. 이 컴퓨터의 프록시(`PROXY 127.0.0.1:8080`)는 이 컴퓨터에서 연결하므로,
  카탈로그가 고른 이름을 그 프록시가 루프백이나 메타데이터 엔드포인트로 해석하면 그곳에
  닿습니다. 해석된 주소에 따른 거부와 차단(§18.3 #3·#4, `blockPrivateNetworks`)은 직접
  연결과 로컬에서 해석하는 프록시에 대해 지켜지고, 대상을 스스로 해석하는 프록시 너머에는
  미치지 않습니다. 이것이 명시한 경계입니다.
- **ssh `ProxyCommand`와 `ProxyJump`**는 ssh가 실행합니다. Ave는 이것을 살피지도 묶지도
  않습니다: 명령, 점프 호스트, 그 주소를 검사하지 않고, 어디로 연결하는지 보지 못합니다.
  사용자가 설정한 다른 프로그램처럼 신뢰합니다. 첫 홉에 대한 보장은 없습니다.
- **다운로드의 프록시.** 경로는 세션의 `resolveProxy(url)`로 정하며, git이 이미 쓰는
  해석기입니다(`run-git.ts:199-211`). 첫 항목만 쓰고, `DIRECT`로의 대체는 조용히 일어나지
  않습니다. 프록시 호스트는 위처럼 해석·검사합니다(`metadata`와 `unroutable`은 거부,
  `internal`과 `this-computer`는 시스템 설정이 고른 것이므로 수용). 전송은 호스트가 이미
  하위 프로세스용으로 매핑하는 종류(`PROXY`, `HTTPS`, `SOCKS5`,
  `src/shared/pac-proxy.ts:14-16`)와, git이 이미 받는 `SOCKS`/`SOCKS4`
  (`run-git.ts:205-208`)를 지원합니다:

  | PAC 종류 | Ave가 만들고 검사하는 연결 | 대상 해석 | https 대상의 TLS |
  |---|---|---|---|
  | `DIRECT` | 검사한 대상 응답, 고정 | 이 컴퓨터, 검사 | 종단 간, `servername` = 대상 호스트 |
  | `PROXY host:port` | 검사한 프록시 주소로 TCP; https는 `CONNECT host:port`, http는 absolute-form 요청 | 프록시(신뢰) | `CONNECT` 터널 안에서, `servername` = 대상 호스트, 같은 CA 묶음으로 검증 |
  | `HTTPS host:port` | 검사한 프록시 주소로 TLS(`servername` = 프록시 호스트, 같은 CA 묶음), 그 안에서 `PROXY`처럼 | 프록시(신뢰) | 터널 안의 두 번째 TLS, `servername` = 대상 호스트 |
  | `SOCKS5 host:port` | 검사한 프록시 주소로 TCP; 도메인 이름 주소 형식의 SOCKS5 `CONNECT` | 프록시(신뢰) | 터널 안에서, `servername` = 대상 호스트 |
  | `SOCKS host:port`, `SOCKS4 host:port` | 검사한 프록시 주소로 TCP; 대상의 검사한 IPv4 응답을 담은 SOCKS4 `CONNECT`(SOCKS4는 IPv4 주소만 담음) | 이 컴퓨터, 검사·고정; IPv4 응답이 없으면 `SOURCE_UNREACHABLE` 사유 `dns` | 터널 안에서, `servername` = 대상 호스트 |

  그 밖의 종류(`QUIC`처럼 Chromium 자체 스택만 쓰는 것)는 PAC 항목을 detail에 담아
  `SOURCE_UNREACHABLE` 사유 `proxy`로 실패합니다. 0.12 다운로드 전송은 Chromium을 거쳐
  그것에 닿았으며, 메시지가 IT에 무엇을 요청할지 알려 줍니다. git도 매핑할 수 없는 종류를
  같은 방식으로 거부합니다(`run-git.ts:210`).
- **http(s) 위 git.** `run-git.ts:156-171`에
  `-c http.curloptResolve=<host>:<port>:<address>[,<address>…]`를 더해 검사 뒤 남은 응답을
  나열합니다. libcurl은 자기 조회 대신 이 항목을 씁니다. `http.followRedirects=false`
  (`:162`)가 이미 모든 요청을 그 호스트에 묶습니다. `proxyFor`의 프록시가 있으면 두 번째
  항목이 프록시 호스트를 고정하며, 검사는 다운로드와 같습니다. curl이 대상을 스스로
  해석하면(원격 해석이 없는 SOCKS 프록시) 첫 항목이 그것을 고정하고, 아니면 신뢰하는
  프록시 규칙에 따라 프록시가 해석합니다.
- **ssh 위 git: 사전 검사만.** 러너는 git 호출과 같은 환경으로
  `ssh -G [-p <port>] [<user>@]<host>`를 돌려 유효 설정을 읽습니다. 이 명령은 `Host`와
  `Match` 블록을 평가한 뒤의 설정을 출력합니다(ssh(1), `-G`). 러너는 출력된 `hostname`을
  한 번 해석해 모든 응답을 분류합니다. **응답 중 하나라도 남는 거부(§18.3 #3·#4)나 관리
  차단(`blockPrivateNetworks`)에 걸리면 작업을 거부하며**, 그런 분류 중 가장 엄격한 것의
  거부로 실패하고 git을 시작하지 않습니다. *연결마다 조회 한 번*의 부분 집합 거르기는
  적용하지 않습니다: ssh는 검사한 응답이 아니라 호스트 이름을 받으므로 어느 응답으로든
  연결할 수 있습니다. 지금 git 원격에 대한 기준선 규칙과 같습니다(`checkRemote`,
  `network-gate.ts:116-125`가 쓰는 `ensurePublicHttpUrl`은 해석된 주소 하나라도 막히면
  거부, `core/network-guard.ts:323-338`). 소스가 갖지 않은 확인이 필요한 응답은 다른 곳처럼
  `SOURCE_CONFIRMATION_REQUIRED`(§18.5)입니다. `proxycommand`나 `proxyjump`가 있으면 대상은 프록시 너머에서
  해석되므로, 대상을 스스로 해석하는 PAC 프록시와 마찬가지로 러너가 해석하지 않고 위의
  ssh 프록시 규칙이 적용됩니다. 러너는 `HostName`, `HostKeyAlias`, `CheckHostIP` 옵션을
  넘기지 않습니다: ssh는 계속 `ssh -o BatchMode=yes`(`run-git.ts:184`)로 돌고, 사용자의
  ssh 설정, known-hosts 항목, 인증 기관을 그대로 씁니다. **잔여 위험:** 사전 검사와 ssh
  자신의 조회 사이에 바뀐 DNS 응답은 묶이지 않으며, SSH의 신뢰 기준은 호스트 키 검증입니다.
- **테스트**(슬라이스 C). 각 테스트의 해석기 가짜는 첫 조회에 공개 주소를, 이후 조회에
  `169.254.169.254`나 `127.0.0.1`을 응답합니다.
  - `pinned-fetch.test.ts`:
    - 요청은 첫 응답으로 가고, 조회는 홉마다 정확히 한 번 돕니다(되돌림: 호스트 이름을
      전송에 넘김);
    - 공개 + 메타데이터 응답 묶음은 공개 주소에만 연결합니다;
    - `PROXY p:8080; DIRECT`는 직접 연결하지 않습니다;
    - 로컬 프록시 픽스처로 PAC 종류마다 수용 사례 하나: http와 https 대상의 `PROXY`,
      `HTTPS`(프록시로 TLS, 이어서 대상으로 TLS), `SOCKS5`(요청이 도메인 이름 형식을 담음),
      `SOCKS4`(요청이 검사한 IPv4 응답을 담음), 모르는 종류는 `proxy`로 실패.
  - `trusted-proxy.test.ts`는 명시한 경계를 보여 줍니다: PAC로 설정한 루프백 `PROXY`
    픽스처와, 픽스처가 `127.0.0.1`로 해석하는 호스트에서의 카탈로그 다운로드. Ave는
    프록시 주소만 검사하고 그곳에만 연결하며, 픽스처는 루프백 대상에 닿고, 테스트는 바로
    그것을 단언합니다. 가드가 아니라 문서화한 동작을 고정하므로, 경계를 바꾸려면 이
    테스트와 §18.2.4를 함께 바꿉니다.
  - `run-git.test.ts`: argv에 첫 조회 주소의 `http.curloptResolve`가 있고, 러너는 두 번째
    조회를 하지 않습니다(되돌림: 옵션 제거).
  - `ssh-preflight.test.ts`. 유효 설정을 출력하는 `ssh -G` 가짜를 씁니다:
    - git 환경의 ssh 명령은 정확히 `ssh -o BatchMode=yes`이고, 그 명령과 argv 어디에도
      `HostName`, `HostKeyAlias`, `CheckHostIP` 옵션이 없습니다(되돌림: 고정 옵션 추가);
    - 해석기 응답이 `169.254.169.254`인 `hostname`은 거부 #3으로 실패하고 git은 시작하지
      않습니다(되돌림: 사전 검사 생략);
    - **섞인 응답**, 호출마다 두 주소를 모두 응답하는 고정 해석기 가짜로: 공개 주소와
      `169.254.169.254`는 거부 #3으로, `blockPrivateNetworks` 아래 공개 주소와 `10.0.0.5`는
      정책 차단으로 실패하며, 어느 경우에도 git은 시작하지 않습니다(되돌림: 공개 응답만
      남기고 git 실행);
    - `proxycommand`가 있는 설정은 러너가 해석하지 않습니다;
    - 명시한 경계: 해석기 가짜가 사전 검사에는 공개 주소를, 이후 조회에는 `127.0.0.1`을
      응답합니다. 사전 검사는 통과하고, 러너는 조회를 정확히 한 번 하며, git은 바뀌지 않은
      ssh 명령으로 시작합니다. `trusted-proxy.test.ts`처럼 §18.2.4에 적은 잔여 위험을
      고정하므로, 경계를 바꾸려면 이 테스트와 §18.2.4를 함께 바꿉니다.

### 18.3 남는 거부

> #1–4와 #7은 슬라이스 C에서(§7.1, §7.4, §13.1), #5와 #6은 슬라이스 D1에서
> 구현됐습니다(§7.7). #8은 Publication 계획의 몫이며, 폴더의 `process` 진입점은
> 이미 거부합니다(§18.4.9).

사용자가 어떤 결정을 해도 안전해지지 않으므로 거부합니다. 나머지는 경고(§18.2)나
정책 결정(§18.6)입니다.

| # | 거부 | 막는 공격 |
|---|---|---|
| 1 | `ext::`와 다른 모든 `<helper>::` 전송 | `ext::`는 그 텍스트를 명령으로 실행하고, `<helper>::`는 검색 경로의 `git-remote-<helper>`를 실행합니다. 주소가 코드 실행이 됩니다. git 자체도 `ext`의 기본값이 `never`이고, `GIT_ALLOW_PROTOCOL`은 허용 목록으로 남습니다(`run-git.ts:187`) |
| 2 | URL 안의 자격 증명(`https://user:secret@…`, `https://token@…`) | 비밀이 `sources.json`, 소스 보기, 로그, 감사 기록, 백업, 그리고 다른 로컬 사용자가 프로세스 목록에서 읽을 수 있는 git 명령줄에 남습니다. Ave에는 암호화된 토큰 저장소가 있습니다(§2.1). ssh 사용자 이름(`git@`)은 자격 증명이 아닙니다 |
| 3 | 모든 대상의 `metadata` 주소(정책 등재 호스트 포함), Ave가 소유한 직접 연결(다운로드, http/https 위 git)은 연결 주소에 적용; SSH는 사전 검사만; 대상을 스스로 해석하는 프록시 너머는 신뢰하는 프록시가 지킴(§18.2.4) | 클라우드 인스턴스의 메타데이터 서비스는 로컬 요청에 자격 증명을 내줍니다. 그곳에 git 서버는 없고, 사용자가 확인할 때 다른 곳을 가리키던 이름이 다음 연결 때 그곳으로 해석될 수 있습니다 |
| 4 | 소스 자신의 호스트·포트가 아닌, 카탈로그가 지정한 `this-computer` 대상, Ave가 소유한 직접 연결(다운로드, http/https 위 git)은 연결 주소에 적용; SSH는 사전 검사만; 대상을 스스로 해석하는 프록시 너머는 신뢰하는 프록시가 지킴(§18.2.4) | 제3자 카탈로그가 앱을 시켜, 로컬 호출자를 모두 믿는 로컬 서비스(개발 서버, 다른 앱의 제어 엔드포인트)에 요청하게 합니다 |
| 5 | 로컬 폴더를 벗어나거나 네트워크 위치를 가리키는 링크를 따라 읽기(§18.4.5) | 남의 체크아웃인 폴더가 `skills/x/notes.md`를 `~/.ssh/id_ed25519`로 링크하면 설치가 키를 모델이 읽는 패키지로 복사합니다. Windows에서는 `\\server\share`로의 링크가 사용자 네트워크 자격 증명을 그 서버로 보냅니다 |
| 6 | 로컬 폴더에 대한 모든 git 명령; git의 `file` 전송은 `never` 유지(`run-git.ts:158`) | git은 체크아웃 자신의 설정, alternates, 훅을 읽고, `core.fsmonitor` 같은 설정은 프로그램을 실행합니다 |
| 7 | 딥 링크 안의 폴더 경로 | 웹 페이지가 UNC 공유(미리보기에서 자격 증명 전송)나 다운로드 폴더 같은 심어 둔 폴더를 고릅니다. 추가 대화상자는 비어서 열리고 이유를 알립니다 |
| 8 | sha256으로 고정된 release·archive가 아닌 곳에서 온 `process` 엔트리 | `plugin-hostapi-protocol.md` §2.1과 그 Publication 계획 소유; 표를 완결하려고 적음(§18.4.9) |

보안상의 거부는 아니지만 지원하지 않는 것들입니다. 각 메시지는 대신 입력할 것을
알려 줍니다:

- `git://`: PAC 프록시가 라우팅할 수 없고, 같은 저장소를 https나 ssh로 제공합니다.
- 다른 모든 스킴; 쿼리나 프래그먼트; 공백이나 제어 문자.
- 상대 경로: 데스크톱 앱에는 작업 디렉터리가 없고, `owner/repo`는 GitHub 축약형으로
  남습니다.
- Windows 장치 경로(`\\.\…`, `\\?\GLOBALROOT\…`, `\\?\Volume{…}\…`).
- macOS·Linux의 `file://host/…` URL.
- `unroutable` 주소.
- 경로가 `marketplace.json`이나 `marketplace.2.json`으로 끝나는 `http(s)` 주소(결정 11).

### 18.4 로컬 폴더

> 슬라이스 D1에서 구현됐고 §7.7이 구현된 모습을 설명합니다. 아래 글과 다른
> 점은 다음과 같습니다.
> - 계획이 패키지 사본을 떠 두므로(§18.4.2) 검토 뒤에 고친 폴더는 설치에 닿지
>   않고, `PLAN_EXPIRED` `folder-changed`(§18.8)를 일으키는 경우는 없습니다.
>   사본의 다이제스트가 새 스냅숏과 다르면 계획이 `SOURCE_LOCAL_UNREADABLE`
>   `changed-during-read`로 실패합니다.
> - 폴더 영수증은 `consent` 없이 씁니다(§18.4.2). 슬라이스 F가 §18.7.3의
>   기준선과 함께 더합니다.
> - 폴더 선택기, *표시(Reveal)*, *로컬 폴더*·*네트워크 폴더* 배지, §18.4.8의
>   폴더 행과 출처 표시, 계획의 `notInstalled` 표시는 슬라이스 D2입니다.

폴더는 마켓플레이스 소스(루트에 `marketplace.2.json`이나 §3.3의 관례 배치가 있음)이거나
단일 패키지(§8)입니다.

#### 18.4.1 입력, 분류, 동의, 그다음 해석

`src/marketplace/net/source-input.ts`의 새 `normalizeSourceInput(input, platform)`이
폴더인지 git 주소인지 정하고, `normalizeSourceUrl`(`source-url.ts:195`)은 git 주소를
계속 맡습니다. 폴더는 네 단계를 거칩니다. **1–3단계는 경로에 파일 시스템 호출을 하지
않습니다**: `stat`, `lstat`, `realpath`, `readlink`, `open`, `readdir` 모두 없습니다. 동의와
정책이 앞서야 하는 것이 바로 UNC 서버 접속입니다.

1. **어휘 분석.** 문자열 작업만 합니다.
   - `file:` URL은 실행 중인 플랫폼 기준 `fileURLToPath`로 바꿉니다(`file:///C:/m`;
     Windows에서 `file://server/share/m` → `\\server\share\m`). macOS와 Linux에서
     호스트가 비어 있지 않고 `localhost`도 아니면 거부합니다.
   - `/`, `~`, 드라이브(`C:\`, `C:/`), `\\`, `//`로 시작하는 입력은 폴더입니다. `~`는
     `os.homedir()`로 펼칩니다.
   - `\\?\C:\…` → `C:\…`. `\\?\UNC\server\share\…`와 `//server/share/…` →
     `\\server\share\…`.
   - macOS나 Linux의 드라이브·UNC 형식은 Windows 경로로 거부합니다. `C:foo`(드라이브
     상대), `./`, `../`는 상대 경로로 거부합니다.
   - `.`과 `..` 구간은 어휘적으로 지웁니다. 드라이브, 공유, `/` 위로 올라가는 `..`는
     거부합니다.
   - 그 밖의 입력은 git 주소입니다(§7.1).
2. **네트워크 분류.** 여전히 파일 접근이 없습니다.
   - Windows UNC(`\\server\share\…`)는 `network`입니다.
   - Windows 드라이브 문자는 `QueryDosDeviceW("X:")`로 분류합니다. 이 함수는 이 로그온
     세션의 객체 관리자 MS-DOS 장치 이름 공간에서 드라이브 문자의 현재 매핑을 읽을
     뿐, 드라이브에서 아무것도 열지 않습니다. 매핑이 `\Device\HarddiskVolume<n>`,
     `\Device\CdRom<n>`, `\Device\Floppy<n>`이거나, 경로가 이 규칙으로 다시 로컬인
     `\??\<path>`(`subst` 드라이브)일 때만 로컬입니다. 그 밖 — `\Device\Mup\…`,
     `\Device\LanmanRedirector\…`, `\Device\WebDavRedirector\…`, `\??\UNC\…`, 모르는
     장치, 실패한 호출 — 은 `network`입니다. 여기서 잘못 짚으면 경고가 날 뿐, 거부가
     되지는 않습니다.
   - `GetDriveTypeW`는 드라이브 루트 경로를 받으므로 쓰지 않습니다.
   - macOS와 Linux에서 자동 마운트 경로(`/net/<host>/…`, macOS의 `/Network/…`)는
     어휘적으로 `network`입니다. 그 밖의 경로는 로컬입니다: 이미 마운트된 공유는
     마운트할 때 인증했고, 읽어도 새 자격 증명을 보내지 않습니다.
   - 호출은 기존 Windows 도우미 계열(`native/windows-job/`,
     `src/main/windows-job-launcher.ts`처럼 실행)의 작은 네이티브 도우미
     `native/windows-path-kind/`를 거칩니다. 이 도우미는 매핑을 출력할 뿐 다른 일은
     하지 않습니다. 슬라이스 D1이 도우미와 빌드 단계, Windows CI 실행을 더합니다.
3. **정책, 그다음 동의.**
   - `allowLocalSources`, `block`, §18.6의 `path:` 패턴을 어휘 경로에 적용합니다.
     차단이면 여기서 끝납니다.
   - `network` 폴더에는 `network-folder`(§18.2.2)가 필요합니다. 없으면 미리보기는
     `{ type: "confirm" }`(§18.5)으로 응답하고 아무것도 건드리지 않습니다.
4. **해석.** 3단계를 통과한 뒤에만 합니다. 경로를 구성 요소마다 `lstat`으로 걸어가며
   `realpath`는 부르지 않습니다. 루트를 정하는 동안, 입력한 경로 자신의 구성 요소 중
   링크나 정션 — macOS의 `/tmp → /private/tmp` 같은 조상이나 루트 자체 — 은 패키지 포함
   규칙이 아니라 **루트 해석**으로 다룹니다:
   - `readlink`로 텍스트를 읽어 §18.4.5 규칙 1처럼 분류합니다. 네트워크 텍스트는
     `link-to-network`로 거부하고 대상은 건드리지 않습니다;
   - 그 밖의 텍스트는 링크의 디렉터리에 대해 어휘적으로 해석하고 그곳에서 계속 걸어가며,
     만나는 모든 링크에 같은 규칙과 §18.4.5 규칙 4의 고리 한도를 적용합니다. 여기서는 포함
     규칙을 적용하지 않습니다: 사용자는 이 경로에 동의했고, 로컬 링크는 그 경로가 있는
     곳의 일부입니다.

   패키지 포함 규칙(§18.4.5 규칙 2)은 정식 루트가 정해진 뒤 그 **아래**에만 적용합니다.
   걸어가며 각 구성 요소의 디스크 표기를 부모의 `readdir`에서 기록합니다:
   바이트가 같은 항목이 있으면 그것, 없으면 대소문자만 무시하고 같은 항목이 하나일 때
   그것입니다. 그런 항목이 여럿이면 `SOURCE_LOCAL_UNREADABLE` 사유 `ambiguous-case`로
   실패합니다. 결과는 디렉터리여야 하고, `marketplace.2.json`이나 `marketplace.json`이라는
   일반 파일은 그 디렉터리로 바꿉니다. 3단계의 정책을 이 **정식 경로**에 다시 적용하고,
   이제야 드러난 차단이면 추가가 끝납니다. 저장하는 `path`는 정식 경로이고, 입력과
   다르면 대화상자가 "<입력>에서 해석됨"을 보여 줍니다.

저장된 폴더를 나중에 읽을 때(동기화, 계획, 새로 고침)마다 저장된 경로에서 2–4단계를
되풀이하므로, 공유로 다시 매핑된 드라이브 문자나 링크로 바뀐 구성 요소를 읽기 전에
잡습니다.

#### 18.4.2 읽기 모델: 제자리 읽기, 계획이 바이트를 확보

폴더 소스는 **제자리에서** 읽습니다. 추가하거나 읽을 때 아무것도 복사하지 않습니다.
부팅 때와 탐색마다(§18.7.1), *새로 고침* 때, 마켓플레이스 보기를 열 때(소스당 1분에
최대 한 번) 읽습니다. 파일 감시는 없습니다: 네트워크 공유와 큰 체크아웃에서는 믿을 수
없습니다.

- 스냅숏 빌더와 검증은 git의 것(§2.2, §4)을 `BareRepo`와 새 `FolderTree`가 구현하는
  `SourceTree` 인터페이스 위에서 씁니다.
- **계획이 바이트를 확보합니다.** 폴더 패키지의 설치나 업데이트를 계획할 때 소스를
  다시 읽은 뒤 패키지를 `workRoot` 아래 계획의 스테이징 디렉터리로 복사하고 다이제스트를
  계산합니다(§6.4). 실행은 그 사본을 설치하고 폴더를 다시 읽지 않으므로, 검토한 것이
  설치됩니다. 버려진 계획의 사본은 만료 때 지웁니다(§13.1).
- **폴더 소스는 내려받지 않습니다.** 모든 종류를 폴더의 파일에서 설치합니다. 플러그인의
  사다리는 단계가 하나, `folder`입니다: `plugin.json`, `dist/**`, `assets/**`를 §6.2처럼
  디스크립터와 비교합니다.
  - 선언된 `release`나 `archive` 단계는 시도하지 않습니다.
  - 폴더에 `plugin.json`이 없는 플러그인은 `NO_INSTALLABLE_ARTIFACT` 사유
    `folder-has-no-build`("플러그인을 `dist/`로 빌드하거나 git 저장소를 대신 추가하세요")로
    실패합니다.
  - 다른 최상위 항목(`src/`, `package.json`, `node_modules/`)은 무시하고 계획에 설치하지
    않는 항목으로 나열합니다. git 트리 단계는 더 엄격한 규칙을 유지합니다(§6.2).
- 폴더 플러그인은 `installSource: "folder"`인 영수증 스키마 v4와 `folder` 기록
  `{ sourceId, sourceOrigin, revision, packagePath, treeSha256, authoritySha256, consent }`를
  씁니다(`plugin-install-receipt.ts:86-100`에 유니언 멤버 추가; `consent`는 §18.7.3의
  기준선). 레지스트리 `origin.rung`은 `"folder"`입니다(`src/plugins/registry.ts:304-315`).
  호스트 비밀 부여(§10.3 조건 2)나 `process` 엔트리(§18.4.9)의 자격이 되지 않습니다.

#### 18.4.3 리비전, 이력, 버전

§7.3의 핀은 커밋이고, 폴더의 핀은 **리비전**입니다: 스냅숏이 읽은 모든 파일(인덱스나
§3.3의 디스크립터, `policy/revocations.json`, 앱 조건부 폐기 파일)에 대해
`"<sha256(file)> <path>\n"` 줄을 경로 바이트 순으로 정렬하고, 패키지마다
`"<tree digest> <package path>/"` 줄 하나(트리 다이제스트(§6.4)는 그 패키지가 설치할
파일을 덮음)를 더한 것의 hex sha256 앞에 `local-`을 붙입니다. 설치되는 파일을 하나라도
고치면 리비전이 바뀝니다.

- 리비전은 핀을 저장하는 모든 곳에 들어갑니다: `state.json`의 `pinnedCommit`,
  `snapshots/<revision>.json`, 레지스트리와 원장의 `origin.commit`, 계획
  `snapshotCommit`, 보존(§2.1). 40자리 hex 검사(`registry.ts:87`, `sync.ts:49`,
  `src/plugins/registry.ts:304-315`의 레지스트리 출처 검사)는 폴더 소스에만
  `^local-[0-9a-f]{64}$`를 받고, 폴더 소스는 40자리 hex 값을 거부합니다.
- 이력 규칙이 없습니다: 읽을 때마다 폴더의 현재 상태입니다. `pendingRewrite`와
  `SOURCE_HISTORY_REWRITTEN`은 해당하지 않습니다.
- 폴더에 파일이 있는 버전만 설치할 수 있습니다. 인덱스의 다른 `versions[]` 항목은
  이력으로 보일 뿐 제공하지 않고, 그 `commit` 값은 검사하지 않습니다. 폴더의 버전은
  인덱스 사본과 같아야 합니다(§6.2).
- git 체크아웃은 **작업 트리**로 읽습니다. `.git`은 읽지도 설치하지도 않고, git 명령도
  돌리지 않습니다(§18.3 #6). 커밋하지 않은 수정도 포함되며, 반복 작업하는 작성자가
  기대하는 동작입니다.

#### 18.4.4 식별과 중복

- 두 폴더 소스는 정식 경로(§18.4.1 4단계)가 바이트 단위로 같거나, 두 디렉터리가
  `fs.stat`(`bigint: true`)에서 같은 0 아닌 `dev`와 `ino`(Windows는 볼륨 일련번호와 파일
  인덱스)를 보고하면 같습니다. 플랫폼 단위 대소문자 접기는 없습니다: 대소문자를 구분하는
  볼륨에서 `/Approved/Tools`와 `/approved/tools`는 다른 폴더이고 다른 소스로 남으며,
  구분하지 않는 볼륨에서는 걸어가며 얻은 디스크 표기와 같은 `dev`/`ino`가 둘을 하나로
  만듭니다. 매핑된 드라이브와 그 UNC 경로도 이렇게 잡힙니다.
- `stat`이 `dev`나 `ino`를 0으로 보고하면(일부 네트워크 파일 시스템) 정식 경로만으로
  정합니다. 그러면 한 폴더의 두 표기가 두 소스가 되어 패키지가 두 번 보일 수 있지만,
  새로 허용되는 것은 없습니다.
- 이미 소스인 폴더, 또는 소스를 포함하거나 소스 안에 있는 폴더는 그 소스를 명시한
  `SOURCE_ID_TAKEN`으로 거부합니다: 중첩되면 패키지가 두 번 나열됩니다.
- 폴더 소스와 git 소스는 폴더가 그 저장소의 체크아웃이더라도 같은 소스가 아닙니다. 같은
  `(kind, name)`은 카드 두 장으로 보이고(§15.1), 두 번째를 설치하면 소스 전환입니다.
- `SourceEntry`(`registry.ts:39-49`)에 `url`과 배타적인 `path?: string`(슬라이스 D1)과
  `acknowledged?: SourceWarning[]`(§18.5, 슬라이스 C)를 더합니다. `ENTRY_KEYS`
  (`registry.ts:88`)도 슬라이스마다 각각을 더합니다.
- 폴더 항목은 `auth: { kind: "none" }`이고 `ref`가 없습니다. 걸어간 결과가 더 이상 같은
  디렉터리에 닿지 않는 저장 `path`(구성 요소가 링크로 바뀌었거나 `dev`/`ino`가 바뀜)는
  `SOURCE_LOCAL_UNREADABLE` 사유 `moved`로 다루고, 새 대상은 읽지 않습니다.

#### 18.4.5 파일 읽기

`FolderTree`와 해석 걸음은 링크 규칙 하나를 함께 씁니다. 모든 파일 시스템 호출은
`FolderFs` 인터페이스(`lstat`, `readlink`, `readdir`, `open`, `fstat`, `read`,
`queryDosDevice`)를 거치며, 테스트는 이것을 호출을 기록하는 가짜로 바꿉니다.

- 디렉터리는 걸어가고 일반 파일은 읽습니다. 장치, 소켓, FIFO는 패키지를 실패시킵니다:
  `CONTENT_RULE_VIOLATION` 사유 `special-file`.
- **심볼릭 링크나 정션**은 OS가 따라가게 두지 않습니다. `readlink`로 텍스트만 읽고, 어떤
  호출이 대상을 건드리기 전에 텍스트로 판단합니다:
  1. 네트워크 위치를 가리키는 텍스트는 텍스트만으로 거부합니다: `\\…`, `//…`,
     `\??\UNC\…`, `\\?\UNC\…`, 장치 경로, 2단계가 `network`로 분류하는 드라이브 문자,
     자동 마운트 경로. `CONTENT_RULE_VIOLATION` 사유 `link-to-network`가 링크를
     명시합니다. 네트워크 폴더 소스 안에서도 같습니다: 사용자는 그 공유에 동의했지,
     그 링크가 가리키는 서버들에 동의하지 않았습니다.
  2. 아니면 텍스트를 링크 자신의 디렉터리에 대해 **어휘적으로** 해석합니다. 소스 루트
     밖이면 사유 `link-outside-folder`이고 대상은 건드리지 않습니다.
  3. 루트 안이면 대상에서 구성 요소마다 계속 걸어가며, 만나는 모든 링크에 같은 규칙을
     적용합니다. 그래서 `root/a → root/b → \\attacker\share` 사슬은 `b`의 텍스트에서
     멈추고, 서버를 부르는 호출은 없습니다.
  4. 두 번 닿은 디렉터리, 또는 한 해석에서 링크 40개 초과는 고리로 보고 패키지를
     실패시킵니다.

  설치된 사본은 대상의 바이트를 일반 파일로 담습니다. 인덱스나 폐기 파일에서 링크가
  거부되면 읽기 전체가 실패합니다.
- **파일 열기**는 macOS와 Linux에서 `O_NOFOLLOW`를 쓰며, 이는 마지막 구성 요소만
  보호합니다. 연 뒤 `fstat`이 걸음의 `lstat`이 본 `dev`/`ino`를 보고해야 합니다.
- **지속된 교체 감지.** 걸음은 디렉터리를 나열할 때마다 그 `dev`/`ino`를 기록합니다.
  파일마다 읽은 뒤 정식 루트에서 그 파일의 디렉터리까지 디렉터리 사슬을 다시 `lstat`해
  모든 항목을 비교하고, 파일의 `fstat`도 비교합니다. 하나라도 다르면
  `SOURCE_LOCAL_UNREADABLE` 사유 `changed-during-read`로 읽기가 실패하고 바이트는
  버립니다. 그래서 파일을 다 읽었을 때까지 남아 있는 교체는 잡힙니다.
- **동시 교체 경계, 모든 플랫폼.** Node에는 쥐고 있는 디렉터리 핸들에 고정한 이식 가능한
  순회(`openat`)가 없고, 이 설계도 그것을 약속하지 않습니다. 소스 트리에 쓸 수 있는
  프로세스가 걸음의 검사 사이에 중간 디렉터리를 링크로 바꿨다가 되돌리면 읽기를 다른
  곳으로 돌릴 수 있습니다. 그렇게 잡힌 바이트는 사용자가 이미 읽을 수 있던 파일의
  바이트이며, 패키지에 들어갈 수 있습니다. Node의 열기가 리파스 포인트를 따라가는
  Windows에서는 같은 틈으로 Ave가 UNC 서버에 접속할 수도 있습니다. 이 잔여 위험에는
  사용자가 소스로 고른 폴더에 동시에 쓰는 로컬 프로세스가 필요하며, 막지 않고 명시해
  둡니다.
- 어느 깊이에서든 조용히 건너뛰고, 읽거나 다이제스트하거나 설치하지 않음: `.git/`,
  `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`.
- 이름은 NFC(git이 저장하는 형식)로 정규화합니다. NFC로 같아지거나 대소문자만 다른
  두 이름은 패키지를 실패시킵니다(§5.5).
- 실행 비트는 macOS와 Linux에서 `lstat`에서 가져옵니다. Windows에는 없으므로 그곳에서는
  모든 파일이 `100644`입니다.
- §5.4의 한도를 읽으면서 적용하고, 처음 넘는 한도에서 읽기를 멈춥니다.
- 패키지를 git에 게시할 때 저장소 검사는 여전히 링크를 거부하고, 미리보기 진단이
  그렇게 알립니다.

#### 18.4.6 Windows

- 드라이브와 UNC 경로를 받습니다. 정션은 링크입니다(§18.4.5).
- 네트워크 폴더를 읽으면 사용자로서 그 서버에 로그인합니다: 입력 대상 경고
  `network-folder`(§18.2.2)는 "이 폴더를 읽으려고 Windows 계정으로 <서버>에
  로그인합니다"라고 말합니다. 서버 이름은 UNC 경로나 드라이브의 `QueryDosDeviceW`
  매핑에서 얻습니다.
- 잠긴 파일, 내려받을 수 없는 클라우드 저장소 자리 표시자, 권한 오류는
  `SOURCE_LOCAL_UNREADABLE` 사유 `io`와 OS 메시지로 읽기를 실패시킵니다. 마지막 정상
  스냅숏을 제공하고(§7.5) 다음 읽기에서 다시 시도합니다.
- 저장 경로에는 `\\?\`를 붙이지 않습니다. 긴 경로 접두사는 Node가 붙입니다.
- 바이트는 있는 그대로 읽습니다: CRLF 체크아웃은 CRLF 파일을 설치합니다.

#### 18.4.7 폴더에서 직접 설치

*Git URL이나 폴더에서 설치…*(§15.1)는 폴더 경로나 *폴더 선택…*을 받습니다. 감지는
폴더 루트에서 §8.1대로 합니다. 결과는 `path`를 가진 `direct` 소스이고, 패키지
다이제스트가 바뀌면 업데이트됩니다(§18.7.6). 합성 버전(§8.2)은
`0.0.0+t<digest12>`입니다.

- 플러그인 스튜디오의 *파일에서 설치*(`plugin-studio.ts:168-175`)는 zip이나 폴더의
  일회성, 소스 없는 설치로 남습니다(결정 30).
- 개발 전용 로컬 플러그인 설치(`plugins.ts:449-453`, `isDevModeUnlocked` 뒤)는
  그대로입니다.
- 정책 `allowDirectInstall: false`(§12)나 `allowLocalSources: false`(§18.6)는 이것을
  거부합니다.

#### 18.4.8 폴더 소스의 모습

- **소스**(§15.4):
  - 폴더 아이콘과 "폴더" 라벨;
  - 가운데를 줄인 경로, 전체 경로는 툴팁;
  - `folder · <revision 7>`와 "<시각>에 읽음";
  - 상태 *최신*, *폴더 없음*, *폴더를 읽을 수 없음*, *폴더 이동됨*;
  - 더보기 *새로 고침*, *Finder에서 보기* / *탐색기에서 보기* / *파일 관리자에서 보기*,
    *제거*. *토큰 설정* 없음.
- **패키지 시트**(§15.2): 출처 "폴더 <경로>, <시각>에 읽음, 내용 <digest12>"; 버전
  "폴더에 있는 버전만 설치할 수 있습니다".
- **추가 대화상자**(§15.5): 주소 칸이 경로를 받고 *폴더 선택…*이 있습니다. 미리보기는
  "이 폴더의 변경은 시작할 때, 몇 시간마다, 새로 고침할 때 반영됩니다"라고 말합니다.

#### 18.4.9 `process` 엔트리, http 소스, 폴더

`main`의 `plugin-hostapi-protocol.md` §2.1은 sha256으로 고정된 `release`나 `archive`
단계로 온 산출물을 영수증에 기록한 설치에만 `process` 엔트리를 허용합니다. 그 구현은
Publication 계획, 그 문서의 §9.7(`plugin-hostapi-protocol.md:2222`, #2592부터 `main`)입니다.
그 슬라이스(`:2645-2650`) 중 M1은 병합되었고(#2591), S1과 P1은 구현 중이며,
P3(`process` 런타임과 그 코드, `:3557`)와 P4(마켓플레이스 허용, `:3871`)는 아직 만들지
않았습니다. P4는 이미 로컬 디렉터리 소스를 `installLocal`처럼 거부한다고 적고 있습니다
(`:3887-3889`). 이 설계는 그 규칙을 완화하지 않습니다.

- **시간에 따른 코드.**
  - 오늘 `main`은 모든 `process` 엔트리를 `process-entry-unsupported`로 거부합니다
    (`src/marketplace/errors.ts:37`, `src/plugins/process-entry-support.ts:3`).
  - P3는 그 코드를 `process-entry-unconfined`와 `process-entry-requires-pinned-artifact`로
    바꿉니다.
  - §18.8은 셋 모두의 문장을 담고, 슬라이스 B는 병합할 때 `main`에 있는 것을 싣습니다.
- **폴더 소스와 폴더 직접 설치**는 release·archive 단계를 쓰지 않습니다(§18.4.2). 그
  영수증(`installSource: "folder"`)은 나중의 어떤 규칙에서도 `process` 허용 자격이 원천적으로
  없습니다. 슬라이스 D1은 폴더의 `process` 매니페스트를 사다리에서 거부합니다:
  - `main`의 코드가 `process-entry-unsupported`인 동안에는 그것으로;
  - P3가 병합된 뒤에는 `process-entry-requires-pinned-artifact`로 — 구현된
    코드이며, 폴더 단계와 설치기 양쪽에서 거부합니다.

  D1과 P4 중 나중에 병합하는 쪽이 폴더 경로의 거부를 유지하므로, 둘 사이에서 거부가
  빠지는 일은 없습니다.
- **http 소스**: 규칙은 적힌 그대로입니다. 네트워크 공격자는 핀과 산출물을 함께 바꿀 수
  있으므로, http 소스의 패키지는 사용자가 `unencrypted-updates`를 받아들이기 전까지
  자동으로 업데이트하지 않습니다(§18.7.2).

### 18.5 추가 흐름, 확인, 배지

> git 주소에 대해 슬라이스 C에서(§7.2, §15.4, §15.5), 폴더 단계와
> `network-folder`는 슬라이스 D1에서 구현됐습니다(§7.7). *네트워크 폴더*·*로컬
> 폴더* 배지는 슬라이스 D2, `unencrypted-updates`는 슬라이스 F의 몫입니다.

1. 사용자가 주소를 입력하거나 폴더를 고릅니다.
2. `sources:preview`가 분석하고(§7.1, §18.4.1 1–2단계) 거부(§18.3)와 정책(§18.6)을
   적용합니다. 거부나 정책 차단이면 여기서 끝납니다.
3. 대상을 분류합니다(§18.2.1, §18.4.1 2단계). 요청의 `acknowledge`에 없는 경고가 필요하면
   미리보기는 `{ type: "confirm", warnings }`로 응답하고 **git 명령, DNS에 따른 연결,
   폴더에 대한 파일 시스템 호출을 하나도 하지 않습니다**. *계속*은 `acknowledge`를 담아
   미리보기를 다시 합니다.
4. 미리보기가 가져오거나 해석해 읽고(§7.2, §18.4.1 4단계, §18.4) 분류합니다. 경고는
   배지로 보입니다.
5. *추가*는 미리보기가 담고 있던 확인을 그대로 저장합니다.

- **저장**: custom·direct 소스는 `SourceEntry.acknowledged`, official·managed 소스는
  `SourceState.acknowledged`(`STATE_KEYS`, `registry.ts:89`). 값: `unencrypted`,
  `token-unencrypted`, `internal-network`, `this-computer`, `internal-downloads`,
  `network-folder`, `unencrypted-updates`.
- **분류가 바뀐 대상**(이름이 이제 사내 주소로 해석되거나, 드라이브 문자가 이제 공유로
  매핑됨)은 동기화·설치·업데이트를 `SOURCE_CONFIRMATION_REQUIRED`로 실패시킵니다. 행에
  *허용…*이 보이고, 이것이 `sources:acknowledge`를 부른 뒤 다시 동기화합니다. 확인은
  주소가 아니라 분류 단위입니다.
- **배지**는 소스 행과 그 패키지 카드에 텍스트와 툴팁으로 붙고, 색만으로 표시하지
  않습니다(§15.9): *암호화 안 됨(http)*, *사내망*, *이 컴퓨터*, *사내망 다운로드*,
  *네트워크 폴더*, *로컬 폴더*. http 툴팁: "네트워크 경로의 누구나 이 소스가 보내는
  것을 읽고 제공하는 것을 바꿀 수 있습니다. 이 소스의 업데이트는 자동으로 설치하지
  않습니다."
- 확인을 거두거나 주소를 바꾸려면 소스를 제거하고 다시 추가합니다.

### 18.6 관리 정책 추가 항목

```jsonc
"marketplaces": {
  "requireHttps": false,          // true: plain http is a policy block (allowHttpHosts excepted)
  "blockPrivateNetworks": false,  // true: internal and this-computer targets are a policy block (policy-listed hosts excepted)
  "allowLocalSources": true,      // false: folder sources and folder installs are a policy block
  "autoUpdate": "user",           // "user" | "on" | "off" (§18.7.2)
  "allow": ["https://github.com/acme/*", "host:git.corp.example", "path:/opt/acme/marketplaces/*"],
  "block": ["path:/tmp/*"],
  "additional": [{ "id": "acme-local", "path": "/opt/acme/marketplaces/tools" }]
}
```

- `requireHttps`와 `blockPrivateNetworks`는 입력한 대상과 카탈로그가 지정한 대상,
  다운로드와 리다이렉트 홉까지 적용합니다. `blockPrivateNetworks`는 Ave가 소유한
  전송(다운로드, http/https 위 git)의 직접 연결에서 연결 주소에 적용하고, SSH는 사전
  검사만 하며, 대상을 스스로 해석하는 프록시 너머는 신뢰하는 프록시가 지킵니다
  (§18.2.4). 0.12의 거부를 어떤
  확인으로도 통과할 수 없는 차단으로 되살립니다.
- **`path:` 패턴.** `path:<folder>`는 그 폴더, `path:<prefix>*`는 접두사 아래 모든 폴더,
  `path:*`는 모든 폴더와 맞습니다. `/`와 `\`는 같습니다.
  - 3단계에서 어휘 경로와, 4단계에서 정식 경로와 다시 비교합니다(§18.4.1). 규칙을 쓸
    때는 볼륨이 대소문자를 구분하는지 알 수 없으므로 대소문자 규칙은 보수적입니다:
    `allow` 패턴은 대소문자까지 정확히 같을 때만 맞고, `block` 패턴은 대소문자를
    무시하고 맞습니다. 그래서 차단은 모든 표기를 덮고, 허용은 관리자가 쓴 표기만
    받아들이며, 대소문자를 구분하지 않는 볼륨에서는 걸음이 그 표기를 디스크에서
    되찾습니다.
  - `path:` 패턴은 폴더에만, `host:`와 URL 패턴은 git 소스에만 적용합니다.
  - `allow`가 있으면 폴더는 그 `path:` 항목 중 하나와 맞아야 하므로, 기존 허용 목록은
    관리자가 항목을 더할 때까지 폴더를 막습니다(§12처럼 닫힌 쪽으로 실패).
- `additional[]`은 프로비저닝한 폴더에 `url` 대신 `path`를 받습니다: 출처 `managed`,
  정책 항목이 `network-folder`를 뜻하므로 그 밖의 경고 없음, 제거 불가.
  `allowLocalSources: false`인데 `additional` 폴더가 있으면 그 절은 무효입니다(§12).
- 사용자 설정, 확인, 스위치는 정책 차단을 넘지 못합니다.
- `requireHttps`, `blockPrivateNetworks`, 아래의 정책 갱신은 구현됐습니다
  (슬라이스 C, §12). 이 절의 나머지는 구현 전입니다.
- **정책 변경이 적용되는 때.** 슬라이스 C 전에는 서비스를 만들 때 정책을 한 번
  읽고 서비스를 캐시했으므로 변경이 재시작을 기다렸습니다. 슬라이스 C부터:
  - 서비스는 `PolicySource`를 거쳐 정책을 읽습니다. 모든 작업(미리보기, 추가, 확인,
    동기화, 탐색, 계획, 실행)을 시작할 때 파일을 지난 읽기와 비교합니다(구현:
    식별자, racy 구간 밖에서만 믿는 시각, sha256, §12).
  - 바뀌었으면 새 정책을 만들어 게이트, 레지스트리 필터, 설치기에 서비스의 작업 잠금
    아래에서 한 번에 바꿔 넣으므로, 어떤 작업도 섞인 정책을 보지 않습니다.
  - 계획은 만들어질 때의 정책 다이제스트를 기록합니다. 다른 다이제스트에서 실행하면
    `PLAN_EXPIRED` 사유 `policy-changed`로 실패하고, 새 계획으로 검토를 다시 엽니다.
  - 읽을 수 없거나 무효가 된 정책은 지금의 무효 정책처럼 동작합니다
    (`git-marketplace.ts:252-254`): 공식만, `policy-invalid` 표시. 파일을 고친 뒤 첫
    작업에서 회복합니다.
  - 탐색(§18.7.1)도 작업이므로, 새 정책이 막는 소스는 재시작 없이 한 탐색 간격 안에
    막힙니다.
- **배포.** 0.13.0까지의 앱은 이 절을 정확히 읽고 모르는 키가 있으면 절 전체를
  무효로 보아, 공식이 아닌 모든 소스를 막습니다(§12). 각 키는 그 슬라이스를 담은
  릴리스 이상에만 배포합니다.

### 18.7 자동 업데이트

#### 18.7.1 스케줄러 하나, 기한 규칙 둘

백그라운드 틱(`background.ts:156-170`)이 유일한 스케줄러로 남습니다. 부팅 때(부팅
패스 직후, `background.ts:154`), 한 시간마다, `powerMonitor` `resume` 때, *지금 확인*
때, 설정이 바뀔 때 **기한 확인**을 돌리고, 기한이 된 것을 시작합니다:

```
discovery (due: rule below)
  sync every source that syncs (§7.3; a folder source is read, §18.4.2)
  enforce revocations (§10.4)                    -- always, whatever the settings
  compute updates (updateFor, identity.ts:79); publish notices and status
apply check (due: rule below)
  run a discovery first, or join the one in flight
  classify each update that discovery returned (§18.7.2, §18.7.3)
     automatic -> enqueue for the apply queue (§18.7.4)
apply queue (separate, one package at a time, waits for idle)
```

- **탐색의 기한**은 두 갈래 중 하나입니다:
  - **시도가 실패한 뒤**(마지막 결과가 `offline`이나 `partial`이거나 시도가 예외를
    던짐): `lastSuccessAt`과 무관하게 `lastAttemptAt`이 1시간 이상 지났을 때. 그래서
    *지금 확인*이 시작한 것까지 포함해 실패하거나 오프라인이었던 시도는 다음 한 시간
    기한 확인에서 다시 합니다;
  - **시도가 성공한 뒤**: `lastSuccessAt`이 `updateCheckIntervalMs` 이상 지났을 때.

  `updateCheckIntervalMs`는 키, 6시간 기본값(`background.ts:23`), `0`(부팅과 *지금
  확인*만), 15분 하한, 상한이 없다는 점(`background.ts:25-32`)을 유지합니다. `0`이어도
  실패한 시도 갈래는 탐색이 성공할 때까지 한 시간마다 다시 시도합니다.
- **적용 확인의 기한**은 부팅, *지금 확인*, 그리고 마지막으로 성공한 적용
  확인(`applyCheckAt`)이 24시간 이상 지났을 때입니다. 업데이트에 대한 소유자의 "부팅 때와
  하루 한 번"입니다. **기한이 된 적용 확인은 언제나 새 탐색을 먼저 얻습니다**: 이미 도는
  탐색에 합류하거나 하나를 시작하고, 그 탐색의 결과만 분류합니다. 신선도 조건은 없으므로,
  마지막 탐색의 나이나 탐색 간격의 위상이 무엇을 분류할지 정하지 않습니다. 그 탐색은
  보통의 탐색이라 `lastAttemptAt`과 `lastSuccessAt`을 기록하고 탐색 간격을 다시 시작합니다.
  나머지는 그 결과가 정합니다:
  - `ok`: 모든 업데이트를 분류하고 `applyCheckAt`을 씁니다;
  - `partial`: 닿은 소스의 업데이트를 분류하고 나머지는 기다리며, `applyCheckAt`은 쓰지
    않으므로 적용 확인은 기한인 채로 실패한 시도 갈래의 한 시간 재시도에 합류합니다;
  - `offline`이나 `error`: 아무것도 분류하지 않고, 적용 확인은 같은 방식으로 기한인 채
    남습니다.
- **탐색을 6시간으로 두는 이유.** 폐기는 인덱스와 같은 fetch로 옵니다(§10.4). 0.12는
  실행 중인 앱에 6시간 안에 전달하는데, 탐색을 24시간 업데이트 주기로 늘리면 폐기된
  패키지가 네 배 오래 실행됩니다. 탐색은 소스당 fetch 한 번이고, 아무것도 적용하지
  않습니다.
- **탐색은 적용을 기다리지 않습니다.** 적용 큐는 별도 작업자입니다. 큐가 유휴를
  기다리는 동안에도 탐색은 끝나고, 시각을 기록하고, 상태를 게시합니다(§18.7.4).
  `updates:check`는 그 탐색과 적용 확인이 끝나면 돌아오고, 큐에 든 업데이트는 그때
  `waiting`으로 보입니다. 다음 적용 확인은 큐의 항목을 자기 결과로 바꾸고, 이미 적용
  중인 패키지는 건드리지 않습니다.
- **시간 보장.** 앱이 실행 중이고 깨어 있고 소스에 닿는 동안, 그곳에 게시된 폐기나
  업데이트는 `updateCheckIntervalMs` + 1시간(기본 7시간) 안에 발견됩니다. 잠든 동안은
  `resume`에서 따라잡습니다. 자동 대상 업데이트는 게시 뒤 25시간 안에 분류됩니다: 다음
  적용 확인은 지난 것에서 많아야 24시간 뒤에 기한이 되고, 다음 한 시간 기한 확인에서
  돌며, 언제나 먼저 탐색합니다. 그리고 대화가 다음에 유휴일 때 적용됩니다. **유휴
  대기에는 상한이 없습니다**: 30분 뒤 사용자에게 알리고 바로 적용할 수 있게 하는데(§18.7.4), 이는 한도가
  아니라 단계 올림입니다. 예외:
  - `updateCheckIntervalMs: 0` — 예정 탐색은 부팅과 *지금 확인* 때만, 실패 뒤에는 한
    시간마다 재시도; 매일 적용 확인은 여전히 돌고 자기 탐색을 얻음;
  - 오프라인 — 한 시간마다 재시도;
  - 실패하는 소스 — 그 패키지는 기다리고 나머지는 진행.
- **기억**: `~/.ave/marketplaces/updates.json`:

  ```
  { version: 1,
    discovery: { lastAttemptAt, lastSuccessAt, result: "ok" | "partial" | "offline" | "error" } | null,
    applyCheckAt: string | null,
    packages: { "<sourceId>:<kind>:<name>": { to, state, attempts, lastError?: { code, detail?, at }, appliedAt? } } }
  ```

  읽을 수 없는 파일은 빈 파일로 바꾸고 업데이트 카드가 그렇게 알립니다. 그 영향은
  시점과 재시도 횟수뿐이고, 무엇이 적용되는지는 바뀌지 않습니다.

#### 18.7.2 기본값과 스위치

업데이트는 모든 **전제 조건**이 맞을 때만 자동 적용합니다:

- 패키지가 켜져 있음(사용자나 폐기로 꺼지지 않음);
- 소스가 보임(숨긴 소스도 동기화하지만, 그곳에서의 설치는 `SOURCE_DISABLED`,
  `service.ts:725-727`);
- 업그레이드임: 다운그레이드도, 소스 전환도 아님;
- 소스에 대기 중인 이력 재작성이 없음(§7.3);
- 건너뛴 버전이 아님(`skippedPluginUpdates`, `skipped-plugin-updates.ts:95-103`);
- 적용 시도 세 번 연속 실패하지 않음(§18.7.5);
- **실행 중인 세대에서 승인된 모든 MCP 서버와 훅이 승인을 유지함**: 각각 이어지거나
  (§18.7.3) 새 버전에서 빠짐. 아니면 업데이트는 `needs-review`입니다. 이것은 불변식입니다:
  자동 업데이트는 전에 승인된 구성 요소를 승인 없는 상태로 남기지 않습니다;
- 평문 http로 닿는 소스는 `unencrypted-updates`를 가짐(네트워크 공격자가 새 핀을 담은
  새 커밋을 제공할 수 있고, 그것을 무인으로 적용하면 사용자 행동 없이 그들의 코드가
  실행됨).

그다음, 설정된 것 중 첫 번째가 정합니다:

1. 정책 `autoUpdate`: `"off"`나 `"on"`;
2. 패키지 스위치 `marketplace.autoUpdatePackages[<key>]`(`"on"`/`"off"`; 키 =
   `packageUpdateSkipKey`, `skipped-plugin-updates.ts:87`);
3. 소스 스위치 `marketplace.autoUpdateSources[<sourceId>]`;
4. 전역 스위치 `marketplace.autoUpdate`(`false` = 끔);
5. 출처별 기본값:

| 소스 | 기본값 |
|---|---|
| official | 켬 |
| managed(`additional`) | 켬; 정책 `autoUpdate`가 잠글 수 있음 |
| custom, https나 ssh | 켬 |
| http의 custom이나 direct | 사용자가 켜고 `unencrypted-updates`를 받아들일 때까지 **끔** |
| direct(git) | 켬 |
| 폴더(custom이나 direct) | 켬: 작성자의 수정이 손 갈 일 없이 앱에 닿음 |

§18.7.3이 실행하는 것이나 접근 범위를 바꾸는 모든 업데이트를 붙잡으므로 기본값을
넓게 둡니다. 스스로 적용되는 업데이트는 로컬 실행 구성 요소가 없는 패키지만 바꾸거나,
실행 구성 요소가 닿을 수 있는 것을 하나도 바꾸지 않습니다.

**`requiredInstalls`(§10.2)**는 적용 확인마다 `required: true`(`service.ts:1031-1033`)를
달아 자동 업데이트와 같은 적용 큐로 업데이트하므로, 부팅 때도 그것들처럼 유휴를
기다립니다. 정책이 사용자의 동의를 대신하는 곳은 여기뿐입니다. 정확히는:

| 규칙 | 필수 설치 |
|---|---|
| 전역·소스·패키지 스위치; 건너뛴 버전 | 무시: 적용하지 않음 |
| 정책 소스로의 소스 전환 | 지금처럼 허용(`run.ts:136`) |
| 동의 지문의 권한 필드(§18.7.3) | 정책이 승인: 지금처럼 `reviewedAuthority = true` |
| MCP 서버와 훅 | 정책이 승인하지 **않음**. 이어가기(§18.7.3)가 바뀌지 않은 것의 승인을 유지함. 새로 생겼거나 바뀐 것은 승인 없이 설치됨: 매니저는 승인 없는 투영을 게시하지 않으므로(`mcp-manager.ts:393`) 실행되지 않고, 패키지는 `approval-pending`(§18.7.5)이 되어 설치 직후 알림과 *검토*가 뜸. 위의 승인 유지 불변식은 필수 설치가 넘는 유일한 전제 조건이고, `approval-pending`이 그 예외를 눈에 보이게 함 |
| 폐기 | 필수: 폐기된 버전은 설치하지 않음 |
| 호환성(`row.choice.state === "candidate"`, `run.ts:150-153`)과 다운그레이드 금지(`updateFor`) | 필수 |
| 유휴 게이트(§18.7.4) | 부팅 때도 필수 |
| 세 번 실패 후 중단 | 해당 없음: 실패하는 필수 설치는 적용 확인마다 다시 시도하고 `failed`로 보임 |

아직 없는 패키지의 첫 설치(새 기본 설치나 필수 설치, §10.2)는 지금의 부팅 경로
(`service.ts:1004-1039`)를 유지합니다: 실행 중인 세대를 바꾸지 않으므로 턴을 끊을 수
없습니다.

#### 18.7.3 동의: 절대 자동 적용하지 않는 것

업데이트는 **동의 지문**이 설치된 **기준선**과 같을 때만 자동 적용합니다. 좁아지는
것을 포함해 어떤 차이든 업데이트를 `needs-review`로 만듭니다.

**지문.** `src/marketplace/updates/consent.ts`의 새 `consentFingerprint(kind, subject)`는
타입이 있는 기록을 돌려주고, 이것을 키를 정렬한 정규 JSON으로 직렬화합니다:

| 종류 | 필드 |
|---|---|
| `plugin`(익스텐션) | `minAppVersion`; `hostProtocol`; 모든 `PluginAuthority` 필드(`capabilities`, `networkAccess`, `hostSecrets`, `pluginAccess`, `auth`, `requires.capabilities`, `dependencies`, `sandbox`); 엔트리 형태(`entry`나 `process`); 번들 기여 종류의 집합; 로컬 ID별 모든 번들 MCP 서버와 훅의 **승인 다이제스트**; `process` 엔트리는 아래의 패키지 다이제스트 |
| `agent-plugin` | `minAppVersion`; `hostProtocol`; 있는 구성 요소 종류의 집합; 이름별 모든 MCP 서버와 로컬 ID별 모든 훅의 승인 다이제스트; `mcpAuth`(`extensions-and-plugins.md` §5.2, 결정 18) |
| `mcp` | 해석된 런타임 명세(§5.2): 전송, 명령, 인자, 환경 이름과 고정 값, URL, 로그인 필드, docker 옵션, 버전을 포함한 패키지나 이미지 |
| `provider` | `minAppVersion`, `providerId`, `baseUrl` |
| `messaging-connection` | `minAppVersion`, `connection.json` 전체 |
| `skill`, `agent`, `theme`, `font`, `language` | `minAppVersion` |

- 소유자의 목록입니다: 새롭거나 바뀐 권한과 부여(권한 필드), 바뀐 MCP 서버나 훅,
  `sandbox`, 프로토콜이나 `minAppVersion` 변경, 새 구성 요소 종류.
- `mcp` 패키지는 버전이 명령의 일부이므로 모든 `mcp` 업데이트는 검토가 필요합니다.
- **로컬 실행 구성 요소**: stdio MCP 서버, 명령 훅, `process` 엔트리. 이것이 없는
  패키지 — 스킬, 프롬프트, 에이전트 프로필, 루틴 템플릿, 원격 MCP 서버, 코드가 선언된
  권한 아래 프로세스 내 엔트리로만 도는 익스텐션 — 는 바뀐 텍스트와 데이터를 자동
  적용합니다: `extensions-and-plugins.md` 결정 18이 별도 동의 없이 활성화하고, 루틴
  템플릿은 아무것도 만들지 않습니다.
- 로컬 실행 구성 요소가 **하나라도** 있는 패키지는 파일이 **어떻게** 바뀌든 검토가
  필요합니다(아래). 검토는 건너뛰지 않고 싸게 만듭니다(§18.7.3 "차이").

**승인 다이제스트.** 실행되는 것과 그것이 읽을 수 있는 모든 것을 덮습니다. 정적
지문(`plugin-contributions.ts:249-271`)은 선언된 디스크립터 파일만 해시하고, 고정 지문은
argv에 있는 경로만 덮습니다(`plugin-bundled-command.ts:37-71`). 바뀌지 않은 서버가 패키지의
다른 파일을 읽어 평가하는 것을 막는 런타임 경계는 없습니다: 승인된 `server.js`는
`skills/helper/assets/rules.txt`를 평가할 수 있고, 콘텐츠 규칙은 그런 자원을 허용합니다
(`content/rules.ts:45-69`). 그래서 확장자, 위치, 실행 비트로 빼는 패키지 파일은 없습니다.
번들 MCP 서버와 훅마다 `src/plugins/contribution-approval-digest.ts`의 새
`approvalDigest(component, generationRoot)`는 다음 정규 JSON의 sha256입니다:

```
{ declaration: <static fingerprint, plugin-contributions.ts:269-271>,
  anchored:    <the identities anchorBundledCommand hashes:
                "<argv index>\0<relative path>\0<sha256(file)>", sorted
                (plugin-bundled-command.ts:53-71)>,
  closure:     { kind: "package",  treeSha256 }       // local code
             | { kind: "launcher", spec, treeSha256 } // pinned runtime package
             | { kind: "remote" } }                   // url transport; nothing local runs
```

- **`treeSha256`**은 패키지에 설치된 **모든** 페이로드 파일에 대한 트리 다이제스트(§6.4,
  영수증의 `artifactSha256` 뒤의 알고리즘)이며, **정규화는 정확히 하나**입니다:
  `plugin.json`을 해시하기 전에 최상위 `version` 필드를 지웁니다(파일을 파싱해 필드를
  지우고 나머지를 키를 정렬한 정규 JSON으로 직렬화). 다른 정규화 필드는 없습니다. 릴리스는
  그 필드를 바꿔야 하고(`plugins/marketplace.ts:635-642`), 그 필드는 실행되는 것을 아무것도
  바꾸지 않습니다. 콘텐츠 패키지는 디스크립터 `ave-package.json`이 설치되지 않으므로
  (`content/store.ts:114-128`) 정규화가 필요 없습니다.
- **`launcher` 클로저.** `npx`, `bunx`, `uvx`, `pipx run`, `docker run`의 명세는 변하지 않는
  산출물을 가리킵니다: 정확한 버전의 npm·PyPI(`name@1.2.3`, `name==1.2.3`), 또는
  `@sha256:` 다이제스트의 OCI 이미지. 패키지 파일을 여전히 읽을 수 있으므로
  `treeSha256`도 위처럼 포함합니다.
- **`remote`**: 로컬 실행 구성 요소가 없는 패키지의 url 전송 구성 요소. 로컬 구성 요소도
  있는 패키지의 원격 구성 요소도 `remote`로 남습니다: 로컬에서 아무것도 실행하지 않고,
  로컬 구성 요소의 다이제스트가 이미 트리를 덮습니다.
- **정할 수 없음.** 실행 클로저를 정할 수 없으면 승인 다이제스트는 `null`입니다.
  변하지 않는 핀이 없는 런처 명세(`npx foo`, `foo@latest`, 이미지 태그),
  `anchorBundledCommand` 실패, 이 목록에 없는 명령 종류가 그렇습니다. `null`은 무엇과도
  같지 않습니다: 그 구성 요소는 이어가기가 없고, 업데이트마다 다시 묻고, 지문이 늘
  달라서 업데이트는 검토가 필요합니다. 닫힌 쪽으로 실패합니다.
- `process` 엔트리는 같은 `treeSha256`으로 익스텐션 지문에 들어가므로, `process`
  익스텐션은 어떤 변경이든 검토가 필요합니다.

**기준선 저장.** 기준선은 사용자가 받아들인 지문이며, 설치와 함께 저장합니다. 새로
가져온 카탈로그 메타데이터에서 끌어내지 않습니다. `planUpdate`는 설치된 버전에 대한
현재 카탈로그의 사본을 우선하던 것(`service.ts:795-797`)을 그만두고 기준선을 읽습니다.

| 종류 | 저장 위치 |
|---|---|
| `plugin` | 영수증의 `git`이나 `folder` 기록에 `consent` 추가(`plugin-install-receipt.ts:86-100`); 선택 필드라 기존 영수증도 유효 |
| 콘텐츠 종류 | `LedgerEntry.origin.consent`(`content/ledger.ts:22-48`; `ORIGIN_KEYS`에 선택 필드 `consent` 추가) |
| `mcp` | `~/.ave/packages/mcp-installs.json`의 기록(`app/mcp-installer.ts:38-62`)에 `consent` 추가 |

**기존 설치**(저장된 기준선 없음)는 카탈로그가 아니라 설치된 것에서 계산합니다:

- `plugin`: 영수증이 덮는 `plugin.json`과 페이로드.
- 콘텐츠: 설치된 패키지 디렉터리. `minAppVersion`은 보존된
  `snapshots/<origin.commit>.json`에 있는 설치 버전의 인덱스 행에서 가져옵니다. 사용자가
  설치할 때의 카탈로그이고, 스냅숏 보존(§2.1)이 남겨 둡니다. 설치 자체는
  `ave-package.json`을 버립니다(`content/store.ts:114-128`).
- `mcp`: 기록된 런타임 명세.

계산할 수 없는 필드 — 스냅숏이 없거나, 설치 뒤 폴더가 바뀐 폴더 설치 — 는
`unknown`입니다. `unknown`은 무엇과도 같지 않으므로 첫 업데이트는 검토가 필요하고, 그것을
적용하면 완전한 기준선이 저장됩니다. 성공한 설치나 업데이트는 자동이든, 검토했든,
필수든 영수증이나 원장 항목과 같은 트랜잭션에서 새 기준선을 씁니다.

**두 검사 지점과 차이.**

- **첫째, 카탈로그.** 버전의 인덱스 사본이 담는 필드는 *카탈로그에서 보이는* 필드입니다
  (§2.2). 카탈로그에서 보이는 차이는 다운로드 없이 업데이트를 `needs-review`로 둡니다.
  카탈로그가 담지 않는 필드는 `pending`이며, 결코 "같음"이 아닙니다.
- **둘째, 스테이징된 바이트.** 첫째에서 차이가 없을 때만, 활성화 전에 돕니다.
  `installGitPlugin`은 `assertManifest`(`plugins/marketplace.ts:635-643`) 옆에서 도는
  `assertConsent` 콜백을 받습니다. 콜백은 스테이징된 트리에서 승인 다이제스트까지 포함한
  전체 지문을 계산하고, `activatePreparedArtifact` 전에 `UpdateNeedsReviewError`를
  던집니다. 콘텐츠는 원장을 쓰기 전에 스테이징된 패키지로 같은 검사를 합니다. 아무것도
  활성화하지 않고, 스테이징된 파일은 버립니다. 패스가 `UpdateNeedsReviewError`를 직접
  잡아(`installZipTransaction`은 그것을 다시 던짐, `plugins/marketplace.ts:831-836`,
  `:862-878`) `needs-review`를 기록합니다. 동의 보류는 실패가 아니며 시도로 세지 않습니다.
- **수동 검토는 늘 스테이징합니다.** 차이에 `pending` 필드가 하나라도 있는 모든 수동
  검토는, 첫째 지점이 무엇을 찾았든, 승인을 내놓기 **전에** 폴더 계획처럼(§18.4.2)
  산출물을 내려받고 검증해 계획에 스테이징하고 전체 지문을 계산합니다. 그래서 카탈로그에서
  보이는 권한과 번들 훅을 함께 더하는 업데이트는 둘 다 보여 줍니다. 계획은 스테이징된
  다이제스트를 기록하고, `executeInstall`은 바로 그 바이트를 설치하며 다시 내려받지
  않으므로, 승인은 설치되는 바이트를 덮습니다. 만료된 계획(§13.1)은 새 검토를 뜻합니다.
- **차이.** 타입이 있는
  `ConsentDelta = Array<{ field: ConsentField; checkpoint: "catalog" | "staged"; before: Json | "unknown"; after: Json; changedFiles?: { code: string[]; nonCode: string[] } }>`
  이며, `ConsentField`는 위 표의 모든 행을 이름으로 가리킵니다. 예를 들면
  `authority.networkAccess`, `entryForm`, `mcpServer:<localId>`, `hook:<localId>`,
  `mcpRuntime`, `connection`입니다. 스테이징 뒤에는 `after`가 pending인 항목이 없습니다.
  `UpdatePlanView`에 `consentDelta`를 더합니다. 기존 `authorityDelta`와
  `componentsDelta`(`service.ts:799-810`)는 이것의 투영이 됩니다.
- **코드 없는 변경의 싼 검토.** `changedFiles`는 바뀐 승인 다이제스트에 대해 바이트가 다른
  패키지 경로를 나열하며, `treeSha256`과 **같은 정규화 하나**로 비교합니다: `plugin.json`은
  최상위 `version`을 뺀 채 비교하고, 나머지가 다를 때만, 그리고 언제나 `code`로 나열합니다.
  그래서 `SKILL.md`만 고친 버전 올림 릴리스는 `SKILL.md` 하나만 나열합니다. 렌더러는 표시만을 위해 나눕니다: `nonCode`는 Markdown, 일반
  텍스트, 이미지, `plugin.json` 밖의 JSON이고 `code`는 나머지입니다. 다른 필드가 승인
  다이제스트뿐이고(`minAppVersion`은 그대로) 모든 `changedFiles.code`가 비어 있으면, 검토는
  "코드가 아닌 이 파일들만 바뀌었습니다:"와 목록의 한 행, 그리고 *업데이트 승인* 동작 하나를
  보여 줍니다. 그 동작은 패키지의 바뀐 구성 요소를 한 번에 모두 승인합니다. 이 구분은
  자격을 정하지 않고 검토를 줄일 뿐입니다.
- **그 밖에는** 검토가 항목마다 행 하나를 그립니다: 필드의 지역화 라벨, 이전과 이후, 그리고
  `mcpServer:`와 `hook:` 행에는 명령, 클로저 종류, 바뀐 파일을 담은 승인 체크 상자.
- **익스텐션 구성 요소.** 지금 `executeInstall`은 에이전트 플러그인이 아닌 것의 구성 요소
  동의를 거부합니다(`service.ts:826-827`). 슬라이스 F부터 `plugin`에도 번들 로컬 ID로
  받고, 플러그인 설치기는 그것을 `PluginBundleLifecycle`에 넘겨 새 세대의 `mcpTrust`와
  `hookTrust`에 승인합니다.

**승인 이어가기.** 지금 신뢰 저장소는 정확한 세대를 키로 쓰고 "승인은 세대를 넘어가지
않습니다"(`plugin-contribution-trust.ts:7-13`, `:31`). 그래서 업데이트마다 모든 번들
서버와 훅을 다시 묻습니다.

- **스키마.** 신뢰 파일은 `{ version: 2 }`에서 `{ version: 3 }`이 됩니다. 각 기록에
  `approvalDigest: string | null`과 선택적 `carriedFrom: <generationId>`가 붙습니다. 로더는
  버전 2를 지금처럼 엄격하게(`:40-53`), 버전 3도 엄격하게 받고, 다른 버전은 지금처럼
  실패합니다. 다음 쓰기는 버전 3입니다.
- **버전 2 기록 이관.** 0.13.0 다음 릴리스가 저장소를 처음 읽을 때 한 번 합니다(명시한 결정 39).
  기록의 세대가 그 플러그인의 활성 세대이고, 지문이 그 설치된 세대의 선언에서 계산한
  지문과 같으면, `approvalDigest`를 설치된 바이트에서 계산합니다. 사용자가 승인했고 지금
  실행 중인 바이트이며, v2 식별이 이미 그것을 묶고 있습니다(세대 ID는 영수증이 덮는 모든
  바이트를 확정함). 그 밖의 v2 기록은 `approvalDigest: null`입니다. null 기록은 이어질 수
  없으므로, §18.7.2의 전제 조건에 따라 그 패키지의 첫 업데이트는 "이전 Ave 버전의 승인을
  확인해야 합니다"라는 이유의 명시적인 일회성 `needs-review`입니다.
- **준비.** 플러그인 P의 새 세대 G′를 준비할 때, 활성 세대 G가 같은 플러그인 ID와 로컬
  ID, 그리고 c′의 것과 같은 null 아닌 `approvalDigest`를 가진 승인 기록을 갖고 있으면
  구성 요소 c′를 이어 갑니다. 이어 가는 구성 요소는 `carriedFrom: G`인 G′의 **임시**
  승인을 받습니다. MCP 허용이 준비 중에 일어나므로(`agent-plugin-mcp-runtime.ts:117-125`)
  준비 전에 씁니다. 새 승인과 같은 목록에 들어갑니다.
- **게시.** 수명 주기의 직렬화 아래에서, 활성 세대가 바뀌기 전에 임시 기록마다 다시
  검증합니다: G가 아직 활성이고 원래 기록이 아직 승인되어 있어야 하므로, 그 사이의
  철회는 되살아나지 않습니다. 검증에 실패한 기록은 철회하고 게시를 포기하며, 자동
  업데이트는 `needs-review`가 되어 §18.7.2의 불변식이 지켜집니다.
- **실패.** 준비나 게시가 실패하면 모든 임시 기록을 새 승인을 이미 철회하는 경로로
  철회합니다(`agent-plugin-mcp-runtime.ts:126-133`; 훅 런타임은
  `agent-plugin-hook-runtime.ts:134-139`). 저장소는 시도 전과 정확히 같아집니다.
- **두 경로 모두 구현합니다:**
  - 익스텐션: `PluginBundleLifecycle`(`plugin-bundle-lifecycle.ts:136-190`, `hookTrust`와
    `mcpTrust` 소유)에서, `plugin-mcp-projection.ts`와 `plugin-hook-projection.ts`로;
  - 에이전트 플러그인: `AgentPluginMcpRuntime.publishOne`
    (`agent-plugin-mcp-runtime.ts:86-137`)과 `AgentPluginHookRuntime`
    (`agent-plugin-hook-runtime.ts:101-145`)에서.
- 자동이든, 검토했든, 필수든 모든 업데이트에 적용합니다. 정책 지문 승인은 그대로입니다.

#### 18.7.4 턴을 끊지 않고 적용하기

- **부팅을 포함한 유휴 게이트.** 자동·필수 업데이트는
  `ConversationActivityCoordinator.isBusy()`가 거짓일 때만 시작합니다
  (`conversation-activity-coordinator.ts:97-100`). 전환 허용, 세션 전환, 활성 턴, 세션
  변경이 모두 없다는 뜻입니다. 게이트는 부팅 때도 다른 때와 똑같이 적용합니다. 시작 순서에
  기대지 않습니다: 메인 인터페이스가 `startBackground()`보다 먼저 로드되고, 그 호출은
  기다리지 않습니다(`main.ts:514-538`). 실행 직후에는 보통 게이트가 바로 통과합니다.
  - 지금은 끝난 턴만 알립니다(`:112-115`). 변경 완료(`:123-129`)와 전환 허용
    해제(`:150-152`)는 아무것도 알리지 않습니다. 슬라이스 F가 `onIdle(listener)`를 더해,
    네 조건 중 어느 것에서든 `isBusy()`가 거짓이 될 때마다 부릅니다.
  - 큐는 먼저 구독한 뒤 `isBusy()`를 다시 확인하므로, 확인과 구독 사이의 유휴 순간을
    놓치지 않습니다.
  - 게이트는 패키지마다 읽습니다. 패키지를 적용하는 동안 시작한 턴은 막지 않고, 적용은
    대화 리스를 쥐지 않습니다.
- **상한이 아니라 단계 올림.** 유휴를 30분 기다린 큐는 "업데이트 <n>개가 대화가 멈추기를
  기다립니다" 알림을 *지금 적용*과 함께 게시합니다. *지금 적용*은 사용자의 결정이며 유휴
  게이트만 건너뛰고, 아래의 리스는 진행 중인 호출을 계속 보호합니다. 그것이 없으면 큐는
  얼마가 걸리든 계속 기다립니다. 종료하면 큐는 버려지고, 다음 부팅의 적용 확인이 다시
  분류합니다.
- **익스텐션은 업데이트가 적용되는 순간 다시 시작합니다.**
  - 새 세대는 검증된 스테이징 트리에서 준비·시작하고(`activatePreparedArtifact`,
    `runtime/index.ts:4789`) 게시합니다.
  - 이전 세대는 인스턴스 리스가 풀리고(`withPluginInstanceLease`,
    `runtime/index.ts:3255-3262`) HostApi 작업이 비워진 뒤(10초, `runtime/index.ts:1636`,
    `:2135-2150`) 물러납니다.
  - 게시 뒤에 시작한 루틴이나 하위 에이전트의 호출은 같은 권한으로 새 세대에서 돕니다.
- **에이전트 플러그인의 MCP 서버와 훅.**
  - **지금.** `publishOne`은 대체를 게시한 직후 이전 세대를 끊습니다
    (`agent-plugin-mcp-runtime.ts:135-136`, `mcp-manager.ts:622-627`, `:650-656`을 거쳐). 번들
    MCP 호출은 `withBundledLease`(`mcp-manager.ts:1326-1340`)를 잡지만, 그것은 부팅이
    `PluginBundleLifecycle`에 연결한 `generationAccess`(`boot.ts:824`)에 묻고, 그 조정자에는
    에이전트 플러그인 세대가 없어 거부됩니다(`plugin-generation-coordinator.ts:212-217`).
    훅은 이미 `agent-plugin/` 소유자를 훅 런타임 자신의 리스 원천으로 보내고
    (`script-hook-manager.ts:169-172`, `:542-546`), 그 원천은 활성화마다 리스를 세고
    비웁니다(`agent-plugin-hook-runtime.ts:31-39`, `:61-63`).
  - **소유자.** 슬라이스 F가 MCP에 같은 모양을 줍니다:
    - 훅 매니저의 것을 따라 `McpManager.registerGenerationLeaseSource(prefix, acquireExact)`를
      더합니다.
    - **획득 도우미 하나.** 비공개 `acquireOwnerLease(owner)`가 등록된 접두사 중 가장 긴
      것으로 소유자를 보내고, 없으면 `generationAccess`로 갑니다. 이것이 직접
      `generationAccess.acquireExact`를 부르는 **두 곳**을 모두 대신합니다: `bindBundledTool`이
      모든 번들 도구(`:424`, `:471`)에 만드는 등록 도구의 `execute`
      (`mcp-manager.ts:1308-1314`), 그리고 `withBundledLease`(`:1326-1340`). 어느 쪽도 자기
      획득을 따로 두지 않습니다.
    - `AgentPluginMcpRuntime`이 `agent-plugin/`을 등록하고 자기 리스를 소유합니다: 훅
      런타임처럼 활성화별 개수와 비우기 대기자.
    - **허용은 게시 때 닫힙니다.** 이전 활성화는 서버를 게시 해제하기 전에 물러난 것으로
      표시되고, 물러난 활성화의 `acquireExact`는 훅 런타임처럼
      (`agent-plugin-hook-runtime.ts:34`) 예외를 던집니다. 그래서 새 호출은 새 세대로
      갑니다.
    - `waitForDrain(activationId)`는 개수가 0이 되면 끝납니다.
  - **물러남.** 이전 세대는 비워진 뒤에만 끊으며, `:136`의 즉시 끊기를 대신합니다. 비우기는
    각 호출의 도구 시간 제한을 상한으로 합니다. 큐도 현재 활성화가 리스를 하나도 쥐지 않을
    때만 에이전트 플러그인을 적용하고, 아니면 업데이트는 `waiting`으로 남습니다.
  - **페이로드 디렉터리는 설치 주소를 쓰며, 자기 이름 공간에 둡니다.** 지금은 같은 버전
    재설치 — 모든 폴더 새로 고침이 그렇습니다 — 가 활성화 전에 실행 중인 버전 디렉터리를
    옆으로 옮기고(`content/store.ts:247-249`, `:286-294`) 스크래치 디렉터리와 함께 지웁니다
    (`:306-310`). 그러면 이전 세대의 서버나 훅이 실행 중에 경로를 잃습니다. 슬라이스 F부터:
    - 모든 설치는 `installId`(무작위 UUID)를 만들고 새 디렉터리
      `<root>/<kind>/<name>/.installs/<installId>/`에 씁니다. `LedgerEntry.origin`에
      `installId`와 `payloadDir`를 더합니다. 버전 디렉터리 이름은 첫 글자가 문자나 숫자인
      `SAFE_VERSION`에 맞아야 하므로(`content/store.ts:173`, `:248`), 앞의 `.`가 이 이름 공간을
      이전 버전 디렉터리와 겹치지 않게 합니다. `payloadDir`가 없는 항목은 이전 설치이며
      `<version>/` 경로를 유지합니다. 새 페이로드는 `<version>/` 아래에 쓰지 않습니다;
    - 살아 있는 세대가 쓰는 것은 옮기거나 덮어쓰지 않습니다;
    - `activation.activate`는 `{ retired: Promise<void> }`를 돌려줍니다. 그 약속이 끝나면
      저장소는 **물러난 설치 자신의 디렉터리만** 지웁니다: 설치 주소 항목은 그 `payloadDir`,
      이전 항목은 그 `<version>/`이며, 이전 `<version>/`은 그 이전 설치가 물러난 것일 때만
      지웁니다. 이 일은 저장소의 직렬화 밖에서 합니다;
    - 지우기가 실패하거나 그 전에 종료하면 §18.7.4 표의 부팅 정리가 치우며, 어떤 원장 항목도
      가리키지 않는 `.installs/<installId>/`와 어떤 이전 원장 항목도 가리키지 않는
      `<version>/`을 지웁니다.

    에이전트 플러그인 런타임은 이미 디렉터리가 바뀌면 새 세대로 보므로
    (`agent-plugin-mcp-runtime.ts:105`) 모든 설치가 새 세대입니다.
- **원자적이고, 결과가 정해져 있음.** 패키지마다 자기 트랜잭션이고, 패스는 전부 아니면
  전무가 아닙니다. 플러그인은 `installGitPlugin`과 `installZipTransaction`
  (`plugins/marketplace.ts:592`, `:770`)을, 콘텐츠는 §5.5의 설치를 거칩니다. 패스가 그
  호출이 던지는 것을 분류합니다:

  | 결과 | 위치 | 이후 설치된 것 | 업데이트 상태 | 시도로 셈 |
  |---|---|---|---|---|
  | 동의 보류 | 둘째 검사 지점의 `UpdateNeedsReviewError`, 또는 재검증에 실패한 이어진 승인 | 이전 버전, 그대로 | `needs-review` | 아니요 |
  | 커밋 전 실패 | 다운로드, 검증, 준비, 영수증 쓰기(`plugins/marketplace.ts:862-878`, `:894`); 원장 트랜잭션 안의 콘텐츠 활성화 | 이전 버전이 계속 실행; 영수증, 레지스트리 항목, 원장 복원 | 코드와 detail을 담은 `failed` | 예 |
  | 영속 커밋 뒤의 게시 실패 | `CommittedPluginGenerationPublicationError`(`committed-generation-publication-error.ts:4-27`), 일부러 되돌리지 않음(`plugins/marketplace.ts:899-900`) | **새** 버전이 커밋됨. `outcome.state: "active"`면 활성 세대, `"inactive"`면 설치되었지만 실행 안 됨 | `"active"` → `applied`; `"inactive"` → `applied-not-running`. 새 기준선 저장 | 아니요; 다시 설치할 것이 없고, 회복은 런타임 몫(다음 부팅이 커밋된 세대를 활성화) |
  | 물러남이나 정리 실패 | 이전 세대 물러남(`PluginRetirementJournal`), 이전 콘텐츠 디렉터리 | 새 버전, 활성 | `applied`; 실패는 로그 | 아니요; 플러그인 물러남은 부팅 때 저널에서 이어서 하고(`recoverRetirements`, `plugin-bundle-lifecycle.ts:280-297`), 슬라이스 F는 어떤 원장 항목도 가리키지 않는 콘텐츠 페이로드 디렉터리를 지우는 부팅 정리를 더함 |
  | 성공 | — | 새 버전, 활성 | `applied`, 또는 구성 요소를 승인 없이 남긴 필수 설치는 `approval-pending`(§18.7.2) | — |

  표시하는 설치 버전은 늘 커밋된 영수증이나 원장 항목에서 오며, 시도의 목표 버전에서
  오지 않습니다.
- **순서**: 플러그인은 의존 순서(`dependency-resolver.ts`)로, 나머지는 키 순으로, 한 번에
  하나씩.

#### 18.7.5 상태, 실패, 오프라인, 건너뛰기, 폐기

아래 상태는 모두 `UpdateStatusView.packages[].state`(§18.9)의 멤버이며, 표와 타입은 같은
여덟 개를 나열합니다.

| 상태 | 의미 | 표시 |
|---|---|---|
| `automatic` | 이번 적용 확인에서 적용 | 실행 중 업데이트 카드 |
| `waiting` | 자동이나 필수, 유휴나 에이전트 플러그인의 호출을 기다림(§18.7.4) | 업데이트 카드, 패키지 행; 30분 뒤 *지금 적용*이 있는 알림 |
| `needs-review` | 지문이 다르거나, 필드가 `unknown`이거나, 전에 승인된 구성 요소가 승인을 잃게 되거나, 둘째 검사 지점이 보류함(§18.7.3) | 알약, 업데이트 카드, 행, *검토* |
| `manual` | 자동 업데이트가 꺼져 있음 | 알약(업데이트 알림이 켜져 있을 때), 행, *업데이트* |
| `failed` | 마지막 시도가 커밋 전에 실패: `code`, `detail`, `attempts` | 알약, 업데이트 카드, 행, *다시 시도*, *자세히* |
| `applied` | 자동이나 필수 업데이트가 설치함 | 알림의 "자동으로 업데이트됨", 카드의 최근 목록 |
| `applied-not-running` | 커밋되었지만 세대가 시작하지 못함(§18.7.4) | 알약, 행 "설치됨, 실행 안 됨 — Ave를 다시 시작하세요" |
| `approval-pending` | 필수 업데이트가 MCP 서버나 훅을 승인 없이 설치해 그 구성 요소가 실행되지 않음(§18.7.2) | 알약, 행, 설치 직후 "조직이 <이름>을 업데이트했고 구성 요소 <n>개가 승인을 기다립니다" 알림과 *검토* |

`skipped`는 보기의 상태가 아닙니다: 건너뛴 버전은 적용하지도 보이지도 않고, 다음 버전은
그렇습니다.

- **`approval-pending`의 검토**는 기존 승인 화면을 다시 씁니다:
  - **두 화면 모두 승인을 검토한 것에 묶습니다.** 검토는 설치된 세대 하나를 보여 주는데,
    사용자가 제출하기 전에 필수 업데이트가 그것을 바꿀 수 있고, 구성 요소 다이제스트만으로는
    패키지 트리 전체를 덮지 못합니다(`agent-plugin-components.ts:57-73`). 그래서 모든 승인
    요청은 검토한 세대와, 구성 요소마다 검토가 보여 준 `approvalDigest`(`string | null`,
    §18.7.3)를 담습니다. 핸들러는 무엇이든 승인하기 전에, **설치와 게시가 쓰는 직렬화
    아래에서** 둘 다 설치된 세대와 다시 대조합니다. 하나라도 다르면 아무것도 승인하지 않고
    `PLAN_EXPIRED` 사유 `package-changed`(§18.8)로 실패합니다: "검토한 뒤 패키지가
    바뀌었습니다. 다시 검토하세요." 그러면 검토가 다시 읽힙니다. 다이제스트가 `null`인 구성
    요소는 세대만으로 묶입니다: 검토한 세대(에이전트 플러그인은 `installId`, 익스텐션은
    산출물 세대 id)가 설치된 것과 정확히 같아야 하고, 그것은 산출물 하나만 가리킵니다(아래).
  - **익스텐션**: *검토*는 `PluginConfigTab.tsx`에서 플러그인의 신뢰 행을 엽니다. 그 탭은
    `ave:plugins:contribution-trust:list`로 나열하고 `ave:plugins:contribution-trust:set`으로
    승인합니다(`ipc/domains/plugins.ts:541-589`, preload `internal-api-surface.ts:527-534`).
    기존 요청을 넓히며, 나란한 채널은 더하지 않습니다:
    - 나열 행(`PluginContributionTrustRow`, `plugin-bundle-lifecycle.ts:141-149`)에
      `approvalDigest`를 더합니다. 행의 `generationId`는 이미 투영의 `owner.generationId`이고,
      투영은 이것을 코디네이터의 세대 id가 아니라 **산출물** 세대 id(`artifactGenerationId`,
      `plugin-mcp-projection.ts:206-212`, `plugin-hook-projection.ts:78`)로 채웁니다;
    - `approved: true`인 `set` 요청은 보여 준 행의 `generationId`와 `approvalDigest`를 담아야
      하며, 없으면 핸들러는 `invalid-contribution-trust-request`(`plugins.ts:573`)를
      돌려줍니다. 철회(`approved: false`)는 신뢰를 좁히기만 하므로 둘 다 받지 않습니다;
    - `approveHook`과 `approveMcpServer`가 그 묶음을 받고, `updateHookTrust`/`updateMcpTrust`가
      새 세대 게시가 쓰는 직렬화인 `serialize(pluginId)` 안에서
      (`plugin-bundle-lifecycle.ts:355-357`, `:383-385`) 확인합니다: 활성 투영의
      `owner.generationId`, 곧 활성 세대의 `artifactGenerationId`가 `generationId`와 같고,
      투영의 승인 다이제스트가 `approvalDigest`와 같아야 합니다. 코디네이터의 세대
      id(`generation.generationId`)는 `runtime.activationId`도 해시하므로
      (`plugin-bundle-lifecycle.ts:546-551`) 같은 산출물을 다시 활성화하면 바뀝니다. 그것은
      활성화 식별(`owner.activationId`)로 남고 비교하지 않습니다. 산출물 세대 id는
      `plugin.json`과 설치 영수증을 해시하므로(`:546`) 검토한 산출물을 가리킵니다.
      다르면 `contribution-trust-review-stale`을 돌려주고, 탭은 같은 카탈로그 문장을 보여 준
      뒤 행을 다시 읽습니다.
    - `UpdateStatusView`의 익스텐션 `approval-pending` 항목은 `pendingApproval`을 담지
      않습니다: 그 검토는 위의 신뢰 목록을 읽습니다.
  - **에이전트 플러그인**: *검토*는 업데이트 검토(§15.6)를 구성 요소 모드로 열어,
    `UpdateStatusView`에 있는 패키지의 `pendingApproval`(§18.9, 에이전트 플러그인의
    `approval-pending` 항목에만 있음)에서 승인 없는 구성 요소의
    `consentDelta` 행을 보여 줍니다. 승인 동작은 새 채널
    `ave:marketplace:components:approve` `(key, installId, consents: ReviewedComponentConsent[])`를
    부르며, 각 동의는 기존 `ComponentConsent`(`shared/git-marketplace.ts:400-412`)에 보여 준
    `approvalDigest`를 더한 것입니다. 핸들러는 `ipc/domains/git-marketplace.ts`에 있습니다.
    서비스가 콘텐츠 저장소로 넘기면, 저장소는 설치 직렬화(`content/store.ts:253`) 안에서
    원장 항목의 `origin.installId`가 `installId`와 같은지, 그 항목의 `payloadDir`로 계산한
    각 구성 요소의 승인 다이제스트가 동의의 것과 같은지 확인합니다. 그런 뒤에만 설치된 세대에
    그 동의를 담아 `AgentPluginMcpRuntime.activate`와 `AgentPluginHookRuntime.activate`를
    부릅니다(`agent-plugin-mcp-runtime.ts:139-142`, `agent-plugin-hook-runtime.ts:144-146`).
    그 메서드들은 이미 자기 직렬화 아래에서 승인하고 게시하며, 각 동의의 구성 요소
    다이제스트도 계속 확인합니다(`agent-plugin-mcp-runtime.ts:91-97`). `installId`는 페이로드
    디렉터리 하나만 가리키고, 그 안의 것은 덮어쓰지 않습니다(§18.7.4).
  - 설치된 세대에 승인 없는 구성 요소가 없어지면 상태가 풀립니다.
- **오프라인**: 모든 소스가 `SOURCE_UNREACHABLE` 사유 `offline`으로 실패하면 탐색 결과는
  `offline`이고 아무것도 적용하지 않으며, 카드는 "오프라인 — 마지막 확인 <시각>"을 보여
  줍니다. 다음 한 시간 기한 확인에서 다시 시도합니다(§18.7.1).
- **소스 실패**: 그 패키지는 이번 패스에서 빠집니다. 소스 행은 detail을 담은 상태를
  보여 주고(§18.8), 패키지 행은 "소스에 닿을 수 없음 — 설치된 버전을 보여 줍니다"라고
  말합니다.
- **커밋 전 업데이트 실패**: 이전 버전이 남습니다. 상태는 코드, detail, 시도 횟수를 담은
  `failed`이고 다음 적용 확인에서 다시 시도합니다. 한 버전이 세 번 실패하면 더 새 버전이나
  *다시 시도* 전까지 그 버전의 자동 시도를 멈춥니다. 필수 설치는 예외입니다(§18.7.2). 동의
  보류와 커밋 뒤의 실패는 시도가 아닙니다(§18.7.4 표).
- **적용됨**: 알림(§15.1)의 "자동으로 업데이트됨" 아래에 버전과 *바뀐 점*(§15.6의 커밋
  범위)으로 한 번 나열합니다. `BootInstallNoticeView`(`shared/git-marketplace.ts:373-384`)에
  `autoUpdated`를 더합니다.
- **알약**(`PluginUpdatesPill.tsx`)은 사용자가 필요한 업데이트만 셉니다: `needs-review`,
  `failed`, `applied-not-running`, `approval-pending`, 그리고 업데이트 알림이 켜져 있을 때
  `manual`. `updateCheckEnabled`는 의미(알림이 렌더러에 닿는지)를 유지하고 자동 업데이트를
  켜고 끄지 않습니다.
- **롤백**: 나열된 이전 버전을 손으로 설치하면(§16.2) 떠난 버전을 건너뜀으로 기록해,
  다음 패스가 롤백을 되돌리지 않습니다.
- **폐기**는 설정과 무관하게 모든 탐색에서 업데이트보다 먼저 적용합니다. 업데이트는
  폐기된 버전을 목표로 삼지 않습니다(§6.1 6단계). 폐기로 꺼진 패키지는 자동으로
  업데이트하지 않고, 그 알림이 한 번 클릭으로 검토에 들어가는 업데이트를 제안합니다.

#### 18.7.6 폴더 소스

폴더 패키지는 소스의 리비전이 바뀌었고 트리 다이제스트가 설치된 `artifactSha256`(플러그인)
이나 `contentSha256`(콘텐츠)과 다를 때 업데이트가 있습니다.

- 선언 버전이 높으면 업그레이드입니다.
- 같으면 **새로 고침**이고, 업그레이드처럼 적용합니다.
- 낮으면 다운그레이드이고, 손으로만 제공합니다.

기본은 켬(§18.7.2)이고 동의(§18.7.3)는 그대로 적용합니다.

### 18.8 메시지: 모든 거부, 경고, 실패

지금 `failureText`(`labels.ts:103-118`)는 아홉 개 코드에만 문장이 있고, 나머지는
`CODE · <main의 영어 메시지>`를 출력합니다(`:116`). 0.13.0부터:

- `MarketplaceError`(`errors.ts:44-53`)에 선택적 `detail`을 더합니다: 코드별 유니언으로,
  `reason`과 문장에 필요한 값(호스트, 주소, 경로, 패턴, ref, 버전)을 담습니다. 봉투는
  `{ ok: false, code, message, detail? }`가 되고(`shared/git-marketplace.ts:393`),
  `parseGitMarketplaceResult`(`:456`)는 그 코드에 아는 `reason`의 `detail`만 남기고
  나머지는 버립니다.
- **소스 상태도 detail을 담습니다.** 백그라운드 동기화의 실패는 실패한 봉투가 아니라
  성공한 `sources:list`로 UI에 닿기 때문입니다:
  - `SyncResult`의 실패 변형에 `detail?`을 더합니다;
  - `recordFailure`(`sources/sync.ts:129-133`)가 그것을 `SourceState.lastSync.detail`
    (`sources/registry.ts:56`)에 영속합니다;
  - 상태 검증기는 사유가 그 코드에 속할 때만 `detail`을 받고, 아니면 코드는 두고
    detail만 버립니다;
  - `sourceStatus`(`app/views.ts:169-179`)가 그것을 `unreachable`과 `auth-required` 보기에
    복사합니다.
- `failureText`는 `GitMarketplaceErrorCode`와 각 사유에 대해 빠짐없어집니다(`never`
  검사, `default` 없음). 모든 코드에는 `detail`이 없을 때(이전 상태 파일, 버린 detail)
  쓰는 사유 없는 문장도 있습니다. 테스트가 `MARKETPLACE_ERROR_CODES`와 모든 사유를
  나열해, 카탈로그 문장이 없는 것이 있으면 실패합니다. main의 영어 `message`는
  *세부 정보 복사* 뒤에만 보입니다.
- 컴포넌트 하나, `MarketplaceProblem`이 세 톤을 그립니다: **정책**(자물쇠, "조직에서
  설정함", 규칙, 정책 파일 경로, *계속* 없음), **경고**(주황, 위험, *계속* / *취소*),
  **오류**(빨강, 일어난 일, 조치).
- 키: `gitMarketplace.error.<code>.<reason>`, `gitMarketplace.warning.<warning>`,
  `gitMarketplace.policy.<reason>`, `gitMarketplace.action.<action>`. 기존
  `gitMarketplace.error.policyBlocked`는 MCP 거버넌스 문장(`PACKAGE_POLICY_BLOCKED`)으로
  남고, 소스 정책 차단은 `gitMarketplace.policy.*`를 써서 둘이 섞이지 않습니다.
- 한국어는 카탈로그의 격식체(`-습니다`, `-하세요`)를 씁니다. 경고는 질문("계속할까요?")
  으로 끝납니다. 정책 문장은 사용자가 아니라 조직을 원인으로 적습니다("조직 정책이 …").

분류: **P** 정책 차단, **W** 경고, **R** 거부, **E** 고칠 수 있는 오류, **S** 상태.
모든 행은 일어난 일, 이유, 다음 조치를 담습니다. 정확한 영어·한국어 문장은 코드나
사유를 더하는 슬라이스에서 i18n 생성기(§15.9)로 씁니다. 영어 문장의 방향은 원문
표를 따릅니다.

| 코드 · 사유 | 분류 | 일어난 일과 이유(한국어 방향) | 다음 조치 |
|---|---|---|---|
| `SOURCE_POLICY_BLOCKED` · `blocked-by-pattern` | P | "조직 정책이 <대상>을 차단합니다(규칙 `<pattern>`)." | "관리자에게 문의하세요. 규칙은 <정책 경로>에 있습니다." |
| · `not-in-allow-list` | P | "조직 정책이 허용한 소스만 쓸 수 있고, <대상>은 목록에 없습니다." | 위와 같음 |
| · `https-required` | P | "조직 정책상 https만 쓸 수 있습니다." | "https 주소를 쓰거나 관리자에게 호스트 등재를 요청하세요." |
| · `private-network-blocked` | P | "조직 정책이 사내망과 이 컴퓨터의 소스를 막습니다." | 위와 같음 |
| · `local-sources-blocked` | P | "조직 정책이 폴더 소스를 허용하지 않습니다." | 위와 같음 |
| · `direct-install-blocked` | P | "조직 정책상 마켓플레이스를 거쳐서만 설치할 수 있습니다." | 위와 같음 |
| · `policy-invalid` | P | "조직의 마켓플레이스 정책을 읽을 수 없어(<오류>) 공식 마켓플레이스만 동작합니다." | "관리자에게 <정책 경로> 수정을 요청하세요." |
| `PACKAGE_POLICY_BLOCKED` | P | 지금 문장(MCP 거버넌스) | "관리자에게 문의하세요." |
| `PACKAGE_REQUIRED_BY_POLICY` | P | "조직이 <이름>을 필수로 지정해 제거하거나 끌 수 없습니다." | — |
| `SOURCE_CONFIRMATION_REQUIRED` · `unencrypted` | W | "<호스트>는 http를 씁니다: 연결이 암호화되지 않아 네트워크 경로의 누구나 내려받는 것을 보고 바꿀 수 있습니다." | "계속할까요?" |
| · `token-unencrypted` | W | "<호스트>의 로그인 정보가 암호화되지 않은 채 전송되어 경로의 누구나 복사할 수 있습니다." | "계속할까요?" |
| · `internal-network` | W | "<호스트>는 사내망 주소(<주소>)입니다. 이 소스의 서버만 허용하며, 마켓플레이스가 다른 사내 호스트에서 내려받게 하는 것은 따로 묻습니다." `198.18.0.0/15`이면 "일부 프록시 도구는 모든 주소를 이 범위로 보고합니다"를 덧붙임 | "조직 내부 소스가 맞을 때만 계속하세요." |
| · `this-computer` | W | "<호스트>는 이 컴퓨터(<주소>)입니다." | "직접 실행한 서버일 때만 계속하세요." |
| · `internal-downloads` | W | "<소스>가 다른 사내 주소 <호스트>에서 내려받게 합니다. 사내 호스트를 지정할 수 있는 마켓플레이스는 Ave를 통해 사내망 장비(예: 공유기 설정 페이지)로 요청을 보낼 수 있고, 나중에 검사가 실패해도 이미 보낸 요청은 되돌릴 수 없습니다. 허용할까요?" | *사내 다운로드 허용* |
| · `network-folder` | W | "이 폴더를 읽으려고 Windows 계정으로 <서버>에 로그인합니다." | "계속할까요?" |
| · `unencrypted-updates` | W | "<소스>의 업데이트는 http로 옵니다. 네트워크 경로의 누구나 자기 코드로 바꿀 수 있고, 그 코드는 묻지 않고 설치됩니다." | "그래도 자동 업데이트를 켤까요?" |
| `SOURCE_URL_REJECTED` · `credentials-in-url` | R | "주소에 비밀번호나 토큰이 있습니다. Ave는 주소에 비밀을 저장하지 않습니다." | "주소에서 빼고, *로그인*에서 *액세스 토큰*을 골라 그곳에 붙여 넣으세요." |
| · `helper-transport` | R | "`<scheme>::` 주소는 가져오려고 프로그램을 실행하므로 쓸 수 없습니다." | "https나 ssh 주소를 쓰세요." |
| · `scheme-unsupported` | R | "Ave는 `<scheme>:` 주소를 읽지 않습니다." | "같은 저장소의 https나 ssh 주소를 쓰세요." |
| · `format` | R | "주소에 `?…`, `#…`, 공백이나 제어 문자가 있습니다." | "지우세요." |
| · `relative-path` | R | "여기서는 상대 경로를 읽을 수 없습니다." | "전체 경로를 입력하거나 *폴더 선택…*을 쓰세요." |
| · `device-path`, `windows-path`, `network-file-url` | R | 형태와, 그것이 폴더가 아닌 이유 | "폴더의 일반 경로를 입력하세요." |
| · `index-file-url` | R | "Ave는 마켓플레이스를 marketplace.json 한 파일이 아니라 저장소나 폴더로 읽습니다." | "저장소 주소를 입력하세요." |
| · `address-metadata` | R | "<호스트>가 link-local 또는 클라우드 메타데이터 주소 <주소>로 해석됩니다. 그곳에 마켓플레이스는 없고, 요청하면 이 컴퓨터의 자격 증명이 노출될 수 있어 연결하지 않습니다." | "주소와 네트워크 설정을 확인하세요." |
| · `address-unroutable` | R | "<주소>는 어느 네트워크에서도 닿을 수 없습니다." | "주소를 확인하세요." |
| · `catalog-this-computer` | R | "<소스>가 다운로드를 이 컴퓨터(<호스트>)로 향하게 합니다. 마켓플레이스가 이 컴퓨터의 서비스로 요청을 보내게 할 수는 없습니다." | "마켓플레이스 소유자에게 알리세요." |
| · `deep-link-path` | R | "링크로는 이 컴퓨터의 폴더를 고를 수 없습니다." | "폴더를 직접 고르세요." |
| `CONTENT_RULE_VIOLATION` · `link-outside-folder` | R | "<경로>가 폴더 밖(<대상>)을 가리킵니다. Ave는 폴더 안의 파일만 설치합니다." | "링크 대신 파일을 폴더 안으로 복사하세요." |
| · `link-to-network` | R | "<경로>가 네트워크 위치(<대상>)를 가리킵니다. Ave는 다른 컴퓨터를 가리키는 링크를 따라가지 않습니다." | "링크 대신 파일을 폴더 안으로 복사하세요." |
| · `special-file`, `case-collision`, `extension`, `limit` | R | 경로와 규칙(§5.4, §5.5) | "<경로>를 지우거나 이름을 바꾸세요." |
| `SOURCE_AUTH_REQUIRED` · `token` | E | "<호스트>에 로그인해야 합니다." | 토큰 소스: 행의 *토큰 설정…*(저장된 토큰이 있으면 "<호스트>가 저장된 토큰을 받아들이지 않았습니다", *토큰 설정…*으로 교체); 토큰 없이 직접 추가: *소스 제거* 후 *액세스 토큰*으로 다시 추가; 토큰 없는 조직 소스: "관리자에게 알리세요"; 입력 중인 주소: *로그인*의 *액세스 토큰*; GitHub는 "Contents 읽기 권한이 있는 fine-grained 토큰" |
| · `token-no-access` | E | "<호스트>가 저장된 토큰으로는 이 소스 주소에 저장소가 없다고 답했습니다. 토큰에 권한이 없을 수 있습니다." | *토큰 설정…*으로 교체. 직접 추가한 소스는 주소가 틀렸다면 *소스 제거* 후 다시 추가 |
| · `token-unencrypted` | E | "<호스트>에 로그인해야 하는데, 이 소스는 http를 씁니다." | *허용…*(`token-unencrypted`) 후 *토큰 설정* |
| · `ssh` | E | "<호스트>가 SSH 키를 거부했습니다." | "키를 불러오거나(`ssh-add`) <호스트> 계정에 추가하세요." |
| `SOURCE_SSH_HOST_UNKNOWN` · `unknown` | E | "이 컴퓨터는 <호스트>에 SSH로 연결한 적이 없어 키를 확인할 수 없습니다." | "공개된 지문과 비교한 뒤 `ssh-keyscan -p <port> <host> >> ~/.ssh/known_hosts`를 실행하세요(Windows: `%USERPROFILE%\.ssh\known_hosts`)." *명령 복사* |
| · `changed` | E | "<호스트>의 SSH 키가 바뀌었습니다. 서버 재설치일 수도, 연결을 가로채는 누군가일 수도 있습니다." | "서버 관리자에게 확인한 뒤 `ssh-keygen -R <host>`." |
| `SOURCE_REF_NOT_FOUND` | E | "`<ref>`는 <저장소>의 브랜치나 태그가 아닙니다." | "있는 것: <최대 10개>. 기본 브랜치는 칸을 비우세요." |
| `SOURCE_UNREACHABLE` · `offline` | E | "이 컴퓨터는 오프라인입니다." | "네트워크가 돌아오면 다시 시도합니다." |
| · `dns` | E | "<호스트>를 찾을 수 없습니다." | "주소나 VPN을 확인하세요." |
| · `refused`, `timeout`, `http-status` | E | "<호스트>가 응답하지 않았습니다(<세부>)." | *다시 시도* |
| · `tls` | E | "<호스트>의 인증서를 믿을 수 없습니다. 회사 네트워크는 트래픽을 다시 서명하는 경우가 많습니다." | "IT에 네트워크 루트 인증서를 시스템 저장소에 설치해 달라고 요청하세요. Ave가 읽습니다(§9.2)." |
| · `proxy` | E | "시스템 프록시 설정이 <호스트>에 Ave가 쓸 수 없는 <종류>를 고릅니다." | "IT에 HTTP 프록시나 <호스트>로의 직접 경로를 요청하세요." |
| · `not-found` | E | "<호스트>가 이 주소에 저장소가 없다고 답했습니다. 호스트는 로그인 없이 비공개 저장소를 요청할 때도 같은 답을 합니다." 어느 쪽이라고 단정하지 않음 | 저장된 토큰이 없는 토큰 소스: *토큰 설정…*(직접 추가한 소스는 주소가 틀렸다면 *소스 제거*, 조직 소스는 그렇지 않다면 관리자); 저장된 토큰이 있으면 `SOURCE_AUTH_REQUIRED` · `token-no-access`와 같음; 토큰 없이 직접 추가: *소스 제거* 후 올바른 주소나 *액세스 토큰*으로 다시 추가; 토큰 없는 조직 소스: "관리자에게 알리세요"; 입력 중인 주소: "주소를 확인하거나 *액세스 토큰*" |
| · `not-found-ssh` | E | "<호스트>가 SSH로 이 주소에 저장소가 없다고 답했습니다. SSH 키의 계정이 비공개 저장소를 읽을 수 없을 때도 같은 답을 합니다." | "키를 불러왔는지(`ssh-add`), 저장소를 읽을 수 있는 <호스트> 계정의 키인지 확인하세요"; 입력 중인 주소와 직접 추가한 소스는 주소 안내, 조직 소스는 관리자 |
| `SOURCE_LOCAL_UNREADABLE` · `not-found` | E | "폴더 <경로>가 없습니다: 옮겨졌거나 이름이 바뀌었거나 드라이브가 연결되지 않았습니다." | "드라이브를 연결하거나, 소스를 제거하고 폴더를 다시 추가하세요." |
| · `permission`, `io` | E | "<경로>를 읽을 수 없습니다(<시스템 메시지>)." | "폴더 권한을 확인하세요. 다음 읽기에서 다시 시도합니다." |
| · `moved` | E | "<경로>가 이제 <새 경로>를 가리킵니다." | "소스를 제거하고 원하는 폴더를 추가하세요." |
| · `not-a-directory` | E | "<경로>는 폴더가 아닙니다." | "폴더를 고르세요." |
| · `ambiguous-case` | E | "<경로>에 대소문자만 다른 폴더가 여럿 있습니다." | "정확한 대소문자로 경로를 입력하세요." |
| · `changed-during-read` | E | "Ave가 읽는 동안 <경로>의 파일이 바뀌었습니다." | "다음 읽기 때 다시 시도합니다." |
| `SOURCE_NOT_A_MARKETPLACE` · `nothing-found` | E | "<위치>에서 marketplace.2.json도, 패키지 폴더도, 단일 패키지도 찾지 못했습니다." | 입력 중인 주소: "주소와 브랜치, 저장소 안의 패키지라면 폴더 칸을 확인하세요."; 직접 추가한 소스: 같은 안내를 *소스 제거* 후 다시 추가로; 공식: 나중에 *새로 고침*, 그다음 마켓플레이스 운영자; 조직: "관리자에게 알리세요" |
| · `other-app-plugin` | E | "다른 앱용 플러그인입니다(`.claude-plugin/`나 `.codex-plugin/`)." | "플러그인 스튜디오의 *플러그인 가져오기*를 쓰세요(`extensions-and-plugins.md` §2.4)." |
| `SOURCE_INDEX_INVALID` | E | "<소스>의 인덱스가 올바르지 않습니다(<파일>: <문제>). 마지막 정상 버전을 계속 씁니다." | "마켓플레이스 소유자에게 알리세요." *세부 정보 복사* |
| `SOURCE_HISTORY_REWRITTEN` | E | 공식·관리: "<소스>의 이력이 다시 쓰여 마지막 정상 버전을 유지합니다." 커스텀·직접: "…새 이력을 검토한 뒤 쓰세요." | 커스텀·직접: *검토* |
| `SOURCE_LOCAL_DATA_DAMAGED` · `state-missing`, `state-invalid`, `state-unreadable` | W | "<id> 소스의 다운로드한 사본이 손상되었습니다. Ave가 신뢰하는 버전의 기록이 없거나 읽을 수 없습니다." | "복구하면 소스를 다시 다운로드하고, 이전 버전과 대조하지 않은 채 지금 제공되는 버전을 신뢰합니다." 행의 *복구*(모든 출처, 새로 고침과 스위치 대신). `state-unreadable`은 폴더 권한을 고치면 대조가 유지됨; *세부 정보 복사* |
| · `snapshot-invalid`, `snapshot-unreadable`, `repository-damaged` | E | "<id> 소스의 다운로드한 사본이 손상되었습니다(패키지 목록 또는 git 저장소)." | *복구*; "Ave가 신뢰하는 버전은 유지됩니다." |
| · `repair-failed`, `repair-failed-unpinned` | E | "Ave가 <소스> 소스의 손상된 사본을 옮기지 못해 다시 다운로드하지 않았습니다." `repair-failed`만 "신뢰하는 버전은 유지됩니다"를 덧붙임 | "다른 Ave 창을 닫고 복구를 다시 누르세요." *세부 정보 복사* |
| · `repair-write-failed` | E | "Ave가 <소스> 소스의 신뢰하는 버전 기록을 저장하지 못해 소스를 다시 다운로드하지 않았습니다." | "디스크 공간과 쓰기 권한을 확인한 뒤 복구를 다시 누르세요." |
| `SOURCE_LIST_UNREADABLE` · `unreadable`, `invalid` | E | "Ave가 직접 추가한 소스 목록인 Ave 데이터 폴더의 `marketplaces/sources.json`을 읽을 수 없어(<fsCode>, 또는 Ave 형식이 아님), 고쳐질 때까지 어떤 소스도 바꾸지 않습니다." | "파일을 고치거나 지운 뒤 Ave를 다시 시작하세요. 지우면 직접 추가한 소스만 사라지고, 공식·조직 소스와 설치한 패키지는 그대로 남습니다." 형식 오류는 *세부 정보 복사* |
| `SOURCE_DISABLED` | E | 지금 문장 | *소스 보이기* |
| `SOURCE_NAME_RESERVED`, `SOURCE_ID_INVALID` | E | "<id>는 예약되었거나 올바른 ID가 아닙니다(소문자·숫자·`-` 2–63자)." | "다른 ID를 고르세요." |
| `SOURCE_ID_TAKEN` | E | "<저장소나 폴더>는 이미 <id>로 추가되어 있습니다" 또는 "<id>는 이미 쓰입니다" | *<id> 보기* 또는 "다른 ID를 고르세요." |
| `GIT_RUNTIME_MISSING`, `GIT_RUNTIME_TOO_OLD` | E | 지금 문장 | *Git 설치* |
| `GIT_RUNTIME_INSTALL_FAILED` · `<phase>` | E | "git 설치가 <단계>에서 실패했습니다(<이유>)." | *다시 시도*; "네트워크가 GitHub 다운로드를 막으면 git을 직접 설치하고 *시스템*을 고르세요." |
| `PLAN_EXPIRED` · `expired`, `replaced`, `folder-changed`, `policy-changed`, `package-changed` | E | 지금 문장; 폴더는 "검토하는 동안 폴더가 바뀌었습니다.", 정책은 "검토하는 사이 조직 정책이 바뀌었습니다.", `package-changed`(검토한 세대나 승인 다이제스트가 더는 맞지 않는 §18.7.5의 승인)는 "검토한 뒤 패키지가 바뀌었습니다. 다시 검토하세요." | 새 계획으로, `package-changed`는 설치된 세대로 검토를 다시 엶 |
| `PACKAGE_INCOMPATIBLE` · `min_app_version` / `platform` / `prerelease` / `rollout` / `host_protocol` | E | "<이름>에는 Ave <버전>이 필요합니다" / "<OS>용이 없습니다" / "사전 릴리스만 있습니다" / "단계적으로 배포 중이며 나중에 제안됩니다" / "더 새 플러그인 프로토콜이 필요합니다" | *Ave 업데이트* / — / "업데이트에서 사전 릴리스를 켜세요" / — / *Ave 업데이트* |
| `PACKAGE_COMPAT_UNDECLARED` | E | "플러그인이 필요한 Ave 버전(`requires.minAppVersion`)을 선언하지 않았습니다." | "작성자에게 선언을 요청하세요." |
| `PACKAGE_YANKED`, `PACKAGE_REVOKED` | E | "<소스>가 철회했습니다: <이유>." | "다른 버전을 고르거나 제거하세요." |
| `PACKAGE_ID_CONFLICT` | E | "<이름>은 <다른 소스>에서 설치되어 있습니다." | *<소스>로 전환*(데이터 유지, §15.1) |
| `ARTIFACT_NOT_PINNED` | S | 단계 목록: "마켓플레이스가 이 다운로드를 고정하지 않아 건너뛰었습니다." | — |
| `ARTIFACT_DIGEST_MISMATCH` | E | "<호스트>에서 받은 파일이 마켓플레이스가 고정한 파일이 아니어서 아무것도 설치하지 않았습니다." | "나중에 다시 시도하고, 계속되면 소유자에게 알리세요." |
| `MANIFEST_MISMATCH` · `<field>` | E | "패키지 파일이 마켓플레이스 항목(<필드>)과 달라 아무것도 설치하지 않았습니다." | "마켓플레이스 소유자에게 알리세요." *세부 정보 복사* |
| `NO_INSTALLABLE_ARTIFACT` · `rungs`, `folder-has-no-build` | E | "<이름>에 쓸 수 있는 다운로드가 없습니다:"와 단계별 문장; 폴더는 "폴더에 빌드된 플러그인(`plugin.json`과 `dist/`)이 없습니다." | 첫 단계의 조치; 폴더는 "`dist/`로 빌드하거나 git 저장소를 대신 추가하세요." |
| `process-entry-unsupported`(오늘 `main`, `errors.ts:37`; P3가 제거) | E | 지금 문장(`labels.ts:114`, `formatIpcError.processEntryUnsupported`): 이 버전은 별도 프로세스를 띄우는 플러그인을 실행하지 않음 | "별도 프로세스가 없는 버전을 쓰거나 Ave 업데이트를 기다리세요." |
| `process-entry-requires-pinned-artifact`(P3가 추가) | E | "이 익스텐션은 프로그램을 실행하므로, 마켓플레이스가 고정한 릴리스에서만 설치합니다." | "릴리스를 고정한 마켓플레이스에서 설치하세요." (Publication 계획 소유) |
| `process-entry-unconfined`(P3가 추가) | E | Publication 계획 소유(런타임 거부) | Publication 계획 소유 |
| `invalid-request` | E | "Ave가 이 버전이 이해하지 못하는 요청을 보냈습니다. 버그입니다." | *세부 정보 복사* |
| `unavailable` | E | "마켓플레이스가 시작하거나 응답하지 못했습니다." 모든 코드와 마찬가지로 main의 메시지는 보이지 않고, 가린 채 *세부 정보 복사* 뒤에 있습니다. 업데이트 카드는 대신 "지금은 업데이트를 확인할 수 없습니다."라고 씁니다(§15.7.1). | "Ave를 다시 시작하고, 계속되면 *세부 정보 복사*." |
| `unauthorized-frame` | — | 보이지 않음: 감사 기록만 남고 표시할 응답 없음 | — |
| 업데이트 `needs-review` | S | "<이름> <버전>이 설치된 버전보다 많은 것을 요청합니다:"와 `consentDelta`의 각 행. 코드가 아닌 파일만 바뀌었으면 "코드가 아닌 이 파일들만 바뀌었습니다:"와 목록. 이관된 승인은 "이전 Ave 버전의 승인을 확인해야 합니다." | *검토*; 코드 아닌 변경은 *업데이트 승인* |
| 업데이트 `approval-pending` | S | "조직이 <이름>을 업데이트했고, 구성 요소 <n>개가 승인을 기다리며 실행되지 않습니다." | *검토* |
| 업데이트 `waiting` | S | "대화가 멈추면 적용합니다." 30분 뒤 단계 올림으로 "업데이트 <n>개가 대화가 멈추기를 기다립니다." | 30분 뒤 *지금 적용* |
| 업데이트 `failed` | S | 실패 문장과 "<n>/3회 시도" | *다시 시도*, *자세히* |
| 업데이트 `applied-not-running` | S | "<이름> <버전>을 설치했지만 시작하지 못했습니다." | "Ave를 다시 시작하세요." |
| 탐색 `offline` | S | "오프라인 — 마지막 확인 <시각>." | "네트워크가 돌아오면 다시 확인합니다." |

### 18.9 설정, IPC, preload, 잠금 스위트, UI

**설정** — `MarketplaceSettings`(`settings-store.ts:893-959`), `normalizeMarketplace`
(`settings-normalization.ts:921`):

| 키 | 타입 | 기본값 | 비고 |
|---|---|---|---|
| `autoUpdate` | `boolean` | 비어 있음 = `true` | 전역 스위치 |
| `autoUpdateSources` | `Record<sourceId, "on" \| "off">` | 비어 있음 | 잘못된 ID(`SOURCE_ID_RE`)나 값은 정규화기가 버림; null 프로토타입 맵 |
| `autoUpdatePackages` | `Record<string, "on" \| "off">` | 비어 있음 | `packageUpdateSkipKey`가 키, `normalizeSkippedPluginUpdateKey`로 정규화 |
| `updateCheckIntervalMs` | `number` | 비어 있음 = 6시간 | 그대로: 탐색 간격(§18.7.1); `0`과 15분 하한 그대로. 24시간 적용 주기는 설정이 아님 |
| `updateCheckEnabled`, `skippedPluginUpdates` | — | — | 그대로 |

렌더러는 기존 설정 채널로 이것들을 씁니다. http 전제 조건은 설정이 **아닙니다**: main만
기록하는 소스 확인 `unencrypted-updates`입니다.

**IPC와 preload** — 새 채널은 모두 호스트 렌더러 전용(`validateHostRendererSender`)이고
감사합니다(§13).

| 채널 | 변경 | 요청 | 응답 |
|---|---|---|---|
| `ave:marketplace:sources:preview` | 바뀜 | `SourcePreviewRequest`(`shared/git-marketplace.ts:73-82`)에 `acknowledge?: SourceWarning[]`; `input`이 폴더도 받음 | 유니언에 `{ type: "confirm"; warnings: SourceWarningView[] }` |
| `ave:marketplace:sources:list` | 바뀜 | — | `SourceStatusView`의 `unreachable`과 `auth-required`에 `detail?`(§18.8) |
| `ave:marketplace:sources:acknowledge` | 새 | `(id, warnings: SourceWarning[])` | 동기화 뒤의 `SourceView` |
| `ave:marketplace:sources:pick-folder` | 새 | `()`; main이 폴더 대화상자를 띄움 | `{ path } \| null` |
| `ave:marketplace:sources:reveal` | 새 | `(id)`; 폴더 소스만 — 경로가 아니라 ID | `null` |
| `ave:marketplace:updates:status` | 새 | `()` | `UpdateStatusView` |
| `ave:marketplace:updates:check` | 새 | `()`; 진행 중인 탐색에 합류 | 그 탐색과 적용 확인이 끝날 때 `UpdateStatusView`(§18.7.1) |
| `ave:marketplace:updates:apply-now` | 새 | `()`; 큐의 유휴 게이트를 건너뜀(§18.7.4) | `UpdateStatusView` |
| `ave:marketplace:install:execute` | 바뀜 | `plugin`도 구성 요소 동의를 받음(§18.7.3) | — |
| `ave:marketplace:components:approve` | 새 | `(key: PackageKeyView, installId: string, consents: ReviewedComponentConsent[])`; `approval-pending`인 에이전트 플러그인; 설치된 세대와 다시 대조(§18.7.5) | `UpdateStatusView`; 다르면 `PLAN_EXPIRED` 사유 `package-changed` |
| `ave:plugins:contribution-trust:list` | 바뀜 | — | 각 행에 `approvalDigest: string \| null`(§18.7.5) |
| `ave:plugins:contribution-trust:set` | 바뀜 | `approved: true`면 검토한 행의 `generationId`와 `approvalDigest`도; 철회는 둘 다 받지 않음(§18.7.5) | 다르면 `error: "contribution-trust-review-stale"` |
| `marketplace:update-status` | 새 이벤트 | — | 바뀔 때 `UpdateStatusView` |
| `marketplace:updates-available` | 유지 | — | `PackageUpdateView`에 `state`: §18.7.5에서 사용자가 필요한 상태(`updateNeedsUser`: `manual`, `needs-review`, `failed`, `applied-not-running`, `approval-pending`); `manual`은 업데이트 알림이 켜져 있을 때만. E에서 구현(§13.1) |
| 모든 채널 | 바뀜 | — | 실패 봉투에 `detail?`(§18.8) |

타입(`SourceWarning`, `SourceWarningView`, `SourceView` 추가 필드, `UpdatePlanView.consentDelta`,
`pendingApproval`과 `ReviewedComponentConsent`를 포함한 `UpdateStatusView`)은 원문 §18.9의 코드 블록과 같습니다.
슬라이스 E는 `UpdateStatusView`의 `discovery`(`nextAt`은 탐색과 적용 확인 기한 중 이른
쪽, 간격이 0이어도 매일의 적용 확인이 탐색함), `applyCheckAt`, `running`, `historyReset`,
그리고 `key`, `displayName`, `from`, `to`, `state`가 있는 `packages`를 구현했고(§13.1),
F가 `waitingSince`, `autoUpdate`, 패키지의 `reasons`, `failure`, `appliedAt`,
`pendingApproval`을 더합니다.
`pendingApproval`은 에이전트 플러그인의 `approval-pending` 항목에만 있습니다. 익스텐션의
`approval-pending` 항목은 페이로드가 없고, 그 검토는 `ave:plugins:contribution-trust:list`와
`:set`을 씁니다(§18.7.5).

`CHANNELS.gitMarketplace`(`app-contract.ts:302-327`)에 `sourcesAcknowledge`,
`sourcesPickFolder`, `sourcesReveal`, `updatesStatus`, `updatesCheck`, `updatesApplyNow`,
`componentsApprove`, `updateStatusChanged`를 더합니다. `GitMarketplaceApi`(`shared/git-marketplace.ts:414-448`)와
그 preload 표면(`git-marketplace-api-surface.ts:38-64`)에 `acknowledgeSource`, `pickFolder`,
`revealSource`, `updateStatus`, `checkUpdates`, `applyUpdatesNow`, `approveComponents`, `onUpdateStatus`를
더합니다. `onMarketplaceUpdatesAvailable`(`internal-api-surface.ts:589-593`)은 이름을
유지합니다.

**잠금 스위트**

| 스위트 | 슬라이스 | 변경 |
|---|---|---|
| `src/data/__tests__/settings-store.test.ts` | E | 새 키 셋과 정규화; `updateCheckIntervalMs` 그대로 |
| `src/ipc/__tests__/channel-inventory.test.ts` | C, D1, D2, E, F | C `sources:acknowledge`; D2 `sources:pick-folder`, `sources:reveal`; E `updates:status`, `updates:check`, `marketplace:update-status`; F `updates:apply-now`, `components:approve`. D1은 채널을 더하지 않고, 스위트를 돌려 그것을 증명 |
| `src/ipc/__tests__/host-renderer-only-channels.test.ts` | C, D2, E, F | 새 invoke 채널마다 |
| `src/__tests__/preload-shape.test.ts` | C, D2, E, F | `gitMarketplace` 멤버 목록 |
| `src/ipc/__tests__/domain-exports.test.ts` | 없음 | 핸들러는 기존 `src/ipc/domains/git-marketplace.ts` 내보내기에 들어감; 런타임 내보내기를 얻는 도메인 없음 |

**UI**

- **업데이트 카드**(설정 → 마켓플레이스, §15.7의 Git 런타임 카드 옆):
  - "패키지를 자동으로 업데이트", 정책 값이 있으면 정책 문구와 함께 잠김;
  - "시작할 때와 하루 한 번 업데이트 확인 · 마지막 확인 <시각> · 다음 <시각>";
  - *지금 확인*, 업데이트가 기다리는 동안 *지금 적용*;
  - 사용자가 필요한 업데이트와 그 조치;
  - 최근 자동 업데이트와 *바뀐 점*.
- **소스 행**: 배지(§18.5); *허용…*; detail을 담은 상태(§18.8); *자동 업데이트* 선택
  (*기본(켬)* / *켬* / *끔*). http 소스에서 켜면 `unencrypted-updates`를 먼저 보여
  줍니다. 폴더 행은 §18.4.8대로.
- **설치됨 행**: 업데이트 상태(§18.7.5)와 *자동 업데이트* 선택.
- **추가 대화상자**: *폴더 선택…*, 트래픽이나 폴더 접근 전의 확인 단계(§18.5),
  미리보기의 배지.
- **업데이트 검토**: `consentDelta` 항목마다 행 하나; 바뀌었거나 새로 생긴 MCP 서버와
  훅의 승인 상자, 익스텐션 포함; 코드 아닌 파일만 바뀌었을 때 한 행의 *업데이트 승인*
  형태(§18.7.3); `approval-pending` 에이전트 플러그인을 위한 구성 요소 모드(§18.7.5).
- **패키지 시트**: 폴더 출처; http와 사내망 전달 라벨.
- **문제 표시**: `MarketplaceProblem`(§18.8). 목업은 슬라이스 G에서 이 상태들을 더합니다.

### 18.10 전달

각 슬라이스는 강제·테스트·메시지 키를 함께 담아 `main`에 독립적으로 병합됩니다. 경고와
거부 없이 새 입력을 받는 슬라이스는 없고, 중간 커밋을 녹색으로 두려고 대체 경로를 더하는
슬라이스도 없습니다. 각 슬라이스는 만든 것에 대해 해당 절(§7, §12, §13, §14, §15, §17)을
고쳐 쓰고 §18을 가리키는 문구를 지웁니다.

| 슬라이스 | 범위 | 선행 | 병렬 가능 | 잠금 스위트 |
|---|---|---|---|---|
| **A. 설계** | 이 절; §1–§17의 안내 문구; 아키텍처 제안서(결정 D11, D12, §8, §9.1); `extensions-and-plugins.md` §3.2 문장; 한국어 미러 | — | — | 없음 |
| **B. 메시지** | 오류 `detail`, 봉투, `detail`의 소스 상태 경로(`SyncResult`, `lastSync.detail`, 검증기, `sourceStatus`), 사유 없는 문장을 포함한 빠짐없는 `failureText`, `MarketplaceProblem`, 기존 모든 코드·사유의 문장, git 실패 분류(호스트 키 변경, 나열된 ref, 닿지 않는 이유) | A | Publication 계획의 P3 | 없음 |
| **C. 대상 분류, 경고, 연결 묶기(git과 다운로드)** | `classifyAddress`, `addressPolicy`, 고정 다운로드 전송, git http 주소 고정, ssh 사전 검사(§18.2.4), 게이트 판정, 미리보기 확인, `acknowledged`, `sources:acknowledge`, `internal-downloads`를 포함한 카탈로그 규칙, http 위 자격 증명, 정책 `requireHttps`·`blockPrivateNetworks`, `PolicySource`와 정책 새로 읽기(§18.6), 거부 #1–4와 #7, 추가 대화상자 확인, 배지, *허용…* | B | E | channel-inventory, host-renderer-only-channels, preload-shape |
| **D1. 폴더 소스: 엔진과 동의** | 네 단계의 `source-input.ts`, `native/windows-path-kind/`와 그 CI 실행, `FolderFs`, `SourceTree`와 `FolderTree`, 레지스트리 `path`, 리비전, 모든 종류의 폴더 읽기·스냅숏·계획 확보·설치, `folder` 단계와 영수증, 폴더 직접 설치, 정책 `path:`·`allowLocalSources`·`additional[].path`, `SOURCE_LOCAL_UNREADABLE`, `network-folder` 경고와 그 키, 거부 #5–6, 폴더 경로의 `process` 거부(§18.4.9) | C(확인 흐름과 `acknowledged`) | E | channel-inventory(변경 없음을 단언) |
| **D2. 폴더 소스: UI** | `sources:pick-folder`, `sources:reveal`, *폴더 선택…*, 폴더 행과 출처 | D1 | E, F | channel-inventory, host-renderer-only-channels, preload-shape |
| **E. 탐색과 상태** | 기한 규칙, 한 시간 기한 확인과 resume, 시도·성공 시각, `updates.json`, `UpdateStatusView`, `updates:status` / `updates:check` / `marketplace:update-status`, 설정 키, 읽기 전용 업데이트 카드, 알약 필터 | B | C, D1, D2 | settings-store, channel-inventory, host-renderer-only-channels, preload-shape |
| **F. 자동 적용** | `consentFingerprint`, 승인 다이제스트, 기준선 저장과 기존 설치의 계산, `ConsentDelta`와 검토의 바이트 묶기, 익스텐션 구성 요소 동의, 신뢰 저장소 v3와 두 경로의 이어가기, 두 검사 지점, v2 기록 이관, 승인 유지 전제 조건, `onIdle`과 30분 단계 올림을 갖춘 적용 큐, 부팅 때의 유휴 게이트, `updates:apply-now`, 에이전트 플러그인 MCP 리스 원천과 비우기, `.installs/` 아래 설치 주소 페이로드 디렉터리, 결과 분류(동의 보류, 실패, 커밋 뒤)와 콘텐츠 디렉터리 정리, `approval-pending`, `components:approve`와 두 화면의 승인 묶기, 코드 아닌 변경의 싼 검토, 전제 조건과 결정 순서, 필수 설치 규칙, 실패 횟수, 롤백 시 건너뛰기, `autoUpdated` 알림, 스위치, `unencrypted-updates` | C, D1, E | D2 | channel-inventory, host-renderer-only-channels, preload-shape |
| **G. 문서와 목업** | `web/app/docs/marketplace/*`(ko, en)의 폴더·경고·자동 업데이트; 목업 상태; 남은 안내 문구 정리 | D2, F | — | 없음 |

**순서.** A, 그다음 B. 그다음 C와 E를 각자의 체크아웃에서 병렬로. 그다음 C 뒤에 D1,
D1 뒤에 D2; D1과 E 뒤에 F; G는 마지막입니다.

- C와 E 중 나중에 병합하는 쪽이 `shared/git-marketplace.ts`, `app-contract.ts`, preload
  표면, 잠금 스냅숏의 문자적 충돌을 리베이스로 풉니다.
- D1과 D2는 각각 독립적으로 병합할 수 있습니다. D1은 기존 미리보기 채널로 폴더 입력을
  받으며 동의, 정책, 거부를 모두 갖춥니다. D2는 대화상자와 표시만 더합니다.
- Publication 계획(`plugin-hostapi-protocol.md` §9.7; P3·P4 미구현; §18.4.9)은 `errors.ts`, `labels.ts`,
  `plugin-ladder.ts`, `direct-package.ts`, `plugins/marketplace.ts`를 건드립니다:
  - B와 P3 중 나중에 병합하는 쪽이 그때 있는 `process` 코드를 `failureText`에 넣고;
  - D1과 P4 중 나중에 병합하는 쪽이 폴더 거부를 유지합니다.

**모든 슬라이스의 게이트**:

- `bun run typecheck`;
- 대상 Vitest 디렉터리(`bun run test:vitest -- run <dirs>`);
- 위에 적은 잠금 스위트;
- 키가 바뀌면 `bun run check:i18n-catalog`;
- GNU grep으로 돌린 naming 게이트;
- 게시할 때 한 번, pre-push 훅의 전체 `bun run test`와 `bun run build`.

아래 E2E 흐름은 `test/e2e/ui/`에서 돕니다.

**되돌리면 실패하는 테스트**는 원문 §18.10의 목록과 같습니다. 테스트 이름, 픽스처,
되돌림 대상은 원문을 따릅니다. 이번 개정에서 더한 것의 요지:

- **B**: 기존 코드인 `SOURCE_UNREACHABLE` 사유 `dns`로 실패한 백그라운드 동기화의 detail이
  레지스트리를 디스크에서 다시 연 뒤에도 `sources:list`에 남고 지역화 문장으로 보임(되돌림:
  코드만 영속). 폴더 사례는 D1로 옮김.
- **C**: DNS 재바인딩 사례(첫 조회는 공개, 이후는 메타데이터·루프백)에서 연결은 첫 응답으로만
  감; `internal-network`만 가진 소스는 다른 사내 호스트 다운로드에 실패; 관리 http 소스의
  저장 토큰도 `token-unencrypted` 없이는 askpass를 받지 못함; 실행 중 정책 파일을 바꾸면
  다음 미리보기가 막히고 기존 계획은 `policy-changed`로 만료; PAC 종류별(`PROXY`, `HTTPS`,
  `SOCKS5`, `SOCKS4`, 모르는 종류) 수용 사례; `trusted-proxy.test.ts`가 루프백 프록시 픽스처로
  신뢰하는 프록시 경계를 문서화한 동작으로 보여 줌; `ssh-preflight.test.ts`가 고정 옵션이 없음,
  메타데이터 응답과 섞인 응답(공개+메타데이터, 공개+정책 차단 사내 주소)에서 사전 검사 거부, `ProxyCommand`는 해석하지 않음, 사전 검사 뒤 바뀐
  응답이라는 명시한 잔여 위험을 확인.
- **D1**: 호출 기록 가짜로, UNC와 `\Device\Mup\…` 드라이브의 미리보기가
  `queryDosDevice` 말고는 호출 0개로 `confirm`을 응답; `allowLocalSources: false`도 호출
  0개로 차단; `root/a → root/b → \\attacker\share` 사슬과 조상의 정션이 `\\attacker`
  경로 호출 없이 `link-to-network`; 대소문자를 구분하는 가짜 볼륨에서 두 표기는 두 소스이고
  `allow`는 정확한 표기만, `block`은 모든 표기; 루트 해석 — `/tmp → private/tmp` 조상
  링크와 링크인 루트는 해석되고, 텍스트가 네트워크인 조상 링크는 `link-to-network`; **조상
  교체** — 나열 뒤 열기 전에 `root/d`를 바깥 링크로 바꿔 두면 부모 사슬 재검사가
  `changed-during-read`를 내고 바깥 바이트는 패키지에 들어가지 않으며, 재검사 전에 되돌린
  교체는 명시한 잔여 위험으로 기록; 폴더 읽기의 `SOURCE_LOCAL_UNREADABLE` 사유 `permission`
  detail이 B의 경로로 영속됨.
- **D2**: E2E는 폴더 마켓플레이스 추가, 스킬 설치, 수정, *새로 고침* 뒤 행이 업데이트를
  제안하는 데까지. 자동 적용은 F의 E2E.
- **E**: 오프라인 탐색은 간격 뒤가 아니라 다음 한 시간 기한 확인에서 재시도하고, 0시 성공·1시
  오프라인 *지금 확인* 뒤에도 2시에 재시도(`lastSuccessAt`에 묶지 않음); 성공한 탐색은 6시간
  동안 반복하지 않음; 적용 확인은 부팅 때와 24시간 뒤; **정확한 경계** — 간격 48시간, 0시에
  탐색과 적용 확인, 0시 1분 게시면 24시의 적용 확인(마지막 탐색이 정확히 24시간)이 먼저
  탐색하고 그 릴리스를 분류; **독립 위상** — 기본 간격으로 0·6·12·18·24시 탐색, 마지막 적용
  확인 3시면 27시의 적용 확인은 3시간 전 성공이 있어도 스스로 탐색하고 25시 게시를 분류;
  탐색 중에 기한이 된 적용 확인은 합류하고 둘째 탐색을 시작하지 않으며, 그 탐색이
  `partial`이면 닿은 소스만 분류하고 `applyCheckAt`은 쓰지 않음; `updates:check`는 적용 큐가 기다리는 동안에도 탐색과 적용 확인이 끝나면
  돌아옴. E에는 적용 큐가 없으므로 E의 테스트는 적용 확인이 끝나기 전에 답하도록 되돌리면
  실패하고, 큐 쪽 절반은 F의 `apply.test.ts`가 맡음.
- **F**: 선언(`.mcp.json`)은 그대로 두고 `dist/server.js`나 그것이 불러오는 파일을 바꾸면
  승인 다이제스트가 바뀜; **간접 로드** — 승인된 `server.js`가 평가하는
  `skills/helper/assets/rules.txt`만 바꿔도 `needs-review`; **버전을 올린 완전한 릴리스**
  (`plugin.json` `version`과 `SKILL.md` 하나)는 로컬 실행 구성 요소가 없는 패키지에서 자동
  적용되고, stdio MCP가 있는 패키지에서는 "코드가 아닌 파일만 바뀜" 한 행과 *업데이트 승인*
  한 번의 검토; `plugin.json`의 다른 필드 변경은 다이제스트를 바꾸고 `plugin.json`을 `changedFiles.code`에
  나열; 핀 없는 런처는 `null`;
  0.12의 실제 버전 2 신뢰 파일에서 활성 세대이고 선언 지문이 같은 기록은 설치된 바이트로
  다이제스트를 얻어 이어지고 나머지는 `null`; 승인 유지 불변식 — 지문은 같지만 승인된
  구성 요소가 이어지지 못하면 자동이 아니라 `needs-review`; 실제 `McpManager`를 거쳐
  `agent-plugin/` 소유자의 리스가 `withBundledLease`와 **등록 도구**(`bindBundledTool`이 돌려준
  `execute`) 모두에서 런타임 원천에서 오고, 게시 전부터 쥔 물러난 활성화의 도구 객체는
  `execute`에서 예외를 던지며 아무것도 실행하지 않고, **같은 버전의 동시 폴더 새로 고침**
  중 이전 활성화의 MCP 호출이 결과와 함께 끝나며 이전 페이로드 디렉터리는 비워진 뒤에야
  지워짐; 한 버전의 두 설치는 `.installs/<installId>/` 두 개이고 `<version>/` 아래에는 없음; **이전
  설치의 같은 버전 새로 고침** 뒤 물러남과 재부팅(부팅 정리 포함)에도 대체 설치의 파일은
  읽히고 이전 `<version>/`은 사라짐; 턴 없는 세션 변경과 부팅 때 이미 도는
  턴 모두 큐를 기다리게 함; 둘째 검사 지점의 보류가 세 번 이어져도 `needs-review`이고 시도
  0회; 커밋 뒤 게시 실패는 `applied`나 `applied-not-running`이고 시도로 세지 않으며, 패스가
  쓰는 모든 상태가 보기의 유니언 멤버; 카탈로그 권한과 번들 훅을 함께 더한 업데이트의 수동
  검토는 승인 전에 스테이징해 둘 다 보여 줌; 필수 설치는 바뀐 권한을 스위치가 꺼져 있어도
  적용하고, 바뀐 MCP 서버는 승인 없이 두어 `approval-pending`; `components:approve`가 그
  상태를 풂; **검토와 제출 사이의 교체** — 세대 A를 검토하는 동안 필수 업데이트가
  `skills/helper/assets/rules.txt`만 바꾼 세대 B를 설치하면(서버의 구성 요소 다이제스트는
  그대로), A의 승인은 `components:approve`에서 `PLAN_EXPIRED` 사유 `package-changed`로,
  `contribution-trust:set`에서 `contribution-trust-review-stale`로 거부되고 B의 구성 요소는
  승인되지 않으며, `null` 다이제스트 구성 요소는 세대 확인만으로 거부됨; **바뀌지 않은 세대의
  승인은 성공** — 교체가 없으면 현재 `installId`의 `components:approve`와 행의
  `generationId`·`approvalDigest`를 담은 `contribution-trust:set`이 승인하며, 목록과 제출
  사이에 익스텐션이 다시 활성화되어 같은 산출물에 새 코디네이터 세대 id가 생겨도 성공;
  전용 E2E `git-marketplace-auto-update.spec.ts`는 `isE2eTestRuntime()`일 때만
  읽는 `AVE_E2E_MARKETPLACE_SCHEDULER=1`로 실제 스케줄러를 띄우고, `unencrypted-updates`를
  확인한 뒤 *지금 확인*으로 실제 설치와 IPC 상태(`applied`)를 단언(상태 이벤트를 흉내 내지
  않음).

### 18.11 결정

결정 1–40의 표는 원문 §18.11과 같습니다. 요지:

| # | 결정 요지 |
|---|---|
| 1–4 | 네 가지 결과, 입력·카탈로그 대상 표 분리, 주소 분류를 `network-guard.ts` 한 곳에서, 트래픽이나 폴더 접근 전 한 번 확인, 분류 단위 저장 |
| 5–7 | 카탈로그 http 다운로드는 sha256 핀으로 수용; 다른 사내 호스트는 `internal-downloads` 확인(`internal-network`로 생기지 않음, 경고가 공격을 설명); 다른 포트의 루프백은 거부 |
| 8–15 | 폴더에 git 명령 없음, 작업 트리로 읽음, 제자리 읽기와 계획의 바이트 확보, 리비전 핀, 단일 `marketplace.json` URL과 `git://` 미지원, 정식 루트 아래에서 텍스트로 따라가는 링크 규칙, 루트 자체를 정할 때는 로컬 조상·루트 링크를 네트워크 검사 뒤 따라감, 디렉터리 사슬 재검사로 지속된 교체 감지(교체 후 되돌림은 명시한 잔여 위험), 폴더 소스는 내려받지 않음(`folder` 단계), 정식 경로나 `dev`/`ino` 식별과 보수적 대소문자 규칙 |
| 16–17 | 탐색(동기화·폐기)은 6시간, 업데이트 적용 확인은 부팅 때와 하루 한 번이며 언제나 탐색을 먼저 돌리거나 합류; 실패 뒤에는 `lastAttemptAt`에서 한 시간마다, 성공 뒤에는 `lastSuccessAt`에서 간격만큼; 탐색은 적용 큐를 기다리지 않음 |
| 18–28 | 모든 출처 기본 켬(http는 `unencrypted-updates` 전까지 끔), 결정 순서, 동의 지문·`unknown` 필드·승인을 잃는 구성 요소는 검토, `mcp`는 항상 검토, 로컬 실행 구성 요소가 없는 패키지만 텍스트·데이터 자동 적용, 승인 다이제스트는 선언·고정 파일·**패키지 전체**(`plugin.json` `version`만 정규화)이고 정할 수 없으면 `null`, 코드 없는 변경은 한 번의 승인으로 싸게 검토, 두 검사 지점과 늘 스테이징하는 수동 검토, 부팅 포함 `onIdle`과 30분 단계 올림, 에이전트 플러그인 MCP 리스 원천(등록 도구와 `withBundledLease`가 한 도우미로 획득)과 이전 `<version>/`과 겹치지 않는 `.installs/` 설치 주소 디렉터리, 필수 설치는 권한만 정책이 승인하고 승인 없는 구성 요소는 `approval-pending`, 롤백 시 건너뛰기, 동의 보류·커밋 뒤 실패는 시도가 아님 |
| 29–39 | 오류와 소스 상태의 `detail`, 빠짐없는 문장, 스튜디오 *파일에서 설치*는 그대로, 정책 키와 작업마다 정책 다시 읽기, http 자격 증명은 등재로 생기지 않음, 딥 링크 폴더 거부, 파일 호출 전 `QueryDosDeviceW`로 네트워크 폴더 분류, `process` 규칙 비완화, 스위치는 설정·http 전제는 main, 슬라이스 순서(D1은 C 뒤, F는 D1·E 뒤), 주소에 따른 거부를 Ave가 소유한 전송(다운로드, http/https 위 git)의 연결에 묶고, SSH는 `ssh -G` 호스트 이름의 사전 검사만 하며 고정 옵션 없음, PAC 프록시(로컬·원격)는 검사한 소켓 너머를 신뢰하고 ssh `ProxyCommand`·`ProxyJump`는 사용자가 설정한 프로그램처럼 신뢰, 버전 2 승인 이관(활성 세대이고 선언 지문이 같으면 설치된 바이트로 다이제스트, 아니면 첫 업데이트 검토) |
| 40 | 설치된 구성 요소의 승인은 검토한 세대(에이전트 플러그인은 `installId`, 익스텐션은 활성화에 묶인 코디네이터 id가 아닌 산출물 세대 id)와 구성 요소마다 `approvalDigest`를 담고, 설치·게시 직렬화 아래에서 다시 대조하며, 다르면 아무것도 승인하지 않음 |
