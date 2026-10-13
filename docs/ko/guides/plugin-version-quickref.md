# 플러그인 버전 관리 한 장 가이드

## 한 줄 요약

공식 플러그인은 공식 마켓플레이스 모노레포 [`ken-jo/agent-marketplace`](https://github.com/ken-jo/agent-marketplace) 의 `plugins/<name>/source/` 에서 개발합니다. `plugin.json` 과 `package.json` 의 `version` 을 함께 올려 `main` 에 머지하면 release workflow 가 zip 을 만들고, 그 sha256 을 고정하는 PR 을 엽니다. **그 고정 PR 을 머지하는 것이 게시**입니다.

예전 플러그인별 저장소의 tag push 게시와 `former_org/.github` 의 중앙 workflow 는 쓰지 않습니다. 공식 마켓플레이스 밖의 저장소는 그 마켓플레이스 저장소의 규칙을 따릅니다.

## release 하는 법

1. `plugins/<name>/source/` 를 바꾸고 `plugin.json` 과 `package.json` 의 `version` 을 같은 값으로 올리는 PR 을 머지합니다. 앱 0.14.0 이상용 플러그인은 `requires.hostProtocol: "3"` 과 `requires.minAppVersion: "0.14.0"` 을 선언합니다. (앱 0.12–0.13 은 프로토콜 `"2"`(`ave/*` 와이어)를 썼고, Ave 는 프로토콜 3만 받습니다.)
2. 머지 후 release workflow 가:
   - 계약·검사기가 앱 태그에 고정되어 있고 프로토콜 3 스키마가 해시와 함께 벤더링되어 있는지 확인한 뒤 (아니면 게시 거부),
   - 머지 커밋에서 `<name>-<version>.zip` 을 빌드하고,
   - `<name>-v<version>` 태그를 만들어 그 release 에 zip 을 올리고,
   - 설명자 (`plugins/<name>/ave-package.json`) 에 zip 의 sha256 을 고정하는 PR 을 엽니다.
3. 그 고정 PR 을 머지하면 해당 버전이 게시됩니다. 저장소는 merge commit 만 허용합니다. 인덱스가 각 버전을 고정한 커밋을 기록하고, `index:check` 는 `main` 히스토리에 없는 커밋을 가리키는 항목을 거부합니다.

태그는 직접 push 하지 않습니다. workflow 가 만듭니다.

## 어떤 숫자로 올리지?

`MAJOR.MINOR.PATCH` (예: `0.2.0`).

| 변경 | 올릴 자리 |
|---|---|
| 버그 수정 / 내부 정리 | **PATCH** (`0.2.0` → `0.2.1`) |
| 새 기능 추가 (호환됨) | **MINOR** (`0.2.0` → `0.3.0`) |
| 깨지는 변경 (tool 시그니처 변경 등) | **MAJOR** (`0.2.0` → `1.0.0`) |

버전은 **반드시 증가**해야 하고, 게시된 버전은 다른 커밋으로 옮겨지지 않습니다.

## 앱 버전 호환

- 플러그인은 앱의 `src/plugins/public-contract.ts`, `schemas/plugin-manifest.schema.json`, `schemas/plugin-host-protocol/3/protocol.schema.json` 세 파일을 **앱 릴리스 태그**에서 수정 없이 `contract/` 로 벤더링합니다. `contract/sources.json` 이 출처 저장소·태그·파일별 해시를 기록합니다. 모노레포는 루트 `contract/` 하나를 `@ave/plugin-contract` 로 공유하며, `bun run contract:sync -- contract --ref <앱 태그> --app <ave 체크아웃>` 으로 갱신하고 `bun run contract:check` 로 검증합니다.
- 새 계약 멤버를 쓰는 플러그인은 그 멤버를 처음 실은 앱 릴리스를 `plugin.json` 의 `requires.minAppVersion` 에 선언하고, 설명자의 `minAppVersion` 도 같은 값으로 둡니다. 호스트는 설치·로드 시 이 최솟값을 강제합니다.

## 머지 전 검사

```bash
bun run validate          # 스키마, 이름, 한도, 버전, 권한, 비밀
bun run release:verify    # 고정된 release 를 내려받아 설명자·태그 소스와 대조
bun run index:check       # 커밋된 인덱스 = 재생성한 인덱스
bun run contract:check    # 벤더링한 계약·스키마가 기록된 해시와 일치
```

## 더 알고 싶을 때

- `ken-jo/agent-marketplace` 의 `README.md` — 게시 절차, release 실패 시 수동 고정, 검사 목록
- [`marketplace-publishing.md`](./marketplace-publishing.md) — 마켓플레이스 게시 흐름 전체
- [English Extension Version Quickref](../../guides/plugin-version-quickref.md) — 현재 영문 기준 문서

## FAQ 두 개

**Q. 머지할 때마다 게시되면 부담스러운데?**
A. 게시는 `version` 을 올린 머지 뒤 열리는 고정 PR 을 머지할 때만 일어납니다. 개발 중에는 Settings → Plugin Config → 개발자 도구 → "로컬 폴더에서 설치" 로 dev 빌드를 직접 테스트할 수 있습니다 ([`local-plugin-development.md`](./local-plugin-development.md)).

**Q. release workflow 가 중간에 실패했어요.**
A. release 는 만들어졌지만 고정 브랜치가 push 되기 전에 실패했다면 태그가 이미 있어 같은 버전을 다시 빌드하지 않습니다. 저장소 README 의 절차대로 release asset 을 내려받아 `node tools/release.mjs pin <name> <zip>` 으로 직접 고정합니다. 이미 게시된 버전은 바꿀 수 없으니, 고칠 것이 있으면 버전을 올려 새로 게시합니다.
