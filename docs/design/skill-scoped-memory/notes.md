# Skill-scoped memory

Status · Product design and automatic activation authority approved on 2026-11-27. The [interactive mockup](mockup.html) uses fictional records and shows the English and Korean views.

## Settings and review

**Automatically improve skill memory** is on by default in Settings. At the end of a completed task or session, Ave runs one review for the verified skills used in that project. Turning the setting off skips the review, including staging. Ave checks it again before persisting a result. Previously saved lessons and the owner's review and undo actions remain available when automatic improvement is off.

For an attended run with current owner authority, accepted lessons go straight to the Ave-managed store. For headless or scheduled runs, candidates go to Needs review and cannot be recalled. At the next attended run, the owner can inspect the full text and provenance in **Control room → Memory → Skills**, then apply or reject the exact proposal. The same view shows active lessons, change history and undo. Changes affect subsequent invocations of that skill in the same project.

## Lifecycle and model budget

Use the host's task or session terminal event. Deduplicate the review by the host's completion ID so that duplicate terminal events or a later session shutdown cannot repeat it. Success with no eligible skill, canceled or incomplete work, and missing or ambiguous completion evidence produce no review. A normal intermediate turn or model round cannot trigger the step. An owner archive of an idle, held desktop session is the explicit session terminal. The one-shot command-line terminal and a committed schedule fire are task terminals. The existing post-turn memory capture is a model-call precedent. Its idle drain does not prove task completion. [Post-turn hooks](../../../src/hooks/post-turn-hook-chain.ts)

Run one tools-free background review using the existing memory reviewer queue and active chat one-shot. Keep its input and output ceilings, cancellation, and provider selection and budget behavior. Recheck the live setting, skill and project binding, and run authority before committing. A failed, canceled or unavailable review leaves storage untouched. [Memory reviewer](../../../src/memory/memory-reviewer-service.ts) · [Host wiring](../../../src/boot/steps/conversation-wiring.ts)

## Managed storage and undo

- Store private lesson records under Ave's `skill-memory` feature namespace. Key them by the host-resolved skill source identity and canonical project identity. Attach the approved skill fingerprint to each capture and use it to revalidate the binding. A skill name alone has no authority. Start with local skills. Missing, replaced or changed sources suspend recall or proposal application until the binding is verified. The owner can still inspect history.
- Persist at most three proposed lessons per completion, with a 120-character description and a 2,000 UTF-8 byte body per lesson, and at most 100 active and 100 staged lessons per skill and project. Refuse additions over a limit without evicting existing lessons or pending decisions. These are initial implementation limits.
- Serialize changes per scope. Record each control-room or automatic mutation with before and after content hashes, recoverable versions and host-derived provenance. Commit the active version and its ledger record atomically. Provenance records the skill, project, source fingerprint, run type, completion and source message IDs, actor and time. Keep raw conversation text and credentials out of the ledger.
- Bind proposal decisions to the shown digest, scope and source revision. Undo compares the saved after hash with the current version of the target lesson. A stale undo leaves newer text intact. A successful undo restores the recorded before version or removes a newly added lesson, and appends its own ledger entry. [Feature namespace](../../../src/main/storage/feature-namespace.ts) · [Memory save notices](../../../src/memory/memory-save-notices.ts)

## Input and recall boundary

Take evidence from host-verified owner statements for the completed work. The desktop preload tracks native typing, and routine storage keeps a digest of an exactly verified owner-typed prompt. Command-line input must be supplied explicitly. Stdin and older routine prompts without matching evidence are ineligible. Drop raw tool responses, web and file contents, attachments, assistant summaries of those sources, and inherited guidance before the review call. Headless and scheduled work still needs a verified owner-authored source anchor. A candidate without one is discarded. Require the model's typed output to cite an admitted anchor and support the lesson with a matching excerpt. Host metadata supplies scope, run classification, identity and destination.

Accept only bounded plain-text lesson records. Normalize descriptions to one line, remove control and invisible format characters, and reject reserved markers, markup and fences that could alter listing or prompt structure. Apply the existing credential checks before inference and before persistence. Validate generated output before it reaches the store, and revalidate persisted text when rendering or recalling it. Display it as text and encode it inside a host-owned data block for the model. Escaping protects the block structure. Evidence checks constrain what the model can persist as a lesson. [Memory write checks](../../../src/tools/memory-write.ts) · [Skill render boundary](../../../src/main/skill-overlay.ts)

Resolve recall only after the normal skill-load checks, for that exact invocation and project. Inject the bounded active projection at request assembly. Keep staged records and saved lesson text out of ordinary memory search, shared transcript, skill listing descriptions and subsequent unrelated requests. Revocation and undo then affect the next eligible request. [Skill load](../../../src/tools/skill-load.ts) · [Project identity](../../../src/shared/project-identity.ts)

## Permission boundary

The decision tree starts with a tool call. The completion review is host maintenance with no tool access and has no path through **T → H → R → K → Q**. Existing tool and effect decisions still govern the task itself. Headless denial has no deferred tool queue. A staged lesson is a new host-owned review record that cannot update active memory. An attended owner's control-room decision applies that reviewed digest through the host, without granting later tool authority.

The decision tree records the owner’s approval of the default-on setting as consent for this host-owned effect. Work approvals govern their own approved objects. Missing or stale host evidence refuses under **U3**. See the [permission decision tree](../../architecture/permission-decision-tree.md) and [permission policy](../../architecture/permission-policy-design.md).
