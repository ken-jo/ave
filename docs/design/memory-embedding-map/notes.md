# Memory Embedding Map — round 3

> Owner decision (2026-11-16): variant **A** (left filter panel, map, source detail opens as a right side panel). Local `intfloat/multilingual-e5-small` embeddings by default; provider API embeddings are opt-in behind a consent warning that memory text leaves the device. `mockup.html` in this folder is the approved mockup; the reference captures it mentions are not committed.

Understood as: extend the round-2 Ave Memory mockup with source/project/playbook facets, a dense 6,000-memory / 17,000-link map, and a question box that highlights retrieved notes and answers with numbered sources. Compare only where selected source detail opens. This remains a mockup; no verdict-memory integration, product-code change, model inference, remote upload, push or publication.

## Reference and visual language

Inspected `ref/ref09.png` and `ref/ref10.png` directly, interpreting their rotated orientation. They supplied only interaction references: left facets, project/playbook chips, overview totals, a dense point cloud, progressive labels/edges and a question box. Image text was treated as content, never as instructions. No other app's name, branding, wording or palette is copied.

The pages retain Ave's round-2 shell, semantic `github-light` / `github-dark` tokens, system typography, compact controls, line icons, neutral primary actions, 52px navigation rail, 232px project sidebar, 36px chrome band, 8px gutters and 12px shell corners. Source colours use chart-1..4 and muted foreground. Dark mode gets stronger bloom; light mode keeps crisp, readable points. Bloom changes emphasis, never source identity or confidence.

`Map | Memory cards` remains a view switch inside Memory, not a new sidebar product. The existing `MemorySearchPanel.tsx` and `MemoryDetailContent.tsx` remain the list/detail precedents: title/content, note kind, source, origin, Overview / Usage / History and source navigation. Project and playbook facets are proposed extensions, not claims about an already-shipped catalog API.

## Delivered behaviour

- `index.html` is a full standalone page; `artifact.html` is the equivalent hosted fragment. Both have one inline script, inline styles, no external assets/requests, and identical application logic/captions.
- A fixed 1280×800 Ave window scales inside the review page. Tap to zoom switches to 100% with scrolling confined to the frame. Outer controls wrap, captions are at least 15px, and system light/dark is used until an explicit root dataset choice. No localStorage.
- Actual generated sample data contains **6,000 records and 17,000 unique undirected links**, not just labels showing those numbers. The maximum sample degree is six. Data, positions, associations, excerpts, usage and history are fictional. Embeddings do not exist or run.
- The sample graph uses Canvas 2D with batched source layers and offscreen bloom, not a bundled WebGL dependency. It demonstrates the requested density and interactions; the production renderer recommendation is below. It is not a production GPU benchmark.
- Source toggles OR within their section; selected projects OR within theirs; selected skills/playbooks OR within theirs. Sections intersect. With no project or playbook selected, that section allows all. Nonmatching points dim for orientation and cannot be picked. The header counts matching memories and induced links, where both endpoints match. Facet-chip counts describe the full collection; playbook memberships overlap.
- Project labels appear on hover/selection and at closer zoom. Far-view edges use a sparse visual level of detail; closer zoom shows the full eligible edge buffer, with culling. Hover/selection emphasises incident links. Stored graph totals describe the graph, not the number of segments currently drawn.
- Drag rotates the 2D projection plane; vertical drag tilts its view. Scroll / + / − zoom; fit restores the camera. This is a camera treatment, not a third semantic embedding axis. Arrow keys rotate a focused map; + / − / 0 zoom/reset. Memory cards provide a keyboard-accessible alternative.
- Left-panel Filters / Cards is shared by both variants. The top Memory cards view offers a larger paginated grid. Cards and point picks open the same memory source; Open source expands only a fictional source excerpt, never a real session or external page.
- Ask your memory retrieves up to three distinct content matches from the current filters, preferring project diversity. It highlights those ids and presents an extractive answer with numbered source buttons. The offline demo uses token scoring on fictional text, not semantic embeddings or an LLM. Unsupported questions show a no-match message. Changing facets or card-search text clears a previous answer and resets pagination. A retained text filter stays visible as a clearable chip when switching back to Map. Citation clicks open the corresponding source.

## A — Source panel at right (recommended)

The left filter/card panel remains visible; selected source detail opens over the map's right side. Selecting another point/card or numbered citation updates that same detail. Closing it restores the unobstructed map. The question box and controls remain available.

**Why recommended:** filters, source content and map context remain in view, making it easier to verify why a memory was retrieved. **Trade-off:** the source panel covers some points. Answer sources are raised above the panel's top edge when the answer expands, and map controls stay outside the panel.

**Data/backend contract:** the shared graph/facet/retrieval contract below, plus existing memory content/detail reads and host-resolved origin/source links. Panel visibility, selection and focus are renderer state. No variant-specific endpoint or separate source record is required.

**Reuse:** Ave `Sidebar`, `Rail`, shell/pane bands, Button/Input/Tabs/ScrollArea, `MemorySearchPanel` note-row/filter concepts and `MemoryDetailContent` provenance/usage/history body. `NoteRow` is module-private and would need deliberate extraction. The graph canvas, facet chips, retrieval result strip and side-panel placement are new presentation wrappers.

**Dependencies:** delivered mock: none, 0 package bytes. Proposed production pairing for this variant: `@cosmos.gl/graph@3.6.0` (MIT, 5,893,043 bytes unpacked), a qualified UMAP projection worker (`umap-js@1.4.0`: Apache-2.0 distributed licence with conflicting MIT npm metadata, 510,034 bytes unpacked), owner-selected local E5 weights (MIT, about 471 MB FP32) and a separately qualified runtime such as `onnxruntime-node@1.31.1` (MIT, 307,626,018 bytes unpacked distributed package). No extra generative model is required for an extractive answer. Nothing is installed here.

**Risks:** overlays obscure part of the graph, very dense maps hide outliers, bloom can hide colour differences, and source/tooltips must not compete for focus. Preserve keyboard browsing and full Memory cards access. Visual neighbourhoods and link strength must not be presented as truth or authority.

## B — Source replaces the left panel

The left panel switches between Filters, Cards and the selected source detail. Selecting a point/citation replaces the left controls with the same detail content. Back restores the previous Filters/Cards state and scroll. The right map stays entirely visible.

**Benefit / trade-off:** the whole landscape remains visible, while changing facets requires a Back action. This is the only layout difference from A: the coordinate snapshot, colours, camera, question behaviour, counts and source body are identical.

**Data/backend contract and reuse:** identical to A. Preserve `{leftMode, leftScroll, selectedMemoryId, focusTarget}` locally. Moving the detail must not remount the graph's data service, refit coordinates, rerun retrieval or re-embed notes.

**Dependencies:** identical to A, with no package added for this placement. The same licences and sizes apply.

**Risks:** hidden filters make it easier to forget the active scope. Keep active counts and the selected source's “Outside current filters” state visible; Back must restore focus and prior facet choices. Very narrow left details require an independent scroller.

## Shared host contract

Everything below is proposed. The renderer never reads memory files or calls a provider directly. Existing scope authorization, source navigation and memory-detail states remain authoritative.

```ts
type GraphSnapshot = {
  snapshotId: string;
  catalogRevision: string;
  authorizationScopeId: string;
  model: { id: string; revision: string; dimensions: 384; preprocessingRevision: string };
  projection: { algorithm: 'umap'; dimensions: 2; version: string; seed: number; parameters: object };
  status: 'unconfigured' | 'building' | 'ready' | 'stale' | 'failed';
  coverage: { eligible: number; embedded: number; pending: number; excluded: number };
  points: { memoryId: string; contentRevision: string; x: number; y: number }[];
  edges: { a: string; b: string; similarity: number; kind: 'semantic-neighbour' }[];
};
type MemoryFacets = {
  sources: { sourceKind: 'user' | 'assistant' | 'import' | 'capture' | 'unknown'; count: number }[];
  projects: { projectId: string; name: string; count: number }[];
  playbooks: { playbookId: string; name: string; count: number }[];
};
type RetrievalAnswer = {
  snapshotId: string;
  catalogRevision: string;
  queryId: string;
  matches: { memoryId: string; contentRevision: string; excerpt: string; score: number }[];
  answerParts: { text: string; sourceMemoryIds: string[] }[];
};
```

Proposed operations are `getMemoryGraph(scope, revision)`, `getMemoryFacets(scope)`, paginated memory summaries/cards, existing content/detail/source reads, and `retrieveMemory(question, filters, snapshotId)`. These are conceptual names, not registered IPC channels. A future change must carry shared types, preload bridge, sender/frame guards, handlers, cancellation and translated errors together.

**Facets and source identity.** Reuse canonical memory kind/source metadata. Unknown is a UI fallback for absent legacy provenance, not a new persisted source enum. Projects use host-issued normalized project identities, never arbitrary renderer paths. Cross-project Memory requires an authorised aggregate catalog beyond the current project-scoped view; current sidebar choice is not permission to read every project. Global-memory applicability remains separate from project membership. Skills/playbooks need explicit memory-to-playbook associations with origin and revision, such as a recorded execution or user assignment. Do not invent those associations from point proximity or silently relabel memory source kinds. Overlapping skill counts are expected.

**Versioning.** Coordinates, edge index maps, facet memberships and retrieval sources must name the same catalog/model scope. Resolve managed ids rather than using array indexes as durable identity. Exclude deleted/discarded notes, instruction indexes and isolated sub-agent stores unless separately authorised. Legacy id migration is a distinct decision. Lazily fetch bounded excerpts and existing detail; preserve absent/unavailable/resolved origin and incomplete/rotated history or usage states.

**Storage and lifecycle.** Embed/reproject/build the graph in a background host worker, never React or the main event loop. Cache by memory id, content hash, pinned model and preprocessing revision. Publish snapshots atomically. Edits invalidate affected vectors, adjacency and citation excerpts; deletes must remove derived vectors/edges/labels, prevent stale job writes and invalidate open sources. Use the feature-namespace storage seam and existing audit rules; progress events contain ids/counts, not memory text. Cancel/retry and partial coverage remain explicit.

## How production links are computed

1. Embed authorised active memory title/content chunks with local E5, using declared chunking, pooling, prefix and normalization policies. Keep one normalized representation per managed memory. Do not mix model/preprocessing revisions.
2. Find candidate **k-nearest neighbours in the original 384-dimensional vector space**, using cosine similarity; for example retain 12 candidates per memory before final capping. Reuse compatible neighbour work from projection or run a background exact/approximate neighbour stage. Candidate retrieval quality and build latency need measurement before selecting an ANN dependency; none is added by this mock.
3. Canonicalize each pair as `(min(idA,idB), max(idA,idB))`, drop self-loops and duplicates, prefer reciprocal neighbours and sort by similarity. Use a model/corpus-calibrated cutoff rather than treating an arbitrary score as a probability.
4. Admit a pair only while **both endpoints have degree < 6**, with a total undirected edge budget around **17,000**. Six neighbours across 6,000 points permit at most 18,000 undirected edges; 17,000 corresponds to average degree 5.67. Sparse collections can legitimately have fewer edges. Do not manufacture edges to reach a UI target.
5. Store these edges separately from the UMAP coordinates. Filtering selects an induced subgraph; it never refits UMAP. Never compute semantic neighbours from 2D screen distance, colour, project membership or force-layout attraction. Incremental rebuilds remove affected old edges before adding replacements; a full snapshot swap prevents dangling indices.

The mock's 17,000 edges are deliberately **spatial proxies**: three successor connections on a spatially ordered ring within each fictional project create a degree-six candidate graph, then the longest proxy links are removed to leave 17,000. This supports a truthful sample density/count/degree check without claiming that embeddings were computed. It is not the production embedding kNN algorithm or evidence of semantic quality.

## Renderer choice at 6,000 / 17,000

**Prefer `@cosmos.gl/graph` for the production revision.** This UI now has an explicit, persistent node-and-link graph, not only isolated scatter points. Its graph-oriented point/link buffers and picking/highlighting are a closer fit for semantic edges and neighbourhood emphasis. Feed externally computed coordinates and **disable force simulation**; a visual force solver must not change semantic projection geometry. Verify static-position, camera and rescaling APIs against the pinned release. Camera rotation can be implemented as a view transform of the 2D plane. [Upstream renderer](https://github.com/cosmosgl/graph), [configuration](https://github.com/cosmosgl/graph/blob/main/src/config.ts).

`regl-scatterplot` remains a strong, smaller point-cloud alternative with pan/zoom/rotation/picking and selection. Its documented connections group points into ordered spline paths. I infer additional connection/index management or a separate line pass for an arbitrary branching neighbour graph; that extra integration is the reason for preferring a graph-oriented renderer here. If edges prove optional or rare, reconsider it; do not choose by package size alone. [Upstream interactions and connections](https://github.com/flekschas/regl-scatterplot).

| Candidate | Licence | Pinned package size / implication |
| --- | --- | --- |
| [`@cosmos.gl/graph@3.6.0`](https://registry.npmjs.org/@cosmos.gl%2fgraph/3.6.0) | MIT | **5,893,043 bytes unpacked**. Recommended node/link renderer; force simulation disabled. |
| [`regl-scatterplot@1.16.0`](https://registry.npmjs.org/regl-scatterplot/1.16.0) | MIT | **1,081,265 bytes unpacked**. Leaner scatter-first alternative; explicit edge integration required. |
| [`umap-js@1.4.0`](https://registry.npmjs.org/umap-js/1.4.0) | Distributed LICENSE/source: Apache-2.0; npm says MIT | **510,034 bytes unpacked**. Resolve the licence discrepancy before adoption; the inspected [tarball](https://registry.npmjs.org/umap-js/-/umap-js-1.4.0.tgz) contains Apache text. Worker projection, not rendering or answer generation. |
| [`umap-learn`](https://github.com/lmcinnes/umap) | BSD-3-Clause | Full Python/NumPy/Numba runtime size not measured. Reference alternative, not a required dependency. |
| [`onnxruntime-node@1.31.1`](https://registry.npmjs.org/onnxruntime-node/1.31.1) | MIT | **307,626,018 bytes unpacked distributed package**. Candidate inference runtime; target-platform packaging and tokenizer/export integration are unqualified. |
| Native Canvas 2D, delivered here | No package | **0 dependency bytes**. Batched points, offscreen blur, culling and edge LOD for the review. No WebGL package is loaded. |

Pinned npm `dist.unpackedSize` values were inspected in round 1 on 2026-11-14; upstream renderer roles were checked again on 2026-11-15. These sizes exclude transitive dependencies and are not minified/gzip sizes, per-platform installer deltas, RAM or speed measurements. Preserve the inline icon ISC notice; model, tokenizer and runtime notices need separate packaging review.

**Scale envelope, not a performance promise:** 6,000 × 384 Float32 vectors use 9,216,000 bytes before indexes/metadata; XY Float32 positions use 48,000 bytes; 17,000 endpoint pairs as Uint32 use 136,000 bytes, plus 68,000 bytes for Float32 edge weights. Keep text/DOM cards paginated and lazy. A WebGL implementation should use stable buffers, spatial picking, cancellable background projection/neighbour building, label LOD and redraw scheduling. Test context loss, accessibility, reduced motion and integrated Electron GPU behaviour. No production frame-rate, native focus or cross-device performance result is claimed.

## Ask your memory contract

Use the same local model/preprocessing namespace for the query, apply host authorisation and facets **before** choosing results, then return bounded memory ids, content revisions and excerpts. For the first implementation, an extractive answer can assemble matching memory passages locally; E5 is an embedding model, not a generative answer model. This avoids introducing an unrequested cloud answer dependency.

Assign citation numbers in the host from returned result ids. Every answer part names only retrieved, authorised ids; clicking a source resolves the current memory/origin through existing navigation seams. Missing, changed or deleted sources should be marked and revalidated, not silently substituted. Stale requests must not overwrite newer questions, filters or snapshots. If there is insufficient support, show no answer rather than fabricate evidence. A later generative synthesis option needs its own model choice, consent and cited-answer checks; embedding-provider consent must not be treated as consent to upload question context to another service.

The demo's token scoring, content deduplication and project diversity are only interaction scaffolding. Its seeded cloud, handwritten memories and extractive answer are not an independent semantic-search evaluation.

## Embedding-source decision retained

**Default: local `intfloat/multilingual-e5-small`.** Not set up and Settings both name it and explain local processing. The [model card](https://huggingface.co/intfloat/multilingual-e5-small) documents MIT licensing and 384-dimensional multilingual embeddings; the [file listing](https://huggingface.co/intfloat/multilingual-e5-small/tree/main) shows about **471 MB** of FP32 weights, excluding tokenizer/runtime. The [configuration](https://huggingface.co/intfloat/multilingual-e5-small/blob/main/config.json) has a 512-position limit. Follow the documented symmetric/clustering `query: ` prefix consistently and pin the export/revision. Local inference keeps memory text on-device; model downloads still contact a model host and must be explicit. Quantization size, runtime RAM and Korean/English retrieval quality are unmeasured here.

**Optional provider embedding API: explicit Settings opt-in.** The visible warning is **Memory text leaves the device**. Provider choice requires its radio option and a separate acknowledgement before the preview action is enabled. Local is initially selected. The mock collects no credentials, saves no settings, downloads no model and sends no text. A real host must default to local, validate a versioned consent record and authorised scope, separate embedding-provider configuration from chat credentials/subscriptions, keep secrets in the host store, apply DLP rules, disclose retention/region/cost, and stop new sends on opt-out. Provider/model changes create a new vector namespace and rebuild; local deletion cannot guarantee removal of provider logs.

## Local inference confinement

Local inference runs only in a separate child process that the OS sandbox keeps off the network, on every platform (`src/main/memory-map/inference-child.ts`). The host starts it through the shared confined-child launch path with an offline worker owner: srt-win on Windows, the platform sandbox on macOS and Linux. The egress decision refuses every connection from an offline owner before any allowlist is read ("outbound network is disabled for this service"), and on Windows the fence admits only the local proxy. On macOS and Linux, the invocation denies Unix sockets even while other workers hold socket allowances. The child gets no write root. Downloads and verified copies of adopted models live under the protected models directory, which the child cannot read. A previously saved external path requires selecting that folder again to adopt a protected copy. The host streams each input over the child's channel and withholds the file's final chunk until a size recheck and a hash of the streamed bytes match the manifest. `ORT_DISABLE_TELEMETRY=1` is in the child's environment from creation as defence in depth; the network block is the boundary.

Without an active sandbox (turned off, still starting, or a Windows extension plan that would refuse the confined start) local embeddings are unavailable with that reason; the host never falls back to in-process inference. The projection worker thread shares the host process and only projects cached vectors.

On Windows the child starts in the system directory, which the sandbox account can already read. It receives the usual fresh process HOME environment without an ACL grant to that profile.

**Windows residual:** the native runtime can emit ETW TraceLogging events. They go to the operating system's local event-tracing sessions, not through a socket the process opens, so the network block neither applies to them nor needs to. Whether the OS sends diagnostic data anywhere is governed by the system's diagnostic-data setting, not by Ave. Whether the runtime honours the environment opt-out for these events is not verified here.

## Validation boundary

Both variants share one data model and backend contract. Only source-detail placement changes. Native glass, real source/session navigation, actual embedding quality, true semantic kNN, persistent consent, worker cancellation and production GPU throughput are outside this deliverable. The reference repository and image files remain untouched.

Validated on 2026-11-15 in a background Chromium browser: both complete and fragment pages, both variants, widths 390px and 1280px, system light/dark, no horizontal outer-page scroll, captions at least 15px, and 100% inspection scrolling inside the frame. Verified actual 6,000/17,000 counts and degree ≤ 6; source/project/playbook intersections; induced link totals; paginated cards; three numbered extractive sources and map highlight ids; citation/source/card navigation and focus return; retained text-filter visibility and answer invalidation; point hover/picking; rotate/zoom/fit; local default and gated provider opt-in; unconfigured/indexing/failure/retry previews. Final page resource timing showed no additional requests. These are UI/data-integrity checks, not semantic-quality or production-performance evidence. The reference checkout remained unchanged.
