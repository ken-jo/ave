# Git 마켓플레이스에 게시하기

> **상태**: 현행 (2026-09-25). [멀티 소스 git 마켓플레이스](../blueprints/multi-source-git-marketplace.md)
> 6단계에서 제거된 서버 마켓플레이스의 퍼블리셔 흐름을 대신합니다. 영어 원문
> [../../guides/marketplace-publishing.md](../../guides/marketplace-publishing.md)이
> 기준이고, 이 문서는 그 한국어 미러입니다. 내용이 다르면 영어 원문을 따릅니다.

마켓플레이스는 git 저장소입니다. 앱은 git으로 저장소를 읽고, 읽은 내용을 커밋에
고정하며, 그 커밋이 가리키는 바이트로만 패키지를 설치합니다. 업로드·승인 대기열·퍼블리셔
키는 없습니다. 게시는 머지이고, 저장소의 브랜치 보호가 검토입니다. 아래 형식은 모두
[설계서](../design/multi-source-git-marketplace.md)가 소유하며, 이 문서는 작성자를
위한 안내입니다.

## 어떤 마켓플레이스인가

| 소스 | 누가 추가하나 | 할 수 있는 것 |
|---|---|---|
| 공식(`ave`) | 앱에 내장 | 플러그인이 호스트 시크릿 부여를 받을 수 있는 유일한 소스(§10.3) |
| 관리형 | 시스템 정책 파일(`marketplaces.additional`) | 정책의 `defaultInstalls`·`requiredInstalls`에 패키지를 올릴 수 있음 |
| 사용자 지정 | 사용자, 설정 → 마켓플레이스 → 추가 | 일반 설치 |
| 직접 | 사용자, git 폴더 하나에서 | 패키지 하나, 인덱스 없음 |

실행 중에 패키지가 할 수 있는 일은 소스와 상관없이 같습니다. 어떤 패키지도 스스로를
잠그거나, 스스로에게 시크릿을 부여하거나, 다른 소스의 패키지를 폐기할 수 없습니다.

## 저장소 구조

```
marketplace.json                 인덱스 (schemas/marketplace/index.schema.json)
policy/revocations.json          선택 (schemas/marketplace/revocations.schema.json)
<kind dir>/<name>/ave-package.json   패키지마다 설명자 하나 (package.schema.json)
<kind dir>/<name>/...            패키지 파일
```

`marketplace.json`은 마켓플레이스 이름을 정하고 패키지마다 `kind`, `name`, `path`를
나열합니다. 패키지 항목은 `versions[]`(최신순)를 가질 수 있고, 각 항목은 `version`을
그 버전을 게시한 `commit`에 고정합니다. `versions[]`가 없으면 앱은 동기화한 커밋의
설명자를 읽습니다. 종류는 `plugin`, `mcp`, `skill`, `agent`, `theme`, `font`,
`language`, `provider`, `messaging-connection`입니다. 이름은 소문자·하이픈이고,
마켓플레이스 안에서 종류마다 유일합니다.

`ave-package.json`에는 `schemaVersion: 1`, `kind`, `name`, `version`,
`minAppVersion`과 종류별 `payload`가 있습니다.

| 종류 | payload와 파일 |
|---|---|
| `skill` | `entry: "SKILL.md"`; `scripts/`, `references/`, `assets/`, `LICENSE`, `NOTICE` |
| `agent` | `entry: "AGENTS.md"`만 |
| `theme` | `entry: "theme.json"`과 선택적 미리보기 이미지. 대비 규칙을 강제합니다 |
| `font` | `entry: "font.json"`, `LICENSE`, `files/` 아래 글꼴 파일(`.woff2`, `.woff`, `.ttf`, `.otf`) |
| `language` | `locale`, `language.json`, `messages.json`(영어 카탈로그의 인터페이스 키만) |
| `provider` | `entry: "provider.json"`(프로바이더 프리셋) |
| `messaging-connection` | `entry: "connection.json"` |
| `mcp` | `server`(정확한 버전의 stdio 런처 `npx`/`uvx`/`docker`, 패키지 안의 `server/…` 명령, 또는 Streamable HTTP) 또는 공식 MCP `server.json`을 가리키는 `serverJson` |
| `plugin` | `authority`(`plugin.json`에서 복사)와 `artifact` 고정값 |

SVG는 모든 종류에서 거부합니다. 크기·파일 수 제한은 설계서 §5.4에 있습니다.

## 플러그인

플러그인의 `artifact`는 바이트를 어디서 가져올지 정합니다. 앱은 다음 순서로 시도합니다.

1. `release` — GitHub 릴리스 자산. `sha256` 고정이 있을 때만 씁니다.
2. `archive` — https zip. `sha256` 고정이 있을 때만 씁니다.
3. `tree` — 고정 커밋에서 패키지의 `plugin.json`, `dist/`, `assets/`(그 밖의 파일은
   둘 수 없음).

전송이나 체크섬이 실패하면 다음 단계로 넘어갑니다. 스테이징한 `plugin.json`이 설명자와
다르면 설치가 멈춥니다(`MANIFEST_MISMATCH`). `extensions["ai.agent-connector.ave"].requires.minAppVersion`은
필수이고 설명자의 `minAppVersion`과 같아야 하며, 권한 필드(`capabilities`,
`networkAccess`, `hostSecrets`, `pluginAccess`, `auth`, `requires`)는 모두 설명자의
사본과 같아야 합니다. 폐기된 `installPolicy`나 `publisher`를 선언한 매니페스트는 필드
이름을 밝혀 거부합니다.

호스트 시크릿 부여는 공식 스냅숏이 고정한 release나 archive로 설치된 공식 플러그인만,
앱의 `HOST_SECRET_GRANTS` 표에 있는 키에 한해 받습니다. tree 설치는 받지 못합니다(설계서 §10.3).

## MCP 서버

MCP 패키지는 앱이 직접 실행하는 코드가 아니라 서버 구성을 설치합니다. 런처 패키지는
정확한 버전을 고정해야 합니다(`@scope/name@1.2.3`, `name==1.2.3`, `latest`가 아닌
이미지 태그나 digest). 패키지 안의 명령은 고정 커밋의 `server/` 파일에서 실행되고,
설치 때 `$PLUGIN_DIR`, `$DATA_DIR`(`~/.ave/mcp-data/<name>`, 업데이트해도 유지),
`$NODE`를 채웁니다. 서버를 구성할 수 있는지는 여전히 MCP 거버넌스가 정합니다. 거버넌스
정책이 승인하지 않은 서버는 `PACKAGE_POLICY_BLOCKED`로 거부합니다.

## 업데이트, 회수(yank), 폐기

- **업데이트:** 새 `version`을 게시합니다. 사용자는 다음 동기화 뒤에 봅니다. 업데이트
  검토 화면은 커밋 범위와 권한 변화를 보여 주고, 새 네트워크 호스트·시크릿·권한은
  사용자의 명시적인 결정을 받아야 합니다.
- **회수:** `versions[]` 항목에 `yanked: { reason, at }`을 넣습니다. 회수한 버전은
  제안하지 않고, 이미 설치된 것은 그대로 둡니다.
- **단계적 배포:** 버전에 `rollout: { percent }`. 프리릴리스 버전은 카나리 빌드를
  고른 사용자에게만 갑니다.
- **폐기:** `policy/revocations.json`에 `{ kind, name, versions, reason, at, action }`을
  나열합니다. 이 소스에서 설치된 것에만 적용되고, `action`은 `disable` 또는
  `uninstall`입니다.

게시한 버전은 `yanked`와 `rollout` 말고는 바꿀 수 없습니다.

## 저장소 검사

앱의 규칙은 `checkMarketplaceRepository`(`src/marketplace/repository-check.ts`)로
내보냅니다. 공식 저장소는 이를 `tools/vendor/`에 넣어 추가 규칙과 함께 CI에서 돌리며,
다른 마켓플레이스도 똑같이 할 수 있습니다. 결과가 비었으면 앱이 모든 패키지를 그대로
받아들인다는 뜻입니다.

## 패키지로 연결하기

`ave://install/<kind>/<name>@<source>`와 `ave://uninstall/<kind>/<name>@<source>`는
마켓플레이스 탭에서 그 패키지를 엽니다. `ave://marketplace/add?url=<저장소>`는 추가
대화상자를 엽니다. 링크는 사용자가 확인하는 화면을 열 뿐입니다. 서버 시절의
`ave://install/<slug>` 형식은 무시합니다.

## 조직

관리자는 시스템 정책 파일의 `marketplaces` 섹션(설계서 §12)으로 사내 마켓플레이스를
추가하고 패키지를 필수로 지정합니다. `additional`은 소스를 등록하고,
`defaultInstalls`는 패키지를 한 번 설치하며, `requiredInstalls`는 패키지를 설치·업데이트된
상태로 유지하고 제거·비활성화를 막습니다. 필수 항목은 그 항목이 가리키는 소스에서
설치된 패키지만 잠급니다.

## 구현 위치

- `schemas/marketplace/*.schema.json`
- `src/marketplace/catalog/validate.ts` — 인덱스·설명자 검증
- `src/marketplace/content/kinds.ts`, `src/marketplace/content/rules.ts` — 콘텐츠 종류
- `src/marketplace/resolve/plugin-ladder.ts`, `src/marketplace/resolve/manifest-rules.ts` — 플러그인
- `src/marketplace/resolve/mcp.ts` — MCP 서버
- `src/marketplace/repository-check.ts` — 저장소 검사
- `src/marketplace/sources/policy.ts` — 시스템 정책 파일
