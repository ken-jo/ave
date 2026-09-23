# 멀티 소스 Git 마켓플레이스 — 설계서

> 상태: **제안 — 방향 확정, 미구현** (2026-09-23). 영어 원문
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
| **핀(Pin)** | 소스를 현재 읽고 있는 커밋 SHA. |
| **스냅숏** | 한 소스의 한 핀에서 파싱·검증한 카탈로그. 불변. |
| **설치 계획** | 한 패키지 버전에 대해 리졸버가 할 일. 스냅숏 커밋 하나에 묶임: 아티팩트 단계, 파일, 런처, 필요한 동의. |
| **단계(Rung)** | 플러그인 아티팩트 사다리의 한 단계: `release`, `archive`, `tree`. |

## 2. 클라이언트 디스크 상태

```
~/.ave/
  installation-id                     # random UUID, local only (rollout bucketing)
  marketplaces/
    sources.json                      # custom and direct sources (§2.1)
    <sourceId>/
      repo.git/                       # bare partial clone (blob:none)
      snapshots/<commit>.json         # validated snapshots (§2.2)
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
  url: string;                // stored in normalized form (§7.1); http only for policy-listed hosts
  ref?: string;               // branch or tag; default = remote HEAD
  subdir?: string;            // direct sources only: package path inside the repo
  auth: { kind: "none" } | { kind: "token"; host: string } | { kind: "ssh" };
  addedAt: string;            // ISO-8601
  label?: string;             // user-visible override of displayName
}

interface SourceState {       // marketplaces/<id>/state.json, every origin
  pinnedCommit: string | null;   // 40-hex; null until the first successful sync
  enabled: boolean;              // browsing and installing only (§7.3)
  lastSync?: { at: string; result: "ok" | ErrorCode; candidate?: string };
  pendingRewrite?: { candidate: string; seenAt: string };   // custom/direct awaiting review
}
```

- 공식 소스는 빌드 상수 `OFFICIAL_MARKETPLACE`(`id: "ave"`, 기본 URL, 선택적
  미러 URL, `auth`)에서 옵니다. 관리(managed) 소스는 시스템 정책 파일(§12)에서
  옵니다. 둘 다 `sources.json`에 저장하지 않고, 상태만 `state.json`에 둡니다.
- 이 설계를 구현하는 동안 공식 저장소는 프라이빗입니다
  (`https://github.com/ken-jo/ave-marketplace-index`, 2026-09-23 결정.
  `former_org` 조직에서는 새 공개 저장소를 만들거나 CI를 돌릴 수 없기
  때문입니다). 그래서 상수는 `auth: { kind: "token", host: "github.com" }`을
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
  제공하고, 복구될 때까지 쓰기를 거부해 사용자가 추가한 항목을 덮어쓰지
  않습니다.
- `state.json`을 읽을 수 없으면 그 소스의 동기화는 파일 이름을 밝히며
  실패합니다. 핀이 없는 새 소스로 취급하지 않습니다. 첫 동기화는 어떤 이력도
  받아들이기 때문입니다. `repo.git`이나 `snapshots/`가 있는데 `state.json`이
  없는 것도 같은 실패입니다. 동기화는 저장소를 만들기 전에 상태를 먼저 쓰므로,
  그런 모습은 파일을 잃었을 때만 생깁니다.

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
  rung: "release" | "archive" | "tree" | "legacy";   // "legacy": bound by the §16.3 migration, no digest yet
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

## 3. 마켓플레이스 저장소 레이아웃

### 3.1 공식 모노레포

```
marketplace.json                 # index (generated by CI, committed)
plugins/<name>/ave-package.json # release/archive pins; optional built tree (plugin.json, dist/)
mcp/<name>/ave-package.json     # + optional server.json
skills/<name>/                   # ave-package.json, SKILL.md, resources
agents/<name>/                   # ave-package.json, AGENTS.md
themes/<name>/                   # ave-package.json, theme.json
fonts/<name>/                    # ave-package.json, font.json, files/
languages/<locale>/              # ave-package.json, language.json, messages.json
providers/<name>/                # ave-package.json, provider.json
messaging/<name>/                # ave-package.json, connection.json
policy/revocations.json          # revocations of this repository's own packages
.github/CODEOWNERS
.github/workflows/               # validate, index, release-pin
```

### 3.2 커스텀 마켓플레이스

레이아웃은 같고, 선택적인 `policy/revocations.json`도 둘 수 있습니다. 이 파일은
언제나 그 소스에서 설치한 패키지에만 적용됩니다(§10.4). `marketplace.json`은
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
아티팩트 핀을 수정하는 자동화는 release-pin 워크플로(§6.3) 하나뿐입니다.

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
| `skill` | `{ entry: "SKILL.md" }` | `SKILL.md`, `references/**`, `assets/**` |
| `agent` | `{ entry: "AGENTS.md" }` | `AGENTS.md` |
| `theme` | `{ entry: "theme.json" }` | `theme.json`, 미리보기 이미지(선택) |
| `font` | `{ entry: "font.json" }` | `font.json`, `files/*.woff2\|woff\|ttf\|otf`, `LICENSE` |
| `language` | `{ locale: string; entry: "language.json"; messages: "messages.json" }` | 그 두 JSON 파일 |
| `provider` | `{ entry: "provider.json" }` | `provider.json`(현재 `MarketplaceProviderPackageAsset`에서 `type` 제외) |
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
    sha256: string;     // required: the rung is used only with a pin stored in git
  };
  archive?: { url: string; sha256: string };
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
  (`src/mcp/safe-names.ts`)을 쓸 수 없습니다.
- 실행되는 MCP 코드는 커밋이 고정합니다. `npx` 패키지는
  `<package>@<정확한 버전>`, `uvx` 패키지는 `<package>==<정확한 버전>`, docker
  이미지는 `latest`가 아닌 태그나 `@sha256:` 다이제스트를 가져야 합니다.
  디스크립터가 직접 쓴 스펙에서는 옵션이 아닌 첫 인자가 패키지나 이미지이므로,
  그 앞의 옵션은 `--name=value` 형태로 씁니다.
- `server.json`(스키마 2025-12-11)은 다음과 같이 스펙으로 옮깁니다. npm →
  `npx [runtimeArguments] -y <identifier>@<version> [packageArguments]`,
  pypi → `uvx [runtimeArguments] <identifier>==<version> [packageArguments]`,
  oci → `docker run -i --rm [runtimeArguments] <identifier>[:<version>]
  [packageArguments]`, `streamable-http` 원격 → `http`. 인자와 변수는 `value`,
  없으면 `default`를 쓰고, 이름 있는 인자는 `name value`가 됩니다. `isSecret`
  변수나 헤더 하나는 `auth: "api-key"`와 함께 `apiKeyEnv`나 `apiKeyHeader`가
  됩니다. 거부: `sse`, 다른 레지스트리나 기본값이 아닌 `registryBaseUrl`, stdio가
  아닌 전송을 쓰는 패키지, `{variable}` 템플릿과 `variables`, 값이 없는 필수
  입력, 고정 값을 가진 원격 헤더, 둘 이상의 비밀. `select`는 패키지 하나나 원격
  하나를 고르며, 없으면 첫 패키지, 그것도 없으면 첫 원격을 씁니다.
- 패키지 로컬 명령은 버전 커밋에서 내보낸 패키지의 `server/` 디렉터리에서
  실행하며, 그 디렉터리에 명령 파일이 있어야 합니다. MCP 아티팩트 저장소가 그
  파일을 설치하고 `$PLUGIN_DIR`이 그곳을 가리킵니다. 패키지 파일 없는
  `$PLUGIN_DIR`과 `$PYTHON`은 거부합니다.

### 5.3 플러그인 매니페스트 변경

git 소스에서 설치하는 플러그인은:

- `extensions["ai.agent-connector.ave"].requires.minAppVersion`이 **필수**이고(로컬 개발
  설치에서는 스키마상 선택으로 남김), 디스크립터의 `minAppVersion`과 같아야
  합니다.
- `PluginAuthority`의 모든 필드가 스테이징된 `plugin.json`과 같아야 합니다.

매니페스트 스키마, SDK 사본, `manifest-validation.ts`와 그 테스트에서 한 번의
변경으로 제거합니다(청사진 6단계):

- `extensions["ai.agent-connector.ave"].installPolicy` — 관리 패키지가 더는 없습니다(§10.1).
  설치 계획(스테이징과 인덱스 CI)은 이 필드가 남아 있는 매니페스트를 필드 이름을
  밝힌 메시지와 함께 거부합니다. 런타임 로더는 거부하지 않습니다. 지금 설치된 공식
  플러그인은 모두 이 필드를 갖고 있으므로, 필드가 있는 설치본 매니페스트는
  지금처럼 로드되고 필드는 무시되며 플러그인마다 경고를 한 번 남깁니다. 다음
  업데이트가 매니페스트를 바꿀 때까지 그렇습니다(§16.3). 공식 플러그인 레포는 이
  설계 아래 첫 릴리스에서 필드를 뺍니다(청사진 0.5단계). 필드 고정 버전(§16.3)은
  기존 설치본만을 위한 것이라 필드를 그대로 두며, 그런 버전으로 해석되는 설치는
  같은 이름 명시 거부로 실패합니다.
- `extensions["ai.agent-connector.ave"].publisher` — D4에서는 이 필드가 가리킬 검증된 게시자
  신원이 없습니다.

### 5.4 콘텐츠 검증 한도

| 종류 | 최대 합계 | 최대 파일 수 | 허용 확장자 |
|---|---|---|---|
| skill | 2 MB | 64 | `.md .txt .json .yaml .yml .png .jpg .webp` |
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
   `upgrade_required`로 표시합니다.

### 6.2 플러그인 아티팩트 사다리

```
plan = { snapshotCommit, versionCommit, rungs: [] }        // fixed at plan time
for rung in [release, archive, tree]:
  if rung not declared                               -> skip(rung, NOT_DECLARED)
  if rung in {release, archive} and no sha256 pin    -> skip(rung, ARTIFACT_NOT_PINNED)
  fetch rung                                          // every URL passes §7.4 first
    release: https GET (token only to the origin host; auth headers stripped on cross-host redirects)
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
  내보낸 파일은 zip으로 묶으므로 모든 단계가 같은 zip 사전 점검과 설치
  파이프라인을 거칩니다.
- `url`이 없는 release는
  `https://<소스 호스트>/<repo>/releases/download/<tag>/<asset>`에서 받습니다
  (정책이 허용한 http 호스트면 소스의 스킴). 소스가 `github.com`에서 토큰 인증을
  쓰고 토큰이 저장되어 있으면 GitHub REST API로 받습니다.
  `api.github.com/repos/<repo>/releases/tags/<tag>`에서 자산 id를 얻고
  `…/releases/assets/<id>`를 `Accept: application/octet-stream`으로 요청합니다.
  비공개 저장소를 내주는 경로가 이것이기 때문이며, 응답이 리디렉트하는 저장소
  호스트에는 토큰이 가지 않습니다(§7.4). 이 경로에는 정책 허용 목록이
  `api.github.com`을 허용해야 합니다.
- release와 archive 다운로드는 아티팩트 한도를 넘을 수 없고, 60초 동안 데이터가
  없으면 실패합니다.

### 6.3 공식 릴리스 흐름

1. 플러그인 자체 저장소가 `vX.Y.Z` 태그를 달면, 그 저장소의 릴리스 워크플로가
   `{name}-{X.Y.Z}.zip`을 빌드해 **그 저장소**의 릴리스 자산으로 올립니다.
2. 공식 마켓플레이스의 `release-pin` 워크플로(또는 사람)가 내려받은 자산으로
   계산한 `plugins/<name>/ave-package.json`의 `version`, `minAppVersion`,
   `authority`, `artifact.release`(`repo`, `sha256`)를 설정하는 PR을 엽니다.
3. CI가 자산 해시를 검증하고, 풀어서 `plugin.json`을 디스크립터와 대조하고,
   인덱스를 다시 만듭니다.
4. 머지 = 게시.

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
- 거부: `file:`, `ext::`, 그 밖의 스킴, URL 안의 자격 증명, 쿼리, 프래그먼트.

정책 allow/block 매칭(§12), 예약 이름 검사, 토큰 조회, 중복 감지는 모두 정규화된
형태를 씁니다. 이 비교에서 저장소의 동일성은 호스트와 대소문자를 무시한 경로이며,
스킴과 포트는 따지지 않습니다(§12).

### 7.2 추가 (미리보기 → 확정)

1. 입력을 **정규화**하고(§7.1) 네트워크 게이트(§7.4)를 적용합니다. 평문
   `http://`는 `marketplaces.allowHttpHosts`에 있는 호스트만 받습니다. 개발·테스트
   빌드는 지금의 `cloudAllowPrivateNetwork`처럼 루프백도 허용할 수 있습니다.
2. `git ls-remote`로 **탐색**합니다. 인증 실패는 `SOURCE_AUTH_REQUIRED`이고
   대화상자가 토큰을 묻습니다. 모르는 SSH 호스트 키는 `SOURCE_SSH_HOST_UNKNOWN`,
   없는 ref는 `SOURCE_REF_NOT_FOUND`입니다.
3. ref를 임시 bare 저장소로 **가져와** 루트를 읽습니다.
4. **분류**: 마켓플레이스(인덱스 또는 관례 레이아웃) → 미리보기, 단일 패키지(루트나
   지정한 하위 경로의 디스크립터, `plugin.json`, `SKILL.md`, `AGENTS.md`,
   `server.json`) → 직접 설치 미리보기, 그 밖에는 `SOURCE_NOT_A_MARKETPLACE`.
5. **미리보기**는 `previewId`(1회용, 10분 뒤 만료, 만료나 취소 시 임시 저장소
   삭제), 해석된 커밋, 마켓플레이스 이름과 소유자, 종류별 패키지 수, 코드를
   실행하는 패키지 수(플러그인 + MCP), 검증 진단을 돌려줍니다.
6. **확정**하면 항목을 쓰고, 소스의 `state.json`을 쓴 다음 임시 저장소를
   제자리로 옮기고 스냅숏을 게시합니다(상태 없이 `repo.git`만 있으면 상태를
   잃은 것으로 읽습니다, §2.1). id 기본값은 인덱스 `name`이고, 예약되었거나 이미
   쓰는 id(`SOURCE_ID_TAKEN`)면 다른 id를 묻고, 형식이 틀린 id는
   `SOURCE_ID_INVALID`입니다.

### 7.3 동기화

부팅 직후(비차단), 실행 중 `marketplace.updateCheckIntervalMs`마다, 그리고
수동으로 실행합니다. 설정은 키와 `0` = 주기 동기화 없음이라는 의미를 유지하지만,
한 번의 틱이 이제 모든 소스를 fetch하므로 코드 기본값은 지금의 10분에서 6시간으로
바뀌고, 저장된 값이 15분보다 작으면 읽을 때 15분으로 올립니다. 이 설정은 선택
항목이고 기본으로 비어 있으므로 이관할 저장값은 없습니다. 소스는 켜져 있을 때 **또는** 그 소스에 묶인 설치
패키지가 하나라도 있을 때 동기화하므로, 숨긴 소스에서 설치한 패키지에도 폐기와
업데이트 알림이 계속 도착합니다.

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

마켓플레이스가 닿는 모든 네트워크 대상(git 원격, release·archive URL, 서비스
엔드포인트)은 하나의 게이트를 지납니다.

1. 정규화(§7.1, `https` 다운로드도 같은 호스트/포트/경로 규칙: 퍼센트 인코딩은
   정규형으로 바꾸고, 빈 세그먼트·`.`·`..`는 거부);
2. 관리 정책 `marketplaces.block`, 그다음 `marketplaces.allow`(있을 때) 적용.
   다운로드에서는 정확한 저장소 패턴이 그 저장소 아래의 모든 경로
   (`…/acme/tools/releases/download/…`)도 덮습니다. git 원격에서는 그 저장소만
   가리킵니다. 하위 그룹이 있는 호스트에서는 중첩 경로가 다른 저장소이기
   때문입니다;
3. 지금 `cloud-marketplace-fetcher.ts`에 있는 사설망 가드 적용(그 파일을 지울 때
   공용 모듈로 이동): 루프백, 링크 로컬, 사설, 메타데이터 주소는 정책에 등록된
   호스트이거나 개발 빌드가 루프백을 허용할 때가 아니면 거부. NAT64 주소
   (`64:ff9b::/96`)는 안에 담긴 IPv4 주소로 판단;
4. git은 리다이렉트를 따라가지 않습니다(`http.followRedirects=false`). HTTPS
   다운로드는 새 URL에 이 게이트를 다시 적용한 뒤에만 리다이렉트를 따르고,
   다른 호스트로 인증 헤더를 넘기지 않습니다.

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

## 8. 직접 설치 (마켓플레이스 매니페스트 없음)

### 8.1 입력

| 입력 | 감지 | 결과 |
|---|---|---|
| Git URL(+ 선택적 하위 경로, ref) | 경로에서 처음 맞는 것: `ave-package.json` → `plugin.json`(Agent Plugins) → `SKILL.md` → `AGENTS.md` → `server.json` | 그 패키지에 대한 `direct` 소스 항목 |
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
  `0.0.0+g<commit12>`. 코드를 실행하지 않는 종류이므로 `minAppVersion` 기본값은
  `0.0.0`.
- `server.json` → 파일의 `version`, `minAppVersion`은 `0.0.0`.

직접 설치 패키지는 ref가 더 높은 버전을 선언한 후손 커밋으로 움직이면(합성
`0.0.0+g…` 버전이면 새 커밋마다) 마켓플레이스 패키지와 같은 업데이트 검토를 거쳐
업데이트됩니다.

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

환경(두 모드 공통):

- `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=<Ave가 만든 파일>`(아래), `LC_ALL=C`.
- `GIT_ASKPASS=<Ave askpass 헬퍼>`, `SSH_ASKPASS_REQUIRE=never`,
  `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`(모르는 호스트 키는 프롬프트를
  기다리지 않고 `SOURCE_SSH_HOST_UNKNOWN`으로 바로 실패).
- `GIT_ALLOW_PROTOCOL=https:ssh`, 소스 호스트가 `marketplaces.allowHttpHosts`에
  있을 때만 `http` 추가. 원격이 없는 호출은 `none`.
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
tier-3 우회, `schemas/sdk/skill-package.schema.json`의 `installPolicy` 속성과 그
SDK 사본(두 저장소에서 같은 변경). 관리 동작을 검증하던 테스트는 지우지 않고
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
- 소스에 아직 스냅숏이 없거나(오프라인 첫 부팅) 설치가 실패한 키는 기록하지 않고
  다음 부팅에서 다시 시도합니다. 읽을 수 없는 `default-installs.json`은 기본
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
  사용자의 소스 선택보다 정책이 우선합니다. 같은 상황의 `defaultInstalls` 항목은
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
  `https://former-site.invalid`). 사용자 설정은 없습니다.
- **도메인 변경.** `movedTo`는 현재 base에서 https로 받은 경우에만, 그리고 새
  base의 서비스 문서가 `movedFrom`에 현재 base를 적어 확인해 준 뒤에만
  받아들입니다. 받아들인 이전은 그때의 빌드 상수와 함께 저장되며, 앱 업데이트가
  다른 상수를 싣고 오면 버립니다. 빌드 상수당 최대 한 번만 따릅니다.
- `announcements`와 `telemetry`는 서비스 오리진의 경로여야 합니다.
- 공지는 `MarketplaceAnnouncement` 계약(수준, `startsAt`/`endsAt`, 최대 세 개의
  탐색 전용 액션, 앱 버전 필터 액션)과 닫은 id 동작을 유지합니다. 활성 로케일이
  공지에 없는 설치 언어이면 액션 라벨은 `en` 라벨로 대체합니다. 부팅 직후와
  6시간마다 가져옵니다.
- 정적 파일은 ave `web/` 사이트(`web/public/.well-known/`,
  `web/public/announcements/`)에 두고, 기존 수동 프로덕션 게이트로 배포합니다.

## 12. 관리 정책 추가 항목

```jsonc
// policy.json (system scope)
"marketplaces": {
  "allow": ["https://github.com/acme/*", "host:git.corp.example"],  // absent = no restriction
  "block": ["host:git.example.org"],
  "allowHttpHosts": ["git.corp.example"],                           // plain-http git hosts; default none
  "allowDirectInstall": true,
  "allowDisablingOfficial": false,
  "additional": [{ "id": "corp", "url": "https://git.corp.example/ave/marketplace.git" }],
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
- 정책이 이름을 댄 호스트(`allowHttpHosts`, `allow` 패턴, `additional` 소스에
  나오는 호스트)는 사설(RFC 1918, ULA)·CGNAT 주소로 해석되어도 됩니다(§7.4).
  link-local과 메타데이터 주소는 이들에게도 계속 거부합니다.
- 호스트 필드(`host:` 패턴, `allowHttpHosts`, `auth.host`)에는 포트를 쓰지
  않습니다. 토큰의 `auth.host`는 소스 자신의 호스트여야 합니다.
- 이 섹션은 적힌 그대로만 읽습니다. 알 수 없는 키, 중복 키, 목록 자리의 `null`,
  파싱되지 않는 패턴,
  정책 자신의 목록이 막는 `additional` 소스, 공식도 `additional`도 아닌 소스를
  지정한 설치 항목이 하나라도 있으면 섹션 전체가 무효이고, 파일을 고칠 때까지
  공식 외 모든 소스가 `SOURCE_POLICY_BLOCKED`입니다. 오타가 열린 쪽으로 실패해서는
  안 됩니다.
- `additional` 소스는 `managed` 출처로 미리 등록됩니다. 사용자는 제거하거나 숨길
  수 없고, 이력 규칙은 공식 소스와 같습니다.
- `defaultInstalls`와 `requiredInstalls`는 §10.2를 따르며 공식·관리 소스만 지정할
  수 있습니다. 두 목록에 모두 있는 키는 필수로 취급합니다.

## 13. IPC 계약

| 채널 | 요청 | 응답 |
|---|---|---|
| `ave:marketplace:sources:list` | — | `SourceView[]` |
| `ave:marketplace:sources:preview` | `{ input: string; ref?: string; token?: string }` | `SourcePreview \| DirectPackagePreview` |
| `ave:marketplace:sources:add` | `{ previewId: string; id?: string }` | `SourceView` |
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
| `ave:git:runtime:status` | — | `GitRuntimeStatus` |
| `ave:git:runtime:install` | — | `GitRuntimeStatus`(진행은 이벤트로) |

이벤트: `marketplace:sync-progress`, `marketplace:catalog-changed`,
`marketplace:install-progress`(`{ planId, rung, phase, bytes? }`),
`marketplace:updates-available`(유지), `marketplace:boot-installs-applied`(기본·필수
설치), `git-runtime:progress`.

모든 채널은 호스트 렌더러 전용(`validateHostRendererSender`)이고 지금처럼 감사
로그를 남깁니다. `ave:git:runtime:install`은 여기에 더해 실시간 키보드 제스처를
요구합니다. 마켓플레이스가 실행할 바이너리를 내려받기 때문입니다. `planId`와 `previewId`는 1회용이고 10분 뒤 만료됩니다
(`PLAN_EXPIRED`). 현재 채널의 처리는 §16.2에 있습니다.

## 14. 오류 코드

| 코드 | 언제 | 사용자 메시지(en 키) |
|---|---|---|
| `GIT_RUNTIME_MISSING` | 쓸 수 있는 git 없음 | `marketplace.error.gitMissing` |
| `GIT_RUNTIME_TOO_OLD` | `system` 모드에서 시스템 git이 2.45.1 미만 | `marketplace.error.gitTooOld` |
| `GIT_RUNTIME_INSTALL_FAILED` | 관리형 다운로드/검증/압축 해제/스모크 테스트 실패 | `marketplace.error.gitInstallFailed` |
| `SOURCE_URL_REJECTED` | 스킴, URL 안의 자격 증명, 사설망 대상 | `marketplace.error.urlRejected` |
| `SOURCE_POLICY_BLOCKED` | 관리 정책 allow/block | `marketplace.error.policyBlocked` |
| `SOURCE_NAME_RESERVED` | 예약된 id | `marketplace.error.nameReserved` |
| `SOURCE_ID_INVALID` | id가 2–63자의 소문자·숫자·`-`가 아님 | `marketplace.error.idInvalid` |
| `SOURCE_ID_TAKEN` | 이미 쓰는 id | `marketplace.error.idTaken` |
| `SOURCE_AUTH_REQUIRED` | 401/403, ssh 거부 | `marketplace.error.authRequired` |
| `SOURCE_SSH_HOST_UNKNOWN` | known_hosts에 없는 호스트 키 | `marketplace.error.sshHostUnknown` |
| `SOURCE_REF_NOT_FOUND` | 브랜치나 태그 없음 | `marketplace.error.refNotFound` |
| `SOURCE_UNREACHABLE` | 네트워크, DNS, 타임아웃 | `marketplace.error.unreachable` |
| `SOURCE_NOT_A_MARKETPLACE` | 인식할 수 있는 것이 없음 | `marketplace.error.notMarketplace` |
| `SOURCE_INDEX_INVALID` | 인덱스 검증 실패 | `marketplace.error.indexInvalid` |
| `SOURCE_HISTORY_REWRITTEN` | 후손이 아닌 후보 | `marketplace.error.historyRewritten` |
| `SOURCE_DISABLED` | 숨긴 소스에서 설치·업데이트 요청 | `marketplace.error.sourceDisabled` |
| `PLAN_EXPIRED` | 만료되었거나 재사용된 계획/미리보기 id | `marketplace.error.planExpired` |
| `PACKAGE_INCOMPATIBLE` | `minAppVersion`이 앱 버전보다 높음 | `marketplace.error.incompatible` |
| `PACKAGE_COMPAT_UNDECLARED` | `requires.minAppVersion` 없는 git 설치 플러그인 | `marketplace.error.compatUndeclared` |
| `PACKAGE_YANKED` / `PACKAGE_REVOKED` | 회수/폐기된 버전 설치 | `marketplace.error.yanked` / `.revoked` |
| `PACKAGE_ID_CONFLICT` | 같은 `(kind, name)`이 다른 소스에서 설치됨 | `marketplace.error.idConflict` |
| `PACKAGE_REQUIRED_BY_POLICY` | `requiredInstalls` 패키지의 제거·비활성화 | `marketplace.error.requiredByPolicy` |
| `ARTIFACT_NOT_PINNED` | 단계 건너뜀: git에 sha256 없음 | (단계 상세) |
| `ARTIFACT_DIGEST_MISMATCH` | sha256 불일치 | (단계 상세) |
| `MANIFEST_MISMATCH` | plugin.json과 디스크립터 불일치 | `marketplace.error.manifestMismatch` |
| `NO_INSTALLABLE_ARTIFACT` | 모든 단계가 건너뛰어졌거나 실패 | `marketplace.error.noArtifact` |
| `CONTENT_RULE_VIOLATION` | 콘텐츠 종류 파일 규칙 위반 | `marketplace.error.contentRule` |

## 15. UI 명세

목업은 아래 모든 상태를 보여 줍니다. 설정 → 마켓플레이스가 앱 안의 스토어가
됩니다(웹 스토어는 없어짐).

### 15.1 둘러보기

- 헤더: 검색창, **Sources** 버튼, **Add** 메뉴(Add marketplace…, Install from
  Git URL…, Add MCP server…), 소스 필터 칩(All sources + 켜진 소스마다 하나).
- 종류 탭: Plugins, MCP, Skills, Agents, Themes, Fonts, Languages, Providers,
  Messaging — 각각 개수 표시.
- 카드: 아이콘, 표시 이름, 한 줄 설명, **소스 배지**(`Ave Official`은 방패
  글리프, 관리 소스는 건물 글리프와 라벨, 커스텀 소스는 id), 버전, 상태 칩:
  `Install`, `Installed`, `Update 1.4.2`, `Requires Ave 0.12`, `Yanked`,
  `Installed from <다른 소스>`, `Source removed`, `Required by your organization`
  (제거·비활성화 컨트롤 없음, 툴팁이 정책 파일을 알려 줌).
- 두 소스에 같은 이름: 배지가 각각 붙은 카드 두 장. 행을 합치지 않습니다. 두 번째
  것을 설치하면 소스 전환이 됩니다(`PACKAGE_ID_CONFLICT`가 설명하고 전환을 제안).
- 부팅 설치 알림(§10.2)은 설치·업데이트한 항목을 나열하는 배너로 한 번
  나타나며, "Installed for you"(기본 설치, 제거 버튼 있음)와 "Required by your
  organization"으로 나뉩니다.

### 15.2 패키지 상세(시트)

섹션: 개요, **출처**(소스, 저장소, 경로, 짧은 커밋 SHA — 툴팁에 전체 SHA와 복사
버튼, 게시일), **호환성**(`minAppVersion`과 판정), **권한**(다운로드 전에
디스크립터의 authority에서), **전달**(단계 목록과 쓰일 단계), **버전**(회수·비호환
표시가 있는 이력).

### 15.3 설치 진행

시트 안에서: `skipped`/`failed`/`using` 단계 행과 다운로드 진행 막대, 그다음 기존
권한 검토 단계, 그다음 결과. 실패하면 모든 단계의 사유와 복사할 수 있는 진단을
보여 줍니다.

### 15.4 소스

표: 소스(라벨, URL, 출처 배지), 핀 커밋(툴팁이 있는 짧은 SHA, 마지막 동기화
상대 시각), 패키지 수, 상태(`Up to date`, `Syncing`,
`Unreachable — showing cached`, `Auth required`, `History rewritten — review`),
켜기 스위치, 더보기 메뉴(Refresh, Set token, Remove). 공식·관리 행에는 Remove가
없고, 공식 스위치는 정책이 허용하지 않으면 잠겨 있고, 관리 행에는 자물쇠가
표시됩니다.

### 15.5 마켓플레이스 추가 대화상자

1단계: URL 입력(`owner/repo` 허용), 선택적 ref, 인증 라디오(None / Token / SSH).
2단계(미리보기): 마켓플레이스 이름, 소유자, 커밋, 종류별 개수, "N개 패키지가 이
컴퓨터에서 코드를 실행할 수 있음" 경고, 이 호스트에 OS 자격 증명 헬퍼가 응답할
때의 안내, 진단, id 입력. 확정 버튼: **Add marketplace**. 입력이 단일 패키지면
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
  핀합니다(청사진 0단계). 맞는 핀이 없는 항목은 업데이트할 때까지 grant를 잃고,
  부팅 알림이 어느 플러그인이 어느 키를 잃었는지 알려 줍니다.
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

## 17. 테스트 계획

| 계층 | 무엇으로 증명하는가 |
|---|---|
| 스키마 | 모든 종류의 픽스처 세트: 정상, 규칙별 위반, 알 수 없는 키. `installPolicy`가 있는 매니페스트는 설치와 인덱스 CI에서 필드 이름과 함께 거부, 필드가 있는 legacy 설치본은 경고 한 번과 함께 로드 |
| 버전 선택 | `minAppVersion`, 회수, 플랫폼, 프리릴리스 옵트인, 롤아웃 버킷, 소스별 폐기 표 테스트 |
| 사다리 | 단계별 사용/건너뜀/실패 조합, authority 필드 하나라도 불일치하면 사다리 중단, 계획이 커밋에 묶임, 영수증에 단계 결과 기록 |
| Git 런타임 | 버전 게이트용 가짜 `git` 바이너리(2.45.0 거부, 2.45.1 허용), 환경/플래그/전역 설정 계약, askpass 티켓의 호스트 바인딩, 로컬 픽스처 서버를 쓴 관리형 설치와 잘못된 해시 거부 |
| 동기화 | 로컬 bare 저장소: 핀이 팁보다 한참 뒤인 fast-forward, 재작성(공식·관리는 거부, 커스텀은 검토), 잘못된 인덱스는 핀 유지, 미러 대체, 설치 패키지가 있는 숨긴 소스도 동기화 |
| 네트워크 게이트 | 정규화 동치(scp/ssh/https, 대소문자, `.git`), block이 allow보다 우선, 사설망 거부, 차단된 호스트로의 리다이렉트 거부, 호스트 간 인증 헤더 없음 |
| 특권 없음 | grant 대상과 같은 이름의 커스텀 패키지는 grant 없음, 다른 아티팩트 해시·tree 단계 설치·바뀐 매니페스트면 grant 실패, legacy 항목은 영수증 해시가 맞을 때만 grant 유지, 한 소스의 폐기는 다른 소스 패키지를 무시, 어떤 패키지도 자기 제거를 막지 못함, `installPolicy`가 있는 매니페스트는 설치에서 거부 |
| 기본·필수 설치 | 기본: 사다리로 한 번 설치, 제거 후 재설치 없음. 필수: 부팅 때 재설치·업데이트, 제거·비활성화는 `PACKAGE_REQUIRED_BY_POLICY`로 거부, 항목을 빼면 사용자 설치가 됨. 두 목록 모두 공식·관리 소스로 제한. 이관은 이전 admin 설치를 적용됨으로 기록하고 맞지 않는 항목의 잠금을 해제 |
| 식별 | 예약 이름, 소스 간 같은 `(kind, name)`, `PACKAGE_ID_CONFLICT`, 업데이트 바인딩, 소스 전환 시 플러그인 데이터 유지 |
| 직접 설치 | 감지 분기별, npm/pypi/oci/remote에 대한 `server.json` 대응 |
| 서비스 | `former-service.json` 파싱, `movedFrom` 있을 때와 없을 때의 `movedTo`, 빌드 상수 변경 시 초기화, 정책 우선, 공지 동등성, 라벨 대체 |
| E2E | 패키징된 개발 빌드(개발 플래그로 루프백 허용)에서 로컬 HTTP git 마켓플레이스를 추가하고, 종류별로 하나씩 설치하고, 업데이트하고, 소스를 제거 |
