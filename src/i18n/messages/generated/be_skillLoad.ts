// i18n fragment. Source: src/tools/skill-load.ts.
export const en = {
  "be_skillLoad.toolDescription":
    "Reads a skill's instructions (its SKILL.md body) by name. The system prompt lists only skill names and descriptions; " +
    "call this before acting on a skill, then follow the returned instructions. " +
    "The result is an <ave-skill name base> block holding the body and any bundled files (fetch one with skill_read). " +
    "It stays in this conversation: do not read the same skill again while its earlier result is still visible; read it again if it is gone (for example after compaction). " +
    "The first read of a skill, and a read after its content changed, asks the user for approval.",
  "be_skillLoad.skillNameDescription":
    "The skill name to read (must match the file/directory name and the frontmatter name field).",
  "be_skillLoad.approvalReason":
    "Reads skill '{name}' into this conversation so the assistant follows its instructions. The approval record is stored permanently and bound to the current body and its bundled file list — if either changes, confirmation is requested again.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_skillLoad.toolDescription":
    "이름으로 skill 의 지시(SKILL.md 본문)를 읽습니다. 시스템 프롬프트에는 skill 이름과 설명만 있으므로, " +
    "skill 을 사용하기 전에 이 도구로 읽고 반환된 지시를 따르세요. " +
    "결과는 본문과 번들 파일 목록을 담은 <ave-skill name base> 블록입니다(번들 파일은 skill_read 로 하나씩 가져옵니다). " +
    "결과는 이 대화에 남습니다: 이전 결과가 아직 보이면 같은 skill 을 다시 읽지 말고, 보이지 않으면(예: 압축 후) 다시 읽으세요. " +
    "skill 을 처음 읽을 때와 내용이 바뀐 뒤 읽을 때는 사용자 승인을 요청합니다.",
  "be_skillLoad.skillNameDescription":
    "읽을 skill 이름 (파일/디렉터리명과 frontmatter name 이 일치해야 함).",
  "be_skillLoad.approvalReason":
    "skill '{name}' 을 이 대화로 읽어 어시스턴트가 그 지시를 따르게 합니다. 승인 기록은 영구 저장되며 현재 본문과 번들 파일 목록에 바인딩됩니다 — 둘 중 하나라도 변경되면 다시 확인합니다.",
};
