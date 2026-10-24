export const en = {
  "codeRewind.title": "Rewind to this turn",
  "codeRewind.description": "Code restore covers local file-edit tools from this turn onward. Bash and other shell side effects are not tracked. File transfers and remote edits cannot be restored. External file changes block code restore and are listed as conflicts.",
  "codeRewind.limits": "Up to {turns} turns per conversation, {storage} MiB total and {file} MiB per file. Oldest checkpoints are pruned; unavailable checkpoints refuse code restore.",
  "codeRewind.conversation": "Restore conversation only",
  "codeRewind.code": "Restore code only",
  "codeRewind.both": "Restore conversation and code",
  "codeRewind.cancel": "Cancel",
  "codeRewind.conflict": "Code restore refused because these files changed outside the tracked edits: {files}",
  "codeRewind.unavailable": "Code restore is unavailable for this turn. Its checkpoint is missing, pruned, or includes unsupported edits.",
  "codeRewind.failed": "Code restore failed. The conversation was kept. Check files before retrying; an I/O failure may have restored only some files.",
  "codeRewind.invalidMode": "Choose a valid rewind action.",
} as const;

export const ko: Record<keyof typeof en, string> = {
  "codeRewind.title": "이 턴으로 되돌아가기",
  "codeRewind.description": "코드 복원은 이 턴 이후 로컬 파일 편집 도구의 변경을 되돌립니다. Bash 등 셸 명령의 부수 효과는 추적하지 않습니다. 파일 전송과 원격 편집은 복원할 수 없습니다. 외부 변경이 있으면 코드 복원을 거부하고 충돌 파일을 표시합니다.",
  "codeRewind.limits": "대화별 최대 {turns}턴, 전체 {storage} MiB, 파일별 {file} MiB를 보관합니다. 오래된 체크포인트부터 삭제하며, 사용할 수 없는 체크포인트의 코드 복원은 거부합니다.",
  "codeRewind.conversation": "대화만 복원",
  "codeRewind.code": "코드만 복원",
  "codeRewind.both": "대화와 코드 복원",
  "codeRewind.cancel": "취소",
  "codeRewind.conflict": "추적한 편집 외의 변경이 있어 코드 복원을 거부했습니다: {files}",
  "codeRewind.unavailable": "이 턴의 코드 복원을 사용할 수 없습니다. 체크포인트가 없거나 삭제되었거나, 지원하지 않는 편집이 포함되어 있습니다.",
  "codeRewind.failed": "코드 복원에 실패해 대화를 유지했습니다. 다시 시도하기 전에 파일을 확인하세요. 입출력 오류로 일부 파일만 복원되었을 수 있습니다.",
  "codeRewind.invalidMode": "올바른 복원 작업을 선택하세요.",
};
