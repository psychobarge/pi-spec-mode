// Drives the extension through a fake pi: no TUI, but every hook and command runs for real.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import specMode from "../src/index.ts";

type Handler = (event: any, ctx: any) => any;

function harness(opts: { plan?: boolean; picks?: string[] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "proj-"));
  const handlers: Record<string, Handler[]> = {};
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const bus: Record<string, ((p: unknown) => void)[]> = {};
  const entries: any[] = [];
  const sent: { user: string[]; custom: any[] } = { user: [], custom: [] };
  const notes: string[] = [];
  const picks = [...(opts.picks ?? [])];
  let status: string | undefined;

  const pi: any = {
    on: (e: string, h: Handler) => (handlers[e] ??= []).push(h),
    registerCommand: (n: string, c: any) => (commands[n] = c),
    registerTool: (t: any) => (tools[t.name] = t),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
    sendMessage: (m: any) => sent.custom.push(m),
    sendUserMessage: (m: string) => sent.user.push(m),
    getCommands: () => (opts.plan ? [{ name: "plan", source: "extension" }] : []),
    events: { on: (c: string, f: any) => (bus[c] ??= []).push(f), emit: (c: string, p: unknown) => bus[c]?.forEach((f) => f(p)) },
  };
  const ctx: any = {
    cwd,
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => false,
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (m: string) => notes.push(m),
      setStatus: (_k: string, t?: string) => (status = t),
      select: async () => picks.shift(),
      input: async () => picks.shift(),
      theme: { fg: (_c: string, t: string) => t },
    },
  };
  specMode(pi);
  const fire = async (e: string, event: any = {}) => {
    let out;
    for (const h of handlers[e] ?? []) out = (await h({ type: e, ...event }, ctx)) ?? out;
    return out;
  };
  const prompt = async () => {
    const sections: Record<string, string> = {};
    await fire("before_agent_start", { systemPromptOptions: { sections } });
    return sections["spec-mode"];
  };
  return { cwd, ctx, fire, prompt, commands, tools, bus, sent, notes, status: () => status, entries };
}

const TEMPLATE = readFileSync(new URL("../templates/spec_template.md", import.meta.url), "utf8");
const FILLED = readFileSync(new URL("./fixtures/filled_spec.md", import.meta.url), "utf8");

test("trigger phrase enters spec mode, contract and status follow", async () => {
  const h = harness();
  await h.fire("session_start", { reason: "startup" });
  assert.equal(await h.prompt(), undefined);
  assert.equal(await h.fire("input", { text: "write the spec for offline mode", source: "interactive" }), undefined);
  assert.equal(h.status(), "spec-mode");
  const contract = await h.prompt();
  assert.match(contract, /\[PI SPEC MODE CONTRACT v1: SPEC\]/);
  assert.match(contract, /specs\/0001_spec_<feature>\.md/);
  assert.match(contract, /## 1\. Problem/); // bundled template inlined
});

test("tool policy: spec folder writable, everything else refused", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  const call = (toolName: string, input: any) => h.fire("tool_call", { toolName, toolCallId: "t", input });
  assert.equal(await call("write", { path: "specs/0001_spec_x.md", content: "" }), undefined);
  assert.equal((await call("write", { path: "src/x.ts", content: "" }))?.block, true);
  assert.equal((await call("edit", { path: "specs/../package.json" }))?.block, true);
  assert.equal(await call("bash", { command: "grep -rn foo ." }), undefined);
  assert.equal((await call("bash", { command: "echo x > specs/a.md" }))?.block, true);
  assert.equal((await call("some_mcp_tool", {}))?.block, true);
  await h.commands.spec.handler("exit", h.ctx);
  assert.equal(await call("write", { path: "src/x.ts", content: "" }), undefined);
  assert.match(h.sent.custom.at(-1).content, /CONTRACT v1: NORMAL/);
});

test("write → complete → menu Agree flips Status and leaves spec mode", async () => {
  const h = harness({ picks: ["Agree"] });
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), FILLED);
  await h.fire("tool_result", { toolName: "write", toolCallId: "w", input: { path: "specs/0001_spec_x.md" }, isError: false });
  assert.equal(h.status(), "spec-mode 0001 · Draft");
  await h.tools.spec_complete.execute("c", { path: "specs/0001_spec_x.md" }, undefined, undefined, h.ctx);
  await h.fire("agent_settled", { aborted: false });
  assert.match(readFileSync(join(h.cwd, "specs/0001_spec_x.md"), "utf8"), /\| Status \| Agreed \|/);
  assert.equal(h.status(), undefined);
});

test("agree refused while template text is left", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), TEMPLATE);
  await h.fire("tool_result", { toolName: "write", toolCallId: "w", input: { path: "specs/0001_spec_x.md" }, isError: false });
  await h.commands.spec.handler("agree", h.ctx);
  assert.match(h.notes.at(-1)!, /Cannot agree/);
  assert.equal(h.status(), "spec-mode 0001 · Draft / Agreed / Implemented");
});

test("editing an Agreed spec puts it back to Draft and bumps Version", async () => {
  const h = harness();
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), FILLED.replace("| Status | Draft |", "| Status | Agreed |"));
  await h.commands.spec.handler("start", h.ctx);
  const ev = { toolName: "edit", toolCallId: "e1", input: { path: "specs/0001_spec_x.md" }, isError: false };
  await h.fire("tool_call", ev);
  await h.fire("tool_result", ev);
  const md = readFileSync(join(h.cwd, "specs/0001_spec_x.md"), "utf8");
  assert.match(md, /\| Status \| Draft \|/);
  const before = Number(/\| Version \| (\d+) \|/.exec(FILLED)![1]);
  assert.match(md, new RegExp(`\\| Version \\| ${before + 1} \\|`));
});

test("plan mode active blocks spec mode; spec mode answers plan mode's mutex", async () => {
  const h = harness();
  await h.fire("session_start");
  const planHolder = (p: any) => { if (p.group === "agent-workflow") p.busy = true; };
  h.bus["workflow:mutex:v1"].push(planHolder);
  await h.commands.spec.handler("start", h.ctx);
  assert.match(h.notes.at(-1)!, /Plan mode/);
  h.bus["workflow:mutex:v1"].pop();
  await h.commands.spec.handler("start", h.ctx);
  const attempt = { session: h.ctx.sessionManager, group: "agent-workflow", busy: false };
  h.bus["workflow:mutex:v1"].forEach((f) => f(attempt));
  assert.equal(attempt.busy, true);
});

test("verify run: picks the two oldest, uses its contract, returns to previous mode", async () => {
  const h = harness();
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs/Implemented"), { recursive: true });
  for (const [f, d] of [["0001_spec_a.md", "2026-05-01"], ["0002_spec_b.md", ""], ["Implemented/0003_spec_c.md", "2026-01-01"]])
    writeFileSync(join(h.cwd, "specs", f), `| Status | Agreed |\n| Last verified | ${d} |\n`);
  await h.commands.spec.handler("verify", h.ctx);
  assert.deepEqual(h.sent.user, ["Verify the specs."]);
  assert.equal(h.status(), "spec-mode verify");
  const c = await h.prompt();
  assert.match(c, /VERIFY/);
  assert.match(c, /specs\/0002_spec_b\.md`, `specs\/Implemented\/0003_spec_c\.md/);
  await h.fire("agent_settled", { aborted: false });
  assert.equal(h.status(), undefined);
});

test("implement: needs plan mode, an Agreed spec, then dispatches /plan", async () => {
  const none = harness();
  await none.fire("session_start");
  await none.commands.spec.handler("implement 1", none.ctx);
  assert.match(none.notes.at(-1)!, /needs plan mode/);

  const h = harness({ plan: true });
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), "| Status | Draft |\n");
  await h.commands.spec.handler("implement 1", h.ctx);
  assert.match(h.notes.at(-1)!, /agree it first/);
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), "| Status | Agreed |\n");
  await h.commands.spec.handler("implement x", h.ctx);
  assert.match(h.sent.user[0], /^\/plan Implement the agreed spec `specs\/0001_spec_x\.md`/);
  assert.match(h.sent.user[0], /specs\/Implemented\//);
});

test("state survives a reload", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  await h.fire("session_start", { reason: "reload" });
  assert.equal(h.status(), "spec-mode");
});

test("/spec template creates the project template once; spec mode warns until it exists", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  assert.match(h.notes.at(-1)!, /generic spec template/);
  await h.commands.spec.handler("exit", h.ctx);
  await h.commands.spec.handler("template", h.ctx);
  const dest = join(h.cwd, "specs/spec_template.md");
  assert.equal(readFileSync(dest, "utf8"), TEMPLATE);
  writeFileSync(dest, "## Mine\n");
  await h.commands.spec.handler("template", h.ctx);
  assert.match(h.notes.at(-1)!, /already exists/);
  assert.equal(readFileSync(dest, "utf8"), "## Mine\n");
  await h.commands.spec.handler("start", h.ctx);
  assert.doesNotMatch(h.notes.at(-1)!, /generic/);
  assert.match(await h.prompt(), /## Mine/);
});

test("commands refuse what the current state does not allow", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("exit", h.ctx);
  assert.match(h.notes.at(-1)!, /not on/);
  await h.commands.spec.handler("agree", h.ctx);
  assert.match(h.notes.at(-1)!, /not on/);
  assert.deepEqual(h.commands.spec.getArgumentCompletions("").map((i: any) => i.value), ["start", "verify", "implement", "template", "settings"]);
  await h.commands.spec.handler("start", h.ctx);
  await h.commands.spec.handler("start", h.ctx);
  assert.match(h.notes.at(-1)!, /already on/);
  await h.commands.spec.handler("agree", h.ctx);
  assert.match(h.notes.at(-1)!, /No spec written yet/);
  assert.deepEqual(h.commands.spec.getArgumentCompletions("").map((i: any) => i.value), ["exit", "template", "settings"]);
});
