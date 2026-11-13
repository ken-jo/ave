# MCP skill resources

The client consumes the Skills extension through the existing skill catalog,
`skill_load`, `skill_read`, approval store, and tool executor. The
[permission decision tree](permission-decision-tree.md) remains authoritative:
admission and deny checks precede modes and remembered grants; internal skill
cards retain live controller checks; ordinary tool permissions still apply.
This feature changes no decision-tree edge or mode behavior.

## Protocol pin and research

Implementation baseline: `modelcontextprotocol/ext-skills` commit
`649f7aee87d631ac4d1fdd3b12eef0c6264fdb3a`,
[`specification/beta/skills.mdx`](https://github.com/modelcontextprotocol/ext-skills/blob/649f7aee87d631ac4d1fdd3b12eef0c6264fdb3a/specification/beta/skills.mdx).
The [pinned README](https://github.com/modelcontextprotocol/ext-skills/blob/649f7aee87d631ac4d1fdd3b12eef0c6264fdb3a/README.md)
identifies this as a released, immutable specification revision at the Beta
extension lifecycle stage. The repository had no tags when inspected on
2026-11-13, so the commit, rather than a floating branch, is the pin.
[SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md)
is Final; [its acceptance](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640)
merged on 2026-09-13 at `1eb5bbe8ac933bdb595fedc687b8ed545e440491`.
The released extension specification is the wire authority: unlike the older
SEP text, it requires `ttlMs` and `cacheScope` on `skills/get` results too.

Understood scope: consume server skills as untrusted resources through existing
loading and permission paths, with byte verification and explicit consent before
instructions capable of directing host code execution enter model context.

## Discovery and reads

The client calls `skills/list` only after observing both the
`io.modelcontextprotocol/skills` extension and core Resources capability and
passing the server's Resources governance approval. Every request uses the
ordinary per-request metadata, governance and timeout path.
Discovery pages metadata only; it retrieves no files. A URI absent from the
listing can be resolved by `skills/get` through `skill_load`.
Call `skill_load({serverId, uri})` for a directly supplied URI, or pass its exact
catalog selector as `skillName`.

Selectors encode the pair `(host-assigned server ID, SKILL.md URI)` as
`mcp:<encoded-server>:<encoded-uri>`. Names cannot shadow local or other-server
skills. The virtual base includes both identities; it is never a disk path.
The catalog and loaded fence identify the origin. File content is read on demand
through `resources/read`; every read verifies exact URI, raw-byte size and
SHA-256, then rejects invalid UTF-8 for text delivery. Entry frontmatter must
equal the verified SKILL.md YAML object field for field.

The held manifest includes every file, including nested SKILL.md files. Nested
files read as supporting text do not activate a skill or its frontmatter.
The implementation accepts the specified 512 files and 16 MiB per-skill budget.
Catalog walks are bounded to 20 pages and 256 entries; failures are logged and
the catalog is withheld. Direct URI lookup remains available. There is no disk
cache, archive extraction or proactive file download. Optional directory RPCs
are unused: the manifest supplies supporting-file navigation.

Direct lookup uses the same validation and consent flow even when the catalog
was withheld for overflow. A held entry is refreshed by an explicit
`skills/get` lookup after a failed read or missing entry; there is no polling.
Unchanged held bytes remain verified against that entry until a refresh or read
observes a change. YAML equality compares parsed values without trimming,
dropping unknown keys, or normalizing omitted fields into defaults.

## Consent and enforcement

MCP skills start disabled. The existing `skill_load` card explicitly asks to
opt in to instructions that may request host code execution. Only an affirmative,
explicit user answer activates the skill; rejection, missing UI or unattended
activation fails closed. Consent uses a separate approval-key namespace and
binds to the complete sorted set of file URIs, digests and sizes, plus the
verified body. `dynamic` entries are refused because they cannot be verified.

Remote `allowed-tools`, hooks, scripts and other permission-widening frontmatter
are never installed or granted. Consent permits loading instructions; subsequent
tool calls still pass the normal executor and permission tree. An observed
manifest change, failed resource verification or disconnection invalidates the
held skill's authority. Admission and the final handler boundary reject further
calls until reloading succeeds under current consent. `skill_load` remains
available for recovery. Supporting reads remain pinned to the originating
server and held manifest. Generic model resource reads of declared skill files
are refused even before activation, directing callers to `skill_load` and
`skill_read` for consent and verification. The resource tool's server ID and URI
are normalized once after argument hooks, before admission and permission checks.
The handler dispatches those exact checked values without further normalization.
That boundary lowercases only the URI scheme, as required by
[RFC 3986 §3.1](https://www.rfc-editor.org/rfc/rfc3986#section-3.1), preserving path
case and Unicode. Skill entries and manifests must already have canonical
lowercase schemes and authorities; wire identities are rejected rather than
repaired. The same validator rejects noncanonical `skill:` resource declarations.
Percent escapes, dot or empty segments, credentials, ports, queries and fragments
are refused for skill identities. Ambiguous generic reads using a declared
skill's scheme are also refused, including skills served under another scheme.
This deliberately includes unrelated noncanonical reads on that scheme: a
`schema://reports/SKILL.md` entry also refuses `schema://public?version=1`.
Callers must supply a canonical identity rather than rely on server aliasing.
Verification compares the exact canonical manifest, requested and returned URIs
before digest and size checks. A scheme alone never activates a skill.
Cross-server reads while acting on a skill are refused; use a separate
conversation for that origin.

Digests establish consistency with the server's entry, not authenticity or trust.
They do not replace user consent, input fencing, sender validation or tool gates.

The acting window starts when `skill_load` registers approved instructions and
lasts until conversation teardown, even if compaction removes the text sooner.
The shared conversation registry supplies the held origins to every tool call;
revocation blocks all subsequent calls except `skill_load` and `skill_list`.
After transcript restoration, visible MCP skill results without a corresponding
verified registry entry also block calls until reloaded. The final handler check
rechecks the same registry after permission waits. Reconnection requires a new
verified load; unchanged manifests can reuse persisted consent. The approval
material is the manifest fingerprint followed by the SHA-256 of the parsed,
trimmed body; the manifest also binds the complete raw SKILL.md bytes.

## Validation surfaces

`src/mcp/__tests__/mcp-skills.test.ts` exercises discovery, wire envelopes,
governance, lazy reads, pagination, integrity and hostile manifests.
`src/tools/__tests__/mcp-skill-loading.test.ts` exercises disabled and enabled
consent, existing loading/reading paths, content rotation, malicious instructions,
ordinary permission denial and revocation at the handler boundary.
