interface WideningFixture {
  readonly command: string;
  readonly installation: boolean;
  readonly storable?: false;
  readonly plan: boolean;
  readonly exact: boolean;
  readonly sandbox: "allow" | "ask";
  readonly saved: "allow" | "ask";
  readonly headless: "allow" | "deny";
}
const STATIC = { installation: true, plan: true, exact: true, sandbox: "allow", saved: "allow", headless: "allow" } as const;
const EVALUATION = { installation: true, plan: true, exact: true, sandbox: "ask", saved: "allow", headless: "allow" } as const;
const UNPROVEN = { installation: true, plan: false, exact: false, sandbox: "ask", saved: "ask", headless: "deny" } as const;

// Verdicts and exact eligibility are fixed policy expectations, not analysis output.
export const CLASSIFIER_WIDENING_FIXTURES: readonly WideningFixture[] = [
  { ...STATIC, command: "git log" },
  { ...STATIC, command: "git log --oneline -n 2" },
  { ...STATIC, command: "git log 'HEAD'" },
  { ...STATIC, command: "git show --no-patch HEAD" },
  { ...STATIC, command: "git diff --cached --name-only" },
  { ...STATIC, command: "git diff HEAD main --name-status" },
  { ...STATIC, command: "git rev-parse --verify HEAD" },
  { ...STATIC, command: "git rev-parse --show-toplevel" },
  { ...STATIC, command: "git branch --list" },
  { ...EVALUATION, command: "bash --noprofile --norc -p -c 'printf ready'" },
  { ...EVALUATION, command: "bash --noprofile --norc -p -c 'cat ~/.ssh/id_rsa'" },
  { ...UNPROVEN, command: "git status" },
  { ...UNPROVEN, command: "git diff" },
  { ...UNPROVEN, command: "git diff HEAD" },
  { ...UNPROVEN, command: "git diff --cached" },
  { ...UNPROVEN, command: "git diff --cached --stat" },
  { ...UNPROVEN, command: "git show HEAD" },
  { ...UNPROVEN, command: "git log --ext-diff" },
  { ...UNPROVEN, command: "git show --no-patch --textconv HEAD" },
  { ...UNPROVEN, command: "git log --show-signature" },
  { ...UNPROVEN, command: "git log '--format=%G?'" },
  { ...UNPROVEN, command: "git branch --list --sort=signature:grade" },
  { ...UNPROVEN, command: "git -c core.fsmonitor=marker log" },
  { ...UNPROVEN, command: "git --config-env=core.fsmonitor=MARKER log" },
  { ...UNPROVEN, command: "git --exec-path=bin log" },
  { ...UNPROVEN, command: "git --git-dir=other log" },
  { ...UNPROVEN, command: "git --work-tree=other log" },
  { ...UNPROVEN, command: "git -C .. log" },
  { ...UNPROVEN, command: "git -C . log" },
  { ...UNPROVEN, command: "git --paginate log" },
  { ...UNPROVEN, command: "git alias-name" },
  { ...UNPROVEN, command: "env git log" },
  { ...UNPROVEN, command: "git log | cat", storable: false },
  { ...UNPROVEN, command: "git log; git log", storable: false },
  { ...UNPROVEN, command: "git log > output.txt", storable: false },
  { ...UNPROVEN, command: "git log --alternate-refs" },
  { ...UNPROVEN, command: "git diff --cached --name-only --recurse-submodules" },
  { ...UNPROVEN, command: "python3 -I -S ordinary.py" },
  { ...UNPROVEN, command: "env python3 -I -S ordinary.py" },
  { ...UNPROVEN, command: "./bin/python3 -I -S ordinary.py" },
  { ...UNPROVEN, command: "bash -c 'printf ready'" },
  { ...UNPROVEN, command: "bash --noprofile --norc -c 'printf ready'" },
  { ...UNPROVEN, command: "bash --noprofile --norc -p -c '$runtime' extra" },
  { ...UNPROVEN, command: "fish -N --command 'printf ready'" },
  { ...UNPROVEN, command: "node --no-addons -e 'console.log(1)'" },
  { ...UNPROVEN, command: "pwsh -NoProfile -File ordinary.ps1" },
  { ...UNPROVEN, command: "pwsh -File - -enc P" },
  { ...UNPROVEN, command: "pwsh '\u0085-enc\u0085' P" },
  { ...UNPROVEN, command: "zsh -f -c 'printf ready'" },
  { ...UNPROVEN, command: "git log", installation: false },
  { ...UNPROVEN, command: "bash --noprofile --norc -p -c 'printf ready'", installation: false },
];
