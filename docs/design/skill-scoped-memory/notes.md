# Skill-scoped memory

Status · Product design and automatic activation authority approved on 2026-11-27. The [interactive mockup](mockup.html) uses fictional records and shows the English and Korean views.

## Settings and review

**Automatically improve skill memory** is on by default in Settings. At the end of a completed task or session, Ave runs one review for the verified skills used in that project. Turning the setting off skips the review, including staging. Ave checks it again before persisting a result. Previously saved lessons and the owner's review and undo actions remain available when automatic improvement is off.

For an attended run with current owner authority, accepted lessons go straight to the Ave-managed store. For headless or scheduled runs, candidates go to Needs review and cannot be recalled. At the next attended run, the owner can inspect the full text and provenance in **Control room → Memory → Skills**, then apply or reject the exact proposal. The same view shows active lessons, change history and undo. Changes affect subsequent invocations of that skill in the same project.

## Lifecycle and model budget

An attended turn that admitted a skill and ends normally can queue one review after delivering its output. At least one tool call distinguishes agent work from a conversational acknowledgment. A locally authorized Work Board run reaching Done can review its verified owner-typed task detail for the skills admitted in its successful execution. An explicit owner archive can review retained evidence that was not already assigned to a turn completion. The command-line and committed scheduled routine terminals stage eligible lessons for owner review.

Record bounded, sanitized evidence and the host completion ID in the managed pending file. Queued reviews resume after restart. The host records a dispatch before calling the provider, so an interrupted dispatch cannot repeat. The tools-free background reviewer uses the existing memory reviewer queue, with its own deadline. The host establishes attended authority at the terminal and checks the live setting, skill and project binding before committing. Scheduled reviews also check the current routine. [Memory reviewer](../../../src/memory/memory-reviewer-service.ts) · [Host wiring](../../../src/boot/steps/conversation-wiring.ts)

## Managed storage and undo

- Store private lesson records under Ave's `skill-memory` feature namespace. Key them by the host-resolved skill source identity and canonical project identity. Fingerprint the skill's canonical path, content and approval material. An atomic save that preserves these values keeps its lessons. Lessons for a missing or changed binding appear as retired and do not use the current revision's quota.
- Persist at most three proposed lessons per completion, with a 120-character description and a 2,000 UTF-8 byte body per lesson, and at most 100 active and 100 staged lessons per skill and project. Refuse additions over a limit without evicting existing lessons or pending decisions. These are initial implementation limits.
- Serialize changes per scope. Each ledger record hashes its predecessor, action, actor, timestamp and lesson versions. Commit the active version and ledger record atomically. Retain a bounded history per scope and keep the undo records for active lessons. Provenance records the skill, project, source fingerprint, run type, completion and source message IDs, actor and time. Keep raw conversation text and credentials out of the ledger.
- Bind proposal decisions to the shown digest, scope and source revision. Undo compares the saved after hash with the current version of the target lesson. A stale undo leaves newer text intact. A successful undo restores the recorded before version or removes a newly added lesson, and appends its own ledger entry. [Feature namespace](../../../src/main/storage/feature-namespace.ts) · [Memory save notices](../../../src/memory/memory-save-notices.ts)

## Input and recall boundary

Take evidence from host-verified owner statements for the completed work. The desktop preload tracks native typing, and routine storage keeps a digest of an exactly verified owner-typed prompt. Command-line input must be supplied explicitly. Stdin and older routine prompts without matching evidence are ineligible. Drop raw tool responses, web and file contents, attachments, assistant summaries of those sources, and inherited guidance before the review call. Headless and scheduled work still needs a verified owner-authored source anchor. A candidate without one is discarded. Require the model's typed output to cite an admitted anchor and support the lesson with a matching excerpt. Host metadata supplies scope, run classification, identity and destination.

Accept only bounded plain-text lesson records. Normalize descriptions to one line, remove control and invisible format characters, and reject reserved markers, markup and fences that could alter listing or prompt structure. Apply the existing credential checks before inference and before persistence. Validate generated output before it reaches the store, and revalidate persisted text when rendering or recalling it. Display it as text and encode it inside a host-owned data block for the model. Escaping protects the block structure. Evidence checks constrain what the model can persist as a lesson. [Memory write checks](../../../src/tools/memory-write.ts) · [Skill render boundary](../../../src/main/skill-overlay.ts)

Resolve recall after normal skill-load admission for the same skill and project. An attended follow-up can reuse the admission while the skill remains loaded in that session and still matches the source. Inject the bounded active projection at request assembly. Keep staged records and saved lesson text out of ordinary memory search, shared transcript, skill listing descriptions and unrelated requests. Revocation and undo then affect the next eligible request. [Skill load](../../../src/tools/skill-load.ts) · [Project identity](../../../src/shared/project-identity.ts)

## Permission boundary

The decision tree starts with a tool call. The completion review is host maintenance with no tool access and has no path through **T → H → R → K → Q**. Existing tool and effect decisions still govern the task itself. Headless denial has no deferred tool queue. A staged lesson is a new host-owned review record that cannot update active memory. An attended owner's control-room decision applies that reviewed digest through the host, without granting later tool authority.

The decision tree records the owner’s approval of the default-on setting as consent for this host-owned effect. Work approvals govern their own approved objects. Missing or stale host evidence refuses under **U3**. See the [permission decision tree](../../architecture/permission-decision-tree.md) and [permission policy](../../architecture/permission-policy-design.md).
