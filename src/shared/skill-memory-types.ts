export type SkillMemoryRunKind = "attended" | "headless" | "scheduled";

export interface SkillMemoryScope {
  id: string;
  skill: string;
  projectRoot: string;
}

export interface SkillMemoryLesson {
  id: string;
  digest: string;
  description: string;
  body: string;
  fingerprint: string;
  origin: {
    sessionId: string;
    messageId: string;
    completionId: string;
    runKind: SkillMemoryRunKind;
  };
}

export interface SkillMemoryChange {
  id: string;
  action: "activate" | "stage" | "apply" | "reject" | "undo";
  at: string;
  actor: "host" | "owner";
  before: SkillMemoryLesson | null;
  after: SkillMemoryLesson | null;
}

export interface SkillMemoryGroup {
  scope: SkillMemoryScope;
  active: SkillMemoryLesson[];
  staged: SkillMemoryLesson[];
  history: SkillMemoryChange[];
}

export type SkillMemoryDecision =
  | { scopeId: string; action: "apply" | "reject"; lessonId: string; digest: string }
  | { scopeId: string; action: "undo"; changeId: string; digest: string };

export interface SkillMemoryApi {
  list(): Promise<{ ok: true; groups: SkillMemoryGroup[] } | { ok: false }>;
  decide(input: SkillMemoryDecision): Promise<{ ok: boolean }>;
}
