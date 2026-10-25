/** Alert declarations grant all-or-nothing; host readers recheck schema bounds before granting behavior. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifestValidator,
  getDeclaredAlertKinds,
  getDeclaredConfigInherits,
  getDeclaredSuggestionSources,
  parsePluginJson,
} from "../manifest-validation.js";
import type { PluginManifest } from "../../types.js";
import {
  agentPluginsDocument,
  permissiveManifestValidatorFactory,
  pluginManifestWriter,
} from "../../__tests__/test-helpers.js";

type Json = Record<string, unknown>;

function replyKind(): Json {
  return {
    id: "reply",
    label: { en: "Mail needing a reply", ko: "답장 필요 메일" },
    description: { en: "A mail that seems to need your answer." },
    defaultEnabled: false,
    visibility: "user-visible",
    osNotification: {
      defaultEnabled: false,
      bypassFocusGate: false,
      body: { en: "A mail that needs your reply arrived." },
    },
    actionLabel: { en: "Draft a reply" },
    slots: {
      subject: { kind: "text", maxLength: 80 },
      senderName: { kind: "text", maxLength: 80, optional: true },
      emailId: { kind: "ref" },
    },
    summary: { en: "{senderName} wrote: {subject}", ko: "{senderName}: {subject}" },
    prompt: {
      en: "A mail that seems to need a reply arrived from {senderName}: {subject}. Read it with the mail tools and help me answer.",
    },
    inherits: [
      {
        pluginId: "retiredfixture",
        sourceId: "ave",
        enabled: { key: "disabledDetectors", listed: "disabled", values: ["reply", "replydetection"] },
        osNotification: {
          key: "osNotificationIntents",
          listed: "enabled",
          values: ["reply"],
          masterKey: "osNotificationsEnabled",
        },
      },
    ],
  };
}

function digestKind(): Json {
  return {
    id: "digest",
    label: { en: "Morning digest" },
    defaultEnabled: true,
    visibility: "summary-only",
    slots: { topics: { kind: "list", maxItems: 5, maxLength: 120 } },
    summary: { en: "Today: {topics}" },
    prompt: { en: "Summarise these topics for me:\n{topics}" },
  };
}

function alertsBlock(overrides: Json = {}): Json {
  return {
    reasoning: "Tells you when a mail needs an answer.",
    kinds: [replyKind(), digestKind()],
    suggestions: ["overlay:fixturemail-routine"],
    ...overrides,
  };
}

function withAlerts(block: unknown): Pick<PluginManifest, "alerts"> {
  return { alerts: block as PluginManifest["alerts"] };
}

function withReplyKind(edit: (kind: Json) => void): Pick<PluginManifest, "alerts"> {
  const kind = replyKind();
  edit(kind);
  return withAlerts(alertsBlock({ kinds: [kind, digestKind()] }));
}

function expectRefused(manifest: Pick<PluginManifest, "alerts">, reason?: RegExp): void {
  expect(getDeclaredAlertKinds(manifest, "fixturemail")).toEqual([]);
  // A malformed alerts block still scopes triggers and grants no source.
  expect(getDeclaredSuggestionSources(manifest, "fixturemail")).toEqual([]);
  if (reason) {
    const refusals = vi.mocked(console.warn).mock.calls
      .map((call) => call.join(" "))
      .filter((line) => line.includes("alerts declaration rejected"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(reason);
  }
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getDeclaredAlertKinds", () => {
  it("grants every kind of a valid block and its suggestion sources", () => {
    const manifest = withAlerts(alertsBlock());
    expect(getDeclaredAlertKinds(manifest).map((k) => k.id)).toEqual(["reply", "digest"]);
    expect(getDeclaredSuggestionSources(manifest)).toEqual(["overlay:fixturemail-routine"]);
  });

  it("grants nothing and scopes nothing when the manifest has no block", () => {
    expect(getDeclaredAlertKinds({})).toEqual([]);
    expect(getDeclaredSuggestionSources({})).toBeNull();
  });

  it("returns a copy, so editing the manifest after load changes no grant", () => {
    const block = alertsBlock();
    const manifest = withAlerts(block);
    const kinds = getDeclaredAlertKinds(manifest);
    ((block.kinds as Json[])[0]!.label as Json).en = "Edited";
    expect(kinds[0]!.label.en).toBe("Mail needing a reply");
  });

  it("refuses the whole block when one kind is malformed", () => {
    const broken = digestKind();
    broken.visibility = "loud";
    expectRefused(withAlerts(alertsBlock({ kinds: [replyKind(), broken] })));
  });

  it("warns once per block, not on every read", () => {
    const warn = vi.mocked(console.warn);
    const manifest = withReplyKind((kind) => { kind.id = "Reply"; });
    getDeclaredAlertKinds(manifest, "fixturemail");
    getDeclaredSuggestionSources(manifest, "fixturemail");
    const refusals = warn.mock.calls.filter((call) => String(call.join(" ")).includes("alerts declaration rejected"));
    expect(refusals).toHaveLength(1);
  });

  it.each([
    ["a kind id with --", /does not match/, (k: Json) => { k.id = "mail--reply"; }],
    ["a one-character kind id", /does not match/, (k: Json) => { k.id = "r"; }],
    ["an upper-case kind id", /does not match/, (k: Json) => { k.id = "Reply"; }],
    ["a kind id ending in a hyphen", /does not match/, (k: Json) => { k.id = "reply-"; }],
    ["an unknown kind field", /unknown field 'cooldownMs'/, (k: Json) => { k.cooldownMs = 1; }],
    ["a missing defaultEnabled", /defaultEnabled is not a boolean/, (k: Json) => { delete k.defaultEnabled; }],
    ["a label without en", /label has no 'en' text/, (k: Json) => { k.label = { ko: "답장" }; }],
    ["a label over 40 characters", /label\.en is longer than 40/, (k: Json) => { k.label = { en: "x".repeat(41) }; }],
    ["a blank label", /label\.en is empty/, (k: Json) => { k.label = { en: "   " }; }],
    ["an invalid locale tag", /invalid locale 'EN_us'/, (k: Json) => { k.label = { en: "Reply", EN_us: "Reply" }; }],
    ["a description over 200 characters", /description\.en is longer than 200/, (k: Json) => { k.description = { en: "x".repeat(201) }; }],
    ["an action label over 24 characters", /actionLabel\.en is longer than 24/, (k: Json) => { k.actionLabel = { en: "x".repeat(25) }; }],
    ["a notification body naming a slot", /must be static text/, (k: Json) => {
      (k.osNotification as Json).body = { en: "From {senderName}" };
    }],
    ["a notification body over 80 characters", /body\.en is longer than 80/, (k: Json) => {
      (k.osNotification as Json).body = { en: "x".repeat(81) };
    }],
    ["a notification without defaultEnabled", /osNotification\.defaultEnabled is not a boolean/, (k: Json) => { delete (k.osNotification as Json).defaultEnabled; }],
    ["a slot name that breaks the pattern", /slot name 'sender-name'/, (k: Json) => {
      k.slots = { ...(k.slots as Json), "sender-name": { kind: "text", maxLength: 10 } };
      k.summary = { en: "{senderName} wrote: {subject} {sender-name}" };
    }],
    ["more than 8 slots", /more than 8 slots/, (k: Json) => {
      const slots: Json = { emailId: { kind: "ref" } };
      const refs: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        slots[`s${i}`] = { kind: "text", maxLength: 10 };
        refs.push(`{s${i}}`);
      }
      k.slots = slots;
      k.summary = { en: refs.join(" ") };
      k.prompt = { en: "Look." };
    }],
    ["a text slot over 200 characters", /maxLength is not an integer from 1 to 200/, (k: Json) => {
      (k.slots as Json).subject = { kind: "text", maxLength: 201 };
    }],
    ["a text slot without maxLength", /maxLength is not an integer from 1 to 200/, (k: Json) => { (k.slots as Json).subject = { kind: "text" }; }],
    ["a list slot with more than 5 items", /maxItems is not an integer from 1 to 5/, (k: Json) => {
      (k.slots as Json).subject = { kind: "list", maxItems: 6, maxLength: 10 };
    }],
    ["a list slot item over 120 characters", /maxLength is not an integer from 1 to 120/, (k: Json) => {
      (k.slots as Json).subject = { kind: "list", maxItems: 2, maxLength: 121 };
    }],
    ["a ref slot with a maxLength", /unknown field 'maxLength'/, (k: Json) => { (k.slots as Json).emailId = { kind: "ref", maxLength: 10 }; }],
    ["an unknown slot kind", /kind is not text, list or ref/, (k: Json) => { (k.slots as Json).subject = { kind: "html", maxLength: 10 }; }],
    ["a template naming an undeclared slot", /undeclared slot '\{body\}'/, (k: Json) => { k.summary = { en: "{senderName} wrote: {subject} {body}" }; }],
    ["a text slot neither English template uses", /slot 'senderName' that neither English template uses/, (k: Json) => {
      k.summary = { en: "{subject}", ko: "{senderName}: {subject}" };
      k.prompt = { en: "Help me answer {subject}." };
    }],
    ["a ref slot named in the summary", /summary\.en names ref slot/, (k: Json) => { k.summary = { en: "{senderName} wrote: {subject} {emailId}" }; }],
    ["a ref slot named in the prompt", /prompt\.en names ref slot/, (k: Json) => {
      k.prompt = { en: "Answer {senderName} about {subject}, mail {emailId}." };
    }],
    ["a < in a template", /summary\.en contains '<' or '>'/, (k: Json) => { k.summary = { en: "{senderName} wrote: {subject} <b>" }; }],
    ["a > in a translated template", /prompt\.ko contains '<' or '>'/, (k: Json) => {
      k.prompt = { en: "Answer {senderName} about {subject}.", ko: "{senderName} > {subject}" };
    }],
    ["an unmatched brace", /unmatched brace/, (k: Json) => { k.summary = { en: "{senderName} wrote: {subject" }; }],
    ["an empty reference", /undeclared slot '\{\}'/, (k: Json) => { k.summary = { en: "{senderName} wrote: {subject} {}" }; }],
    ["a line break in the summary", /summary\.en contains a line break/, (k: Json) => { k.summary = { en: "{senderName}\n{subject}" }; }],
    ["a summary over 200 characters", /summary\.en is longer than 200/, (k: Json) => { k.summary = { en: `{senderName}{subject}${"x".repeat(190)}` }; }],
    ["a prompt over 1000 characters", /prompt\.en is longer than 1000/, (k: Json) => { k.prompt = { en: `{senderName}{subject}${"x".repeat(990)}` }; }],
    ["two predecessors", /exactly one predecessor/, (k: Json) => {
      const first = (k.inherits as Json[])[0]!;
      k.inherits = [first, { ...first, pluginId: "otherfixture" }];
    }],
    ["an empty inherits list", /exactly one predecessor/, (k: Json) => { k.inherits = []; }],
    ["an inherit without sourceId", /sourceId is not a source id/, (k: Json) => { delete (k.inherits as Json[])[0]!.sourceId; }],
    ["an inherit without enabled", /enabled is not an object/, (k: Json) => { delete (k.inherits as Json[])[0]!.enabled; }],
    ["an inherit naming an invalid plugin id", /pluginId is not a plugin id/, (k: Json) => { (k.inherits as Json[])[0]!.pluginId = "Retired"; }],
    ["an inherit naming an invalid source id", /sourceId is not a source id/, (k: Json) => { (k.inherits as Json[])[0]!.sourceId = "-ave"; }],
    ["an inherit rule with no values", /values is not a list/, (k: Json) => {
      ((k.inherits as Json[])[0]!.enabled as Json).values = [];
    }],
    ["an inherit rule with an empty spelling", /unusable spelling/, (k: Json) => {
      ((k.inherits as Json[])[0]!.enabled as Json).values = [""];
    }],
    ["an inherit rule reading a reserved config key", /key is not a usable config key/, (k: Json) => {
      ((k.inherits as Json[])[0]!.enabled as Json).key = "constructor";
    }],
    ["an inherit rule with an unknown listed value", /listed is not/, (k: Json) => {
      ((k.inherits as Json[])[0]!.enabled as Json).listed = "maybe";
    }],
    ["an OS-notification mapping on a kind without OS notification", /maps a toggle the kind does not declare/, (k: Json) => { delete k.osNotification; }],
  ])("refuses the block for %s", (_label, reason, edit) => {
    expectRefused(withReplyKind(edit), reason);
  });

  it("accepts an optional OS-notification mapping left out", () => {
    const manifest = withReplyKind((k) => { delete (k.inherits as Json[])[0]!.osNotification; });
    expect(getDeclaredAlertKinds(manifest).map((k) => k.id)).toEqual(["reply", "digest"]);
  });

  it("accepts a kind with no slots and static templates", () => {
    const manifest = withReplyKind((k) => {
      delete k.slots;
      k.summary = { en: "A mail needs your reply." };
      k.prompt = { en: "Help me find the mail that needs a reply." };
    });
    expect(getDeclaredAlertKinds(manifest).map((k) => k.id)).toEqual(["reply", "digest"]);
  });

  it("refuses more than 12 kinds and duplicate kind ids", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ ...digestKind(), id: `digest${i}` }));
    expectRefused(withAlerts(alertsBlock({ kinds: many })));
    expectRefused(withAlerts(alertsBlock({ kinds: [digestKind(), digestKind()] })));
    const twelve = many.slice(0, 12);
    expect(getDeclaredAlertKinds(withAlerts(alertsBlock({ kinds: twelve })))).toHaveLength(12);
  });

  it("refuses a block without reasoning or with reasoning over 400 characters", () => {
    const { reasoning: _dropped, ...noReasoning } = alertsBlock();
    expectRefused(withAlerts(noReasoning));
    expectRefused(withAlerts(alertsBlock({ reasoning: "x".repeat(401) })));
  });

  it.each([
    ["a fifth source", /at most 4 sources/, ["overlay:a", "overlay:b", "overlay:c", "overlay:d", "overlay:e"]],
    ["a source containing --", /not an overlay source/, ["overlay:fixturemail--reply"]],
    ["a source outside the overlay pattern", /not an overlay source/, ["suggestion:fixturemail"]],
    ["a repeated source", /repeats a source/, ["overlay:a", "overlay:a"]],
    ["a source over 128 characters", /not an overlay source/, [`overlay:${"a".repeat(121)}`]],
  ])("refuses the block for %s in suggestions", (_label, reason, suggestions) => {
    expectRefused(withAlerts(alertsBlock({ suggestions })), reason);
  });

  it("accepts four suggestion sources and a block without any", () => {
    const four = ["overlay:a", "overlay:b", "overlay:c", "overlay:d"];
    expect(getDeclaredSuggestionSources(withAlerts(alertsBlock({ suggestions: four })))).toEqual(four);
    const { suggestions: _dropped, ...none } = alertsBlock();
    expect(getDeclaredSuggestionSources(withAlerts(none))).toEqual([]);
  });
});

describe("getDeclaredConfigInherits", () => {
  const read = (list: unknown) =>
    getDeclaredConfigInherits({ configInherits: list as PluginManifest["configInherits"] }, "fixturemail");

  it("reads a copy and value entry, and [] when none is declared", () => {
    const list = [
      { pluginId: "retiredfixture", from: "allowedSenderDomains", to: "alertSenderDomains" },
      { pluginId: "retiredfixture", to: "automationEnabled", value: true },
    ];
    expect(read(list)).toEqual(list);
    expect(read(undefined)).toEqual([]);
  });

  it.each([
    ["an entry with both from and value", /exactly one of 'from' and 'value'/, [{ pluginId: "retiredfixture", from: "a", to: "b", value: 1 }]],
    ["an entry with neither from nor value", /exactly one of 'from' and 'value'/, [{ pluginId: "retiredfixture", to: "b" }]],
    ["two entries with the same to", /two entries fill 'b'/, [
      { pluginId: "retiredfixture", from: "a", to: "b" },
      { pluginId: "otherfixture", value: false, to: "b" },
    ]],
    ["a reserved target key", /to is not a usable config key/, [{ pluginId: "retiredfixture", from: "a", to: "prototype" }]],
    ["an invalid plugin id", /pluginId is not a plugin id/, [{ pluginId: "Retired", from: "a", to: "b" }]],
    ["an unknown field", /unknown field 'once'/, [{ pluginId: "retiredfixture", from: "a", to: "b", once: true }]],
    ["a value no plugin config can hold", /value is not a value a plugin config can hold/, [{ pluginId: "retiredfixture", to: "b", value: JSON.parse('{"__proto__":1}') }]],
    ["an empty list", /not a list of 1 to 16 entries/, []],
  ])("refuses the list for %s", (_label, reason, list) => {
    expect(read(list)).toBeNull();
    const refusals = vi.mocked(console.warn).mock.calls
      .map((call) => call.join(" "))
      .filter((line) => line.includes("configInherits declaration rejected"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(reason);
  });
});

describe("parsePluginJson — alert declarations at load", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "alerts-manifest-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const makeValidator = permissiveManifestValidatorFactory({
    namespaceProperties: {
      entry: { type: "string" },
      tools: { type: "array" },
      alerts: { type: "object" },
      emittedEvents: { type: "array" },
    },
    namespaceRequired: ["entry", "tools"],
  });

  it("rejects the package id reserved for the host", async () => {
    const write = pluginManifestWriter({ id: "host", name: "Host" }, () => workDir);
    await expect(parsePluginJson(await write(), makeValidator())).rejects.toThrow(/reserved for the host/);
  });

  it("loads a plugin whose alert block is refused, and reports the refusal", async () => {
    const write = pluginManifestWriter({ id: "fixturemail", name: "Fixture Mail" }, () => workDir);
    const broken = alertsBlock({ kinds: [{ ...digestKind(), summary: { en: "Today: {missing}" } }] });
    const manifest = await parsePluginJson(await write({ alerts: broken }), makeValidator());
    expect(manifest.id).toBe("fixturemail");
    expect(getDeclaredAlertKinds(manifest)).toEqual([]);
    expect(String(vi.mocked(console.warn).mock.calls.flat().join(" "))).toMatch(/fixturemail.*alerts declaration rejected/);
  });

  it("drops a retired notification declaration and warns once with alerts", async () => {
    const warn = vi.mocked(console.warn);
    const write = pluginManifestWriter({ id: "fixturedeprecated", name: "Fixture Deprecated" }, () => workDir);
    const extra = {
      alerts: alertsBlock(),
      emittedEvents: ["fixture.reply.detected"],
      notificationEvents: [{ event: "fixture.reply.detected" }],
    };
    const validator = await buildManifestValidator();
    const first = await parsePluginJson(await write(extra), validator);
    const second = await parsePluginJson(await write(extra), validator);
    expect(first).not.toHaveProperty("notificationEvents");
    expect(second).not.toHaveProperty("notificationEvents");
    const retirementWarnings = warn.mock.calls.filter((call) => String(call.join(" ")).includes("ignoring retired field(s) notificationEvents"));
    expect(retirementWarnings).toHaveLength(1);
  });

  it("drops a malformed retired notification declaration without alerts", async () => {
    const warn = vi.mocked(console.warn);
    const write = pluginManifestWriter({ id: "fixturelegacy", name: "Fixture Legacy" }, () => workDir);
    const manifest = await parsePluginJson(
      await write({ notificationEvents: "malformed legacy field" }),
      await buildManifestValidator(),
    );
    expect(manifest).not.toHaveProperty("notificationEvents");
    expect(warn.mock.calls.some((call) => String(call.join(" ")).includes("ignoring retired field(s) notificationEvents"))).toBe(true);
  });
});

describe("the host manifest schema — alert declarations", () => {
  const document = (extra: Json) =>
    agentPluginsDocument({
      id: "fixturemail",
      version: "1.0.0",
      description: "Alert declaration fixture.",
      entry: "dist/index.js",
      tools: [],
      ...extra,
    });

  it("accepts a full alerts block and configInherits list", async () => {
    const validator = await buildManifestValidator();
    const ok = validator(document({
      alerts: alertsBlock(),
      configInherits: [
        { pluginId: "retiredfixture", from: "allowedSenderDomains", to: "alertSenderDomains" },
        { pluginId: "retiredfixture", to: "automationEnabled", value: true },
      ],
    }));
    expect(validator.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it.each<[string, Json]>([
    ["a fifth suggestion", { alerts: alertsBlock({ suggestions: ["overlay:a", "overlay:b", "overlay:c", "overlay:d", "overlay:e"] }) }],
    ["a suggestion containing --", { alerts: alertsBlock({ suggestions: ["overlay:fixturemail--reply"] }) }],
    ["a kind id containing --", { alerts: alertsBlock({ kinds: [{ ...digestKind(), id: "morning--digest" }] }) }],
    ["two predecessors", { alerts: alertsBlock({ kinds: [{ ...replyKind(), inherits: [(replyKind().inherits as Json[])[0], (replyKind().inherits as Json[])[0]] }] }) }],
    ["a blank label", { alerts: alertsBlock({ kinds: [{ ...digestKind(), label: { en: " " } }] }) }],
    ["blank reasoning", { alerts: alertsBlock({ reasoning: "\u00a0" }) }],
    ["a static body containing a brace", { alerts: alertsBlock({ kinds: [{ ...replyKind(), osNotification: { defaultEnabled: false, body: { en: "A {new} item" } } }] }) }],
    ...["description", "actionLabel", "summary", "prompt"].map((field) => [
      "blank " + field, { alerts: alertsBlock({ kinds: [{ ...replyKind(), [field]: { en: "\u00a0" } }] }) },
    ] as [string, Json]),
    ["a blank static body", { alerts: alertsBlock({ kinds: [{ ...replyKind(), osNotification: { defaultEnabled: false, body: { en: " " } } }] }) }],
    ["a label without en", { alerts: alertsBlock({ kinds: [{ ...digestKind(), label: { ko: "요약" } }] }) }],
    ["a template with <", { alerts: alertsBlock({ kinds: [{ ...digestKind(), summary: { en: "<b>{topics}</b>" } }] }) }],
    ["a configInherits entry with from and value", { configInherits: [{ pluginId: "retiredfixture", from: "a", to: "b", value: 1 }] }],
    ["a configInherits entry with neither", { configInherits: [{ pluginId: "retiredfixture", to: "b" }] }],
  ])("rejects %s", async (_label, extra) => {
    const validator = await buildManifestValidator();
    expect(validator(document(extra))).toBe(false);
  });
});
