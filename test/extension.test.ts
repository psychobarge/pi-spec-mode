// Drives the extension through a fake pi: no TUI, but every hook and command runs for real.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import specMode from "../src/index.ts";

type Handler = (event: any, ctx: any) => any;

function harness(opts: { plan?: boolean; picks?: string[]; confirms?: boolean[] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "proj-"));
  const handlers: Record<string, Handler[]> = {};
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const bus: Record<string, ((p: unknown) => void)[]> = {};
  const entries: any[] = [];
  const sent: { user: string[]; custom: any[] } = { user: [], custom: [] };
  const notes: string[] = [];
  const picks = [...(opts.picks ?? [])];
  const offered: string[][] = []; // options each select showed, to check what the picker filters out
  const asked: { title: string; message: string }[] = []; // confirmation dialogs, in order
  const answers = [...(opts.confirms ?? [])];
  let status: string | undefined;
  let sessionName: string | undefined;

  const pi: any = {
    on: (e: string, h: Handler) => (handlers[e] ??= []).push(h),
    registerCommand: (n: string, c: any) => (commands[n] = c),
    registerTool: (t: any) => (tools[t.name] = t),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
    sendMessage: (m: any) => sent.custom.push(m),
    sendUserMessage: (m: string) => sent.user.push(m),
    setSessionName: (n: string) => (sessionName = n),
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
      select: async (_m: string, options: string[]) => (offered.push(options), picks.shift()),
      input: async () => picks.shift(),
      confirm: async (title: string, message: string) => (asked.push({ title, message }), answers.length ? answers.shift()! : true),
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
  return { cwd, ctx, fire, prompt, commands, tools, bus, sent, notes, offered, asked, status: () => status, sessionName: () => sessionName, entries };
}

const TEMPLATE = readFileSync(new URL("../templates/spec_template.md", import.meta.url), "utf8");
const FILLED = readFileSync(new URL("../examples/0001_spec_dark_mode.md", import.meta.url), "utf8");
const AGREED = FILLED.replace("| Status | Draft |", "| Status | Agreed |");

/** A verify run that edits one Agreed spec: the file is on disk before and after the agent's edit. */
async function verifyEdit(h: any, path: string, edited: string, id = "e1") {
  const input = { path };
  await h.fire("tool_call", { toolName: "edit", toolCallId: id, input });
  writeFileSync(join(h.cwd, path), edited);
  await h.fire("tool_result", { toolName: "edit", toolCallId: id, input, isError: false });
}

test("/spec <request> enters spec mode, contract and status follow", async () => {
  const h = harness();
  await h.fire("session_start", { reason: "startup" });
  assert.equal(await h.prompt(), undefined);
  await h.commands.spec.handler("write the spec for offline mode", h.ctx);
  assert.deepEqual(h.sent.user, ["write the spec for offline mode"]);
  assert.equal(h.status(), "✎ spec-mode");
  // A request starting with a command word is sent as a request.
  await h.commands.spec.handler("verify that login works offline", h.ctx);
  assert.deepEqual(h.sent.user.at(-1), "verify that login works offline");
  assert.equal(h.status(), "✎ spec-mode");
  const contract = await h.prompt();
  assert.match(contract, /\[PI SPEC MODE CONTRACT v1: SPEC\]/);
  assert.match(contract, /specs\/0001_spec_<feature>\.md/);
  assert.match(contract, /## 1\. Problem/); // bundled template inlined
});

test("spec contract lists existing specs by title and goal, and asks for a conflict check", async () => {
  const h = harness();
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_dark_mode.md"), AGREED);
  await h.commands.spec.handler("start", h.ctx);
  const contract = await h.prompt();
  assert.match(contract, /- specs\/0001_spec_dark_mode\.md — Agreed — Dark mode: The user can switch the app to a dark theme\./);
  assert.match(contract, /check for conflicts/);
});

test("tool policy: spec folder writable, everything else refused", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  const call = (toolName: string, input: any) => h.fire("tool_call", { toolName, toolCallId: "t", input });
  assert.equal(await call("write", { path: "specs/0001_spec_x.md", content: "" }), undefined);
  assert.equal((await call("write", { path: "src/x.ts", content: "" }))?.block, true);
  assert.equal((await call("edit", { path: "specs/../package.json" }))?.block, true);
  assert.equal((await call("write", { path: "specs/-o.md", content: "" }))?.block, true);
  // Only .md: a git repo under specs/ needs `.git/HEAD` and `.git/config`, and git runs commands from its config.
  for (const path of ["specs/r/.git/config", "specs/r/.git/HEAD", "specs/notes.txt"])
    assert.equal((await call("write", { path, content: "" }))?.block, true, path);
  // Paths pi would rewrite after the check: refused, or pinned to the absolute path that was checked.
  assert.equal((await call("write", { path: "@specs/0001_spec_x.md", content: "" }))?.block, true);
  for (const path of ["file:///../specs/%2e%2e/../etc/x.md", "~/../specs/a.md", "@/../specs/a.md"]) {
    const input = { path, content: "" };
    assert.equal(await call("write", input), undefined);
    assert.equal(input.path, resolve(h.cwd, path));
    assert.ok(input.path.startsWith(join(h.cwd, "specs") + sep));
  }
  // The template is the user's: /spec agree relies on it.
  assert.equal((await call("write", { path: "specs/spec_template.md", content: "" }))?.block, true);
  assert.equal((await call("edit", { path: "specs/SPEC_TEMPLATE.md" }))?.block, true);
  // Symlinks under specs/ (a cloned repo can ship them) would carry the write outside.
  mkdirSync(join(h.cwd, "specs"), { recursive: true });
  mkdirSync(join(h.cwd, "src"));
  symlinkSync("../src", join(h.cwd, "specs/notes"));
  symlinkSync("../src/a.md", join(h.cwd, "specs/0002_spec_y.md"));
  for (const path of ["specs/notes/a.md", "specs/notes/deep/a.md", "specs/0002_spec_y.md"])
    assert.equal((await call("write", { path, content: "" }))?.block, true, path);
  assert.equal(await call("bash", { command: "grep -rn foo ." }), undefined);
  assert.equal((await call("bash", { command: "echo x > specs/a.md" }))?.block, true);
  assert.equal((await call("some_mcp_tool", {}))?.block, true);
  await h.commands.spec.handler("exit", h.ctx);
  assert.equal(await call("write", { path: "src/x.ts", content: "" }), undefined);
  assert.match(h.sent.custom.at(-1).content, /CONTRACT v1: NORMAL/);
});

test("a spec that is a symbolic link is not listed, and session start does not write through it", async () => {
  const h = harness();
  mkdirSync(join(h.cwd, "specs"));
  const target = FILLED.replace("| Status | Draft |", "| Status | Refused |");
  writeFileSync(join(h.cwd, "notes.md"), target);
  symlinkSync("../notes.md", join(h.cwd, "specs/0007_spec_x.md"));
  await h.fire("session_start");
  assert.equal(readFileSync(join(h.cwd, "notes.md"), "utf8"), target);
  assert.ok(existsSync(join(h.cwd, "specs/0007_spec_x.md")));
  assert.ok(!existsSync(join(h.cwd, "specs/Refused")));
  await h.commands.spec.handler("list", h.ctx);
  assert.doesNotMatch(h.notes.at(-1)!, /0007/);
});

test("write → complete → menu Agree flips Status and leaves spec mode", async () => {
  const h = harness({ picks: ["Agree"] });
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), FILLED);
  await h.fire("tool_result", { toolName: "write", toolCallId: "w", input: { path: "specs/0001_spec_x.md" }, isError: false });
  assert.equal(h.status(), "✎ spec-mode 0001 · Draft");
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
  assert.equal(h.status(), "✎ spec-mode 0001 · Draft / Agreed / Implemented / Refused");
});

test("agree refused when the Status row is gone", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), FILLED.replace(/^\| Status \|.*\n/m, ""));
  await h.fire("tool_result", { toolName: "write", toolCallId: "w", input: { path: "specs/0001_spec_x.md" }, isError: false });
  await h.commands.spec.handler("agree", h.ctx);
  assert.match(h.notes.at(-1)!, /Cannot agree[\s\S]*missing header row "Status"/);
});

test("agree refused when a section is left empty", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), FILLED.replace(/(## 3\. Non-goals\n)[\s\S]*?(?=## 4)/, "$1\n"));
  await h.fire("tool_result", { toolName: "write", toolCallId: "w", input: { path: "specs/0001_spec_x.md" }, isError: false });
  await h.commands.spec.handler("agree", h.ctx);
  assert.match(h.notes.at(-1)!, /Cannot agree[\s\S]*empty section "## 3\. Non-goals"/);
});

test("editing an Agreed spec puts it back to Draft and bumps Version", async () => {
  const h = harness();
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), AGREED);
  await h.commands.spec.handler("start", h.ctx);
  const ev = { toolName: "edit", toolCallId: "e1", input: { path: "specs/0001_spec_x.md" }, isError: false };
  await h.fire("tool_call", ev);
  await h.fire("tool_result", ev);
  const md = readFileSync(join(h.cwd, "specs/0001_spec_x.md"), "utf8");
  assert.match(md, /\| Status \| Draft \|/);
  const before = Number(/\| Version \| (\d+) \|/.exec(FILLED)![1]);
  assert.match(md, new RegExp(`\\| Version \\| ${before + 1} \\|`));
  // An edit that bumps Version itself is not bumped a second time.
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), md.replace("| Status | Draft |", "| Status | Agreed |"));
  const ev2 = { ...ev, toolCallId: "e2" };
  await h.fire("tool_call", ev2);
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), md.replace(/\| Version \| \d+ \|/, `| Version | ${before + 2} |`));
  await h.fire("tool_result", ev2);
  assert.match(readFileSync(join(h.cwd, "specs/0001_spec_x.md"), "utf8"), new RegExp(`\\| Version \\| ${before + 2} \\|`));
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
  assert.equal(h.status(), "✎ spec-mode verify");
  const c = await h.prompt();
  assert.match(c, /VERIFY/);
  assert.match(c, /specs\/0002_spec_b\.md`, `specs\/Implemented\/0003_spec_c\.md/);
  await h.fire("agent_settled", { aborted: false });
  assert.equal(h.status(), undefined);
});

test("/spec verify <spec> checks only that spec, even if verified today", async () => {
  const h = harness();
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs/Implemented"), { recursive: true });
  for (const [f, d] of [["0001_spec_a.md", ""], ["Implemented/0002_spec_b.md", "2026-11-16"]])
    writeFileSync(join(h.cwd, "specs", f), `| Status | Agreed |\n| Last verified | ${d} |\n`);
  await h.commands.spec.handler("verify 2", h.ctx);
  assert.deepEqual(h.sent.user, ["Verify the specs."]);
  assert.match(await h.prompt(), /in this order: `specs\/Implemented\/0002_spec_b\.md`\./);
  await h.fire("agent_settled", { aborted: false });
  // Not a spec name: still a request.
  await h.commands.spec.handler("verify that login works offline", h.ctx);
  assert.equal(h.sent.user.at(-1), "verify that login works offline");
  assert.equal(h.status(), "✎ spec-mode");
});

test("/spec agree or verify with a spec number that matches nothing says so and stays off", async () => {
  const h = harness();
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_a.md"), FILLED);
  for (const args of ["agree 9999", "verify 9999", "agree 0009_spec_x.md"]) {
    await h.commands.spec.handler(args, h.ctx);
    assert.match(h.notes.at(-1)!, /No spec/, args);
  }
  assert.deepEqual(h.sent.user, []);
  assert.equal(h.status(), undefined);
});

test("verify that drops an Agreed spec to Draft offers to agree it again at the end of the run", async () => {
  const h = harness({ picks: ["Agree again"] });
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  const p = join(h.cwd, "specs/0001_spec_a.md");
  writeFileSync(p, AGREED);
  await h.commands.spec.handler("verify 1", h.ctx);
  await verifyEdit(h, "specs/0001_spec_a.md", AGREED.replace("Dark mode", "Night mode"));
  assert.match(readFileSync(p, "utf8"), /\| Status \| Draft \|/);
  await h.fire("agent_settled", { aborted: false });
  assert.deepEqual(h.offered.at(-1), ["Agree again", "Keep Draft"]);
  assert.match(readFileSync(p, "utf8"), /\| Status \| Agreed \|/);
  assert.match(h.notes.at(-1)!, /0001 agreed again/);
  assert.equal(h.status(), undefined);
});

test("Keep Draft leaves the spec Draft", async () => {
  const h = harness({ picks: ["Keep Draft"] });
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  const p = join(h.cwd, "specs/0001_spec_a.md");
  writeFileSync(p, AGREED);
  await h.commands.spec.handler("verify 1", h.ctx);
  await verifyEdit(h, "specs/0001_spec_a.md", AGREED.replace("Dark mode", "Night mode"));
  await h.fire("agent_settled", { aborted: false });
  assert.match(readFileSync(p, "utf8"), /\| Status \| Draft \|/);
});

test("a spec only stamped Last verified stays Agreed and is not offered", async () => {
  const h = harness();
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  const p = join(h.cwd, "specs/0001_spec_a.md");
  writeFileSync(p, AGREED);
  await h.commands.spec.handler("verify 1", h.ctx);
  await verifyEdit(h, "specs/0001_spec_a.md", AGREED.replace("| Last verified | 2026-01-01 |", "| Last verified | 2026-12-24 |"));
  await h.fire("agent_settled", { aborted: false });
  assert.match(readFileSync(p, "utf8"), /\| Status \| Agreed \|/);
  assert.equal(h.offered.length, 0);
});

test("a spec already Draft is not offered: only what verify retired is", async () => {
  const h = harness();
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_a.md"), FILLED);
  await h.commands.spec.handler("verify 1", h.ctx);
  await verifyEdit(h, "specs/0001_spec_a.md", FILLED.replace("Dark mode", "Night mode"));
  await h.fire("agent_settled", { aborted: false });
  assert.equal(h.offered.length, 0);
  assert.match(readFileSync(join(h.cwd, "specs/0001_spec_a.md"), "utf8"), /\| Status \| Draft \|/);
});

test("the offer is refused when the spec no longer passes the template checks", async () => {
  const h = harness({ picks: ["Agree again"] });
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  const p = join(h.cwd, "specs/0001_spec_a.md");
  writeFileSync(p, AGREED);
  await h.commands.spec.handler("verify 1", h.ctx);
  // A section left empty: the same check as /spec agree keeps it Draft.
  await verifyEdit(h, "specs/0001_spec_a.md", AGREED.replace(/(## 3\. Non-goals\n)[\s\S]*?(?=## 4)/, "$1\n"));
  await h.fire("agent_settled", { aborted: false });
  assert.match(h.notes.at(-1)!, /Cannot agree[\s\S]*empty section "## 3\. Non-goals"/);
  assert.match(readFileSync(p, "utf8"), /\| Status \| Draft \|/);
});

test("no UI: specs retired by verify are reported instead of prompted", async () => {
  const h = harness();
  h.ctx.hasUI = false;
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  try {
    await h.fire("session_start");
    mkdirSync(join(h.cwd, "specs"));
    writeFileSync(join(h.cwd, "specs/0001_spec_a.md"), AGREED);
    await h.commands.spec.handler("verify 1", h.ctx);
    await verifyEdit(h, "specs/0001_spec_a.md", AGREED.replace("Dark mode", "Night mode"));
    await h.fire("agent_settled", { aborted: false });
  } finally {
    console.error = orig;
  }
  assert.equal(h.offered.length, 0);
  assert.match(errs.at(-1)!, /back to Draft: 0001\. Agree again with \/spec agree/);
  assert.match(readFileSync(join(h.cwd, "specs/0001_spec_a.md"), "utf8"), /\| Status \| Draft \|/);
});

test("the verify contract tells the agent the user is asked to agree the spec again", async () => {
  const h = harness();
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_a.md"), AGREED);
  await h.commands.spec.handler("verify 1", h.ctx);
  const c = await h.prompt();
  assert.match(c, /put back to Draft by spec mode itself/);
  assert.match(c, /never set Agreed yourself/);
});

test("/spec agree <spec> re-agrees a named Draft spec without sending a request", async () => {
  const h = harness();
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  const p = join(h.cwd, "specs/0001_spec_a.md");
  writeFileSync(p, FILLED);
  await h.commands.spec.handler("agree 1", h.ctx);
  assert.deepEqual(h.sent.user, []);
  assert.match(readFileSync(p, "utf8"), /\| Status \| Agreed \|/);
  assert.match(h.notes.at(-1)!, /0001 agreed/);
});

test("/spec agree <spec> on another spec keeps the one in progress in spec mode", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_a.md"), FILLED);
  writeFileSync(join(h.cwd, "specs/0002_spec_b.md"), FILLED);
  await h.fire("tool_result", { toolName: "write", toolCallId: "w", input: { path: "specs/0002_spec_b.md" }, isError: false });
  assert.equal(h.status(), "✎ spec-mode 0002 · Draft");
  await h.commands.spec.handler("agree 1", h.ctx);
  assert.match(h.notes.at(-1)!, /0001 agreed/);
  assert.match(readFileSync(join(h.cwd, "specs/0001_spec_a.md"), "utf8"), /\| Status \| Agreed \|/);
  assert.equal(h.status(), "✎ spec-mode 0002 · Draft");
  assert.deepEqual(h.sent.custom, []); // spec mode never stopped: no NORMAL contract
});

test("refusing the spec in progress leaves spec mode, refusing another one keeps it", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_a.md"), FILLED);
  writeFileSync(join(h.cwd, "specs/0002_spec_b.md"), FILLED);
  await h.fire("tool_result", { toolName: "write", toolCallId: "w", input: { path: "specs/0002_spec_b.md" }, isError: false });
  await h.commands.spec.handler("refuse 1", h.ctx);
  assert.ok(existsSync(join(h.cwd, "specs/Refused/0001_spec_a.md")));
  assert.equal(h.status(), "✎ spec-mode 0002 · Draft");
  await h.commands.spec.handler("refuse", h.ctx);
  assert.ok(existsSync(join(h.cwd, "specs/Refused/0002_spec_b.md")));
  assert.match(h.notes.at(-1)!, /0002 refused[\s\S]*spec mode off/);
  assert.equal(h.status(), undefined);
  assert.match(h.sent.custom.at(-1).content, /CONTRACT v1: NORMAL/);
});

test("a spec in progress set to Refused by hand leaves spec mode", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_a.md"), FILLED);
  await h.fire("tool_result", { toolName: "write", toolCallId: "w", input: { path: "specs/0001_spec_a.md" }, isError: false });
  const input = { path: "specs/0001_spec_a.md" };
  await h.fire("tool_call", { toolName: "edit", toolCallId: "e1", input });
  writeFileSync(join(h.cwd, "specs/0001_spec_a.md"), FILLED.replace("| Status | Draft |", "| Status | Refused |"));
  await h.fire("tool_result", { toolName: "edit", toolCallId: "e1", input, isError: false });
  assert.ok(existsSync(join(h.cwd, "specs/Refused/0001_spec_a.md")));
  assert.equal(h.status(), undefined);
});

test("/spec agree <spec> refuses an implemented spec", async () => {
  const h = harness();
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs/Implemented"), { recursive: true });
  const p = join(h.cwd, "specs/Implemented/0001_spec_a.md");
  writeFileSync(p, AGREED.replace("| Status | Agreed |", "| Status | Implemented |"));
  await h.commands.spec.handler("agree 1", h.ctx);
  assert.match(h.notes.at(-1)!, /already implemented/);
  assert.match(readFileSync(p, "utf8"), /\| Status \| Implemented \|/);
});

test("/spec agree <spec> uses the same template checks as the footer spec", async () => {
  const h = harness();
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  const p = join(h.cwd, "specs/0001_spec_a.md");
  writeFileSync(p, FILLED.replace(/(## 3\. Non-goals\n)[\s\S]*?(?=## 4)/, "$1\n"));
  await h.commands.spec.handler("agree 1", h.ctx);
  assert.match(h.notes.at(-1)!, /Cannot agree[\s\S]*empty section "## 3\. Non-goals"/);
  assert.match(readFileSync(p, "utf8"), /\| Status \| Draft \|/);
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
  // An implemented spec is refused; extended and agreed again, it goes to plan mode.
  mkdirSync(join(h.cwd, "specs/Implemented"));
  writeFileSync(join(h.cwd, "specs/Implemented/0002_spec_y.md"), "| Status | Implemented |\n");
  await h.commands.spec.handler("implement 2", h.ctx);
  assert.match(h.notes.at(-1)!, /Implemented: agree it first/);
  writeFileSync(join(h.cwd, "specs/Implemented/0002_spec_y.md"), "| Status | Agreed |\n");
  await h.commands.spec.handler("implement 2", h.ctx);
  assert.match(h.sent.user[1], /^\/plan Implement the agreed spec `specs\/Implemented\/0002_spec_y\.md`/);
  assert.equal(h.sessionName(), undefined); // renamePlanSession is off by default
});

test("renamePlanSession names the session after the spec handed to plan mode, typed or picked", async () => {
  const h = harness({ plan: true, picks: ["implement (hand a spec to plan mode)", "0002 · Agreed · y"] });
  h.ctx.isProjectTrusted = () => true;
  mkdirSync(join(h.cwd, ".pi"));
  writeFileSync(join(h.cwd, ".pi/pi-spec-mode.json"), '{ "renamePlanSession": true }');
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), "| Status | Agreed |\n");
  writeFileSync(join(h.cwd, "specs/0002_spec_y.md"), "| Status | Agreed |\n");
  await h.fire("session_start");
  await h.commands.spec.handler("implement 1", h.ctx);
  assert.equal(h.sessionName(), "spec 0001 planning");
  await h.commands.spec.handler("", h.ctx);
  assert.equal(h.sessionName(), "spec 0002 planning");
});

test("/spec menu runs the same commands as typing them", async () => {
  const h = harness({ plan: true, picks: ["implement (hand a spec to plan mode)", "0001 · Agreed · x", "start (enter spec mode)", "exit (leave spec mode)"] });
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), "| Status | Agreed |\n");
  await h.commands.spec.handler("", h.ctx);
  assert.match(h.sent.user[0], /^\/plan Implement the agreed spec `specs\/0001_spec_x\.md`/);
  await h.commands.spec.handler("", h.ctx);
  assert.equal(h.status(), "✎ spec-mode");
  await h.commands.spec.handler("", h.ctx);
  assert.equal(h.status(), undefined);
});

test("state survives a reload", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  await h.fire("session_start", { reason: "reload" });
  assert.equal(h.status(), "✎ spec-mode");
});

test("/spec template creates the project template once, then asks the agent to adapt it", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  assert.match(h.notes.at(-1)!, /generic spec template/);
  await h.commands.spec.handler("exit", h.ctx);
  await h.commands.spec.handler("template", h.ctx);
  const dest = join(h.cwd, "specs/spec_template.md");
  assert.equal(readFileSync(dest, "utf8"), TEMPLATE); // the copy exists before the run
  assert.equal(h.sent.user.length, 1);
  assert.match(h.sent.user[0], /specs\/spec_template\.md/);
  assert.match(h.sent.user[0], /reread/);
  assert.match(h.notes.at(-1)!, /reread/);
  writeFileSync(dest, "## Mine\n");
  await h.commands.spec.handler("template", h.ctx);
  assert.match(h.notes.at(-1)!, /already exists/);
  assert.equal(h.sent.user.length, 1); // no second run
  assert.equal(h.asked.length, 1); // an existing template is not even offered
  assert.equal(readFileSync(dest, "utf8"), "## Mine\n");
  await h.commands.spec.handler("start", h.ctx);
  assert.doesNotMatch(h.notes.at(-1)!, /generic/);
  assert.match(await h.prompt(), /## Mine/);
});

test("/spec template asks before adapting, and writes nothing when both answers are no", async () => {
  const h = harness({ confirms: [false, false] });
  await h.fire("session_start");
  await h.commands.spec.handler("template", h.ctx);
  assert.equal(existsSync(join(h.cwd, "specs")), false);
  assert.deepEqual(h.sent.user, []);
  assert.match(h.asked[0].message, /agent reads the project/);
  assert.match(h.asked[1].title, /Copy the generic template/);
  assert.match(h.notes.at(-1)!, /Nothing created/);
});

test("/spec template copies the generic template when the adaptation is declined", async () => {
  const h = harness({ confirms: [false, true] });
  await h.fire("session_start");
  await h.commands.spec.handler("template", h.ctx);
  assert.equal(readFileSync(join(h.cwd, "specs/spec_template.md"), "utf8"), TEMPLATE);
  assert.deepEqual(h.sent.user, []); // a plain copy starts no agent run
  assert.match(h.notes.at(-1)!, /by hand/);
});

test("the agent may rewrite the template during the /spec template run only", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  const call = (id: string) => h.fire("tool_call", { toolName: "write", toolCallId: id, input: { path: "specs/spec_template.md", content: "x" } });
  assert.equal((await call("t0"))?.block, true);
  await h.commands.spec.handler("template", h.ctx);
  assert.equal(await call("t1"), undefined);
  await h.fire("agent_settled");
  assert.match(h.notes.at(-1)!, /Reread specs\/spec_template\.md/);
  assert.equal((await call("t2"))?.block, true);
});

test("/spec template refuses while the agent runs, and copies without asking without UI", async () => {
  const h = harness();
  await h.fire("session_start");
  h.ctx.isIdle = () => false;
  await h.commands.spec.handler("template", h.ctx);
  assert.match(h.notes.at(-1)!, /wait or interrupt/);
  assert.equal(existsSync(join(h.cwd, "specs")), false);

  const headless = harness();
  await headless.fire("session_start");
  headless.ctx.hasUI = false;
  await headless.commands.spec.handler("template", headless.ctx);
  assert.equal(readFileSync(join(headless.cwd, "specs/spec_template.md"), "utf8"), TEMPLATE);
  assert.deepEqual(headless.sent.user, []);
  assert.equal(headless.asked.length, 0);
});

test("commands refuse what the current state does not allow", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("exit", h.ctx);
  assert.match(h.notes.at(-1)!, /not on/);
  await h.commands.spec.handler("agree", h.ctx);
  assert.match(h.notes.at(-1)!, /not on/);
  assert.deepEqual(h.commands.spec.getArgumentCompletions("").map((i: any) => i.value), ["start", "list", "agree", "verify", "implement", "refuse", "restore", "template", "settings"]);
  await h.commands.spec.handler("start", h.ctx);
  await h.commands.spec.handler("start", h.ctx);
  assert.match(h.notes.at(-1)!, /already on/);
  await h.commands.spec.handler("agree", h.ctx);
  assert.match(h.notes.at(-1)!, /No spec written yet/);
  assert.deepEqual(h.commands.spec.getArgumentCompletions("").map((i: any) => i.value), ["refuse", "list", "template", "exit", "settings"]);
});

test("/spec menu shows the same words as the completion, in every state", async () => {
  const h = harness({ picks: [] });
  await h.fire("session_start");
  const check = async () => {
    await h.commands.spec.handler("", h.ctx);
    const words = h.offered.at(-1)!.map((label) => label.split(" (")[0]);
    assert.deepEqual(words, h.commands.spec.getArgumentCompletions("").map((i: any) => i.value));
  };
  await check();
  await h.commands.spec.handler("start", h.ctx);
  await check();
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_x.md"), FILLED);
  await h.fire("tool_result", { toolName: "write", toolCallId: "w", input: { path: "specs/0001_spec_x.md" }, isError: false });
  await check();
  assert.ok(h.offered.at(-1)!.includes("agree (the spec in progress)"));
});

test("/spec menu agree outside spec mode picks a Draft spec", async () => {
  const h = harness({ picks: ["agree", "0002 · Draft · x"] });
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_a.md"), AGREED);
  writeFileSync(join(h.cwd, "specs/0002_spec_x.md"), FILLED);
  await h.commands.spec.handler("", h.ctx);
  assert.deepEqual(h.offered[1], ["0002 · Draft · x"]);
  assert.match(readFileSync(join(h.cwd, "specs/0002_spec_x.md"), "utf8"), /\| Status \| Agreed \|/);
});

test("/spec menu picks a spec from a list instead of typing a number", async () => {
  const setup = async (opts: { plan?: boolean; picks?: string[] }) => {
    const h = harness(opts);
    await h.fire("session_start");
    mkdirSync(join(h.cwd, "specs/Implemented"), { recursive: true });
    mkdirSync(join(h.cwd, "specs/Refused"), { recursive: true });
    writeFileSync(join(h.cwd, "specs/0001_spec_login.md"), "| Status | Agreed |\n");
    writeFileSync(join(h.cwd, "specs/0002_spec_draft.md"), "| Status | Draft |\n");
    writeFileSync(join(h.cwd, "specs/Implemented/0003_spec_done.md"), "| Status | Implemented |\n");
    writeFileSync(join(h.cwd, "specs/Refused/0004_spec_old.md"), "| Status | Refused |\n");
    return h;
  };

  // Implement offers only the Agreed one and dispatches to plan mode with its number.
  const impl = await setup({ plan: true, picks: ["implement (hand a spec to plan mode)", "0001 · Agreed · login"] });
  await impl.commands.spec.handler("", impl.ctx);
  assert.deepEqual(impl.offered[1], ["0001 · Agreed · login"]);
  assert.match(impl.sent.user[0], /^\/plan Implement the agreed spec `specs\/0001_spec_login\.md`/);

  // Refuse offers what it can move: the specs folder, not Implemented/ nor Refused/.
  const refuse = await setup({ picks: ["refuse", "0002 · Draft · draft"] });
  await refuse.commands.spec.handler("", refuse.ctx);
  assert.deepEqual(refuse.offered[1], ["0001 · Agreed · login", "0002 · Draft · draft"]);
  assert.ok(existsSync(join(refuse.cwd, "specs/Refused/0002_spec_draft.md")));

  // Restore offers only Refused/ and brings the spec back as Draft.
  const restore = await setup({ picks: ["restore (a refused spec)", "0004 · Refused · old"] });
  await restore.commands.spec.handler("", restore.ctx);
  assert.deepEqual(restore.offered[1], ["0004 · Refused · old"]);
  assert.match(readFileSync(join(restore.cwd, "specs/0004_spec_old.md"), "utf8"), /\| Status \| Draft \|/);

  // Nothing eligible: a message naming the command, no picker, no dispatch.
  const empty = harness({ plan: true, picks: ["implement (hand a spec to plan mode)"] });
  await empty.fire("session_start");
  mkdirSync(join(empty.cwd, "specs"));
  writeFileSync(join(empty.cwd, "specs/0001_spec_draft.md"), "| Status | Draft |\n");
  await empty.commands.spec.handler("", empty.ctx);
  assert.match(empty.notes.at(-1)!, /No Agreed spec to implement/);
  assert.equal(empty.offered.length, 1); // the menu only
  assert.deepEqual(empty.sent.user, []);
});

test("/spec settings says which files exist and reloads a project file created later", async () => {
  const h = harness();
  h.ctx.isProjectTrusted = () => true;
  await h.fire("session_start");
  await h.commands.spec.handler("settings", h.ctx);
  assert.match(h.notes.at(-1)!, /project: .*pi-spec-mode\.json \(not found\)/);
  mkdirSync(join(h.cwd, ".pi"));
  writeFileSync(join(h.cwd, ".pi/pi-spec-mode.json"), '{ "specsDir": "doc/specs" }');
  await h.commands.spec.handler("settings", h.ctx);
  assert.match(h.notes.at(-1)!, /\(found\)/);
  assert.match(h.notes.at(-1)!, /"specsDir": "doc\/specs"/);
});

test("/spec settings saves a picked value in the project file and keeps its other keys", async () => {
  const h = harness();
  h.ctx.isProjectTrusted = () => true;
  const file = join(h.cwd, ".pi/pi-spec-mode.json");
  mkdirSync(join(h.cwd, ".pi"));
  writeFileSync(file, '{ "language": "French" }');
  await h.fire("session_start");
  const picks = ["verifyCount: 2", "5", `this project (${file})`];
  h.ctx.ui.select = async (_m: string, options: string[]) => (h.offered.push(options), picks.shift());
  h.ctx.ui.input = async () => picks.shift();
  await h.commands.spec.handler("settings", h.ctx);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { language: "French", verifyCount: 5 });
  assert.match(h.notes.at(-1)!, /verifyCount set to 5/);
  assert.ok(h.offered.at(-1)!.includes("verifyCount: 5")); // the menu shows the new value
});

test("/spec settings refuses an invalid value and leaves a broken settings file untouched", async () => {
  const h = harness();
  h.ctx.isProjectTrusted = () => true;
  const file = join(h.cwd, ".pi/pi-spec-mode.json");
  mkdirSync(join(h.cwd, ".pi"));
  writeFileSync(file, "{ broken");
  const picks = ["specsDir: \"specs\"", "../elsewhere", "language: \"English\"", "French", `this project (${file})`];
  h.ctx.ui.select = async () => picks.shift();
  h.ctx.ui.input = async () => picks.shift();
  await h.commands.spec.handler("settings", h.ctx);
  assert.ok(h.notes.some((n) => /specsDir must be a folder inside the project, not saved/.test(n)));
  assert.match(h.notes.at(-1)!, /left unchanged/);
  assert.equal(readFileSync(file, "utf8"), "{ broken");
});

test("/spec settings in an untrusted project saves to the global file", async () => {
  const h = harness();
  const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const picks = ["renameSession: false", "true"];
    h.ctx.ui.select = async () => picks.shift();
    await h.commands.spec.handler("settings", h.ctx);
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "pi-spec-mode.json"), "utf8")), { renameSession: true });
    assert.ok(!existsSync(join(h.cwd, ".pi")));
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test("a non-string language setting falls back to English instead of reaching the contract", async () => {
  const h = harness();
  h.ctx.isProjectTrusted = () => true;
  mkdirSync(join(h.cwd, ".pi"), { recursive: true });
  writeFileSync(join(h.cwd, ".pi/pi-spec-mode.json"), '{ "language": 3 }');
  await h.fire("session_start");
  assert.match(h.notes.at(-1)!, /language must be a non-empty string/);
  await h.commands.spec.handler("start", h.ctx);
  assert.match(await h.prompt(), /Write the spec in English/);
});

test("a specsDir outside the project or on a file falls back to specs with a warning", async () => {
  for (const specsDir of ["../..", "README.md"]) {
    const h = harness();
    h.ctx.isProjectTrusted = () => true;
    mkdirSync(join(h.cwd, ".pi"));
    writeFileSync(join(h.cwd, "README.md"), "# x\n");
    writeFileSync(join(h.cwd, ".pi/pi-spec-mode.json"), JSON.stringify({ specsDir }));
    await h.fire("session_start");
    assert.deepEqual(h.notes, ['pi-spec-mode: specsDir must be a folder inside the project, using "specs"'], specsDir);
    await h.commands.spec.handler("list", h.ctx);
    assert.match(h.notes.at(-1)!, /No spec in specs\//, specsDir);
  }
});

/** The agent writes a spec file in spec mode, through the tool hooks. */
async function agentWrite(h: any, path: string, content: string, id: string) {
  const input = { path };
  await h.fire("tool_call", { toolName: "write", toolCallId: id, input });
  mkdirSync(join(h.cwd, "specs"), { recursive: true });
  writeFileSync(join(h.cwd, path), content);
  await h.fire("tool_result", { toolName: "write", toolCallId: id, input, isError: false });
}

test("renameSession names the session after the spec it creates, not one it edits", async () => {
  const h = harness();
  h.ctx.isProjectTrusted = () => true;
  mkdirSync(join(h.cwd, ".pi"));
  writeFileSync(join(h.cwd, ".pi/pi-spec-mode.json"), '{ "renameSession": true }');
  mkdirSync(join(h.cwd, "specs"));
  writeFileSync(join(h.cwd, "specs/0001_spec_a.md"), FILLED);
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  await agentWrite(h, "specs/0001_spec_a.md", FILLED + "\n", "w1");
  assert.equal(h.sessionName(), undefined);
  await agentWrite(h, "specs/0002_spec_b.md", FILLED, "w2");
  assert.equal(h.sessionName(), "spec 0002 creation");
});

test("the session is not renamed by default, and a non-boolean renameSession falls back to false", async () => {
  for (const file of [undefined, '{ "renameSession": "yes" }']) {
    const h = harness();
    h.ctx.isProjectTrusted = () => true;
    if (file) {
      mkdirSync(join(h.cwd, ".pi"));
      writeFileSync(join(h.cwd, ".pi/pi-spec-mode.json"), file);
    }
    await h.fire("session_start");
    if (file) assert.match(h.notes.at(-1)!, /renameSession must be true or false/);
    await h.commands.spec.handler("start", h.ctx);
    await agentWrite(h, "specs/0001_spec_a.md", FILLED, "w1");
    assert.equal(h.sessionName(), undefined);
  }
});

test("agent setting an Agreed spec to Refused moves it instead of resetting it to Draft", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  mkdirSync(join(h.cwd, "specs"));
  const p = join(h.cwd, "specs/0001_spec_a.md");
  writeFileSync(p, AGREED);
  const input = { path: "specs/0001_spec_a.md" };
  await h.fire("tool_call", { toolName: "edit", toolCallId: "t1", input });
  writeFileSync(p, FILLED.replace("| Status | Draft |", "| Status | Refused |"));
  await h.fire("tool_result", { toolName: "edit", toolCallId: "t1", input, isError: false });
  const moved = readFileSync(join(h.cwd, "specs/Refused/0001_spec_a.md"), "utf8");
  assert.match(moved, /^> \*\*REFUSED on/);
  assert.match(moved, /\| Status \| Refused \|/);
  assert.doesNotMatch(await h.prompt(), /0001_spec_a\.md —/);
});

test("only /spec agree makes a spec Agreed: an agent write that sets Agreed goes back to Draft", async () => {
  const h = harness({ plan: true });
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  mkdirSync(join(h.cwd, "specs"));
  const p = join(h.cwd, "specs/0001_spec_x.md");
  const AGREED = FILLED.replace("| Status | Draft |", "| Status | Agreed |");
  // New file written directly as Agreed.
  const ev = { toolName: "write", toolCallId: "w1", input: { path: "specs/0001_spec_x.md" }, isError: false };
  await h.fire("tool_call", ev);
  writeFileSync(p, AGREED);
  await h.fire("tool_result", ev);
  assert.match(readFileSync(p, "utf8"), /\| Status \| Draft \|/);
  assert.match(readFileSync(p, "utf8"), /\| Version \| 1 \|/); // never agreed: no Version bump
  assert.match(h.notes.at(-1)!, /only \/spec agree/);
  // Existing Draft edited to Agreed.
  const ev2 = { ...ev, toolName: "edit", toolCallId: "e2", input: { path: "specs/0001_spec_x.md" } };
  await h.fire("tool_call", ev2);
  writeFileSync(p, AGREED);
  await h.fire("tool_result", ev2);
  assert.match(readFileSync(p, "utf8"), /\| Status \| Draft \|/);
  // Same file through an upper-case extension (one file on macOS and Windows).
  const upper = join(h.cwd, "specs/0001_spec_x.MD");
  const ev3 = { ...ev, toolName: "edit", toolCallId: "e3", input: { path: "specs/0001_spec_x.MD" } };
  await h.fire("tool_call", ev3);
  writeFileSync(upper, AGREED);
  await h.fire("tool_result", ev3);
  assert.match(readFileSync(upper, "utf8"), /\| Status \| Draft \|/);
  await h.commands.spec.handler("implement 1", h.ctx);
  assert.deepEqual(h.sent.user, []);
});

test("verify run: stamping an Agreed spec keeps it Agreed, changing it or self-agreeing does not", async () => {
  const h = harness();
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  const AGREED = FILLED.replace("| Status | Draft |", "| Status | Agreed |");
  const a = join(h.cwd, "specs/0001_spec_a.md");
  const b = join(h.cwd, "specs/0002_spec_b.md");
  writeFileSync(a, AGREED);
  writeFileSync(b, FILLED);
  await h.commands.spec.handler("verify", h.ctx);
  const edit = async (file: string, id: string, next: string) => {
    const ev = { toolName: "edit", toolCallId: id, input: { path: file }, isError: false };
    await h.fire("tool_call", ev);
    writeFileSync(file, next);
    await h.fire("tool_result", ev);
    return readFileSync(file, "utf8");
  };
  // Only the Last verified stamp changes: still Agreed, same Version.
  const stamped = AGREED.replace(/\| Last verified \|.*\|/, "| Last verified | 2026-11-12 |");
  assert.equal(await edit(a, "v1", stamped), stamped);
  // Agreed → Implemented (drift fix asked by the verify contract) is left alone.
  const implemented = stamped.replace("| Status | Agreed |", "| Status | Implemented |");
  assert.equal(await edit(a, "v2", implemented), implemented);
  // Content of an Agreed spec changes: back to Draft, Version + 1.
  writeFileSync(a, AGREED);
  const changed = await edit(a, "v3", `${stamped}\nA rule nobody agreed.\n`);
  assert.match(changed, /\| Status \| Draft \|/);
  assert.match(changed, /\| Version \| 2 \|/);
  assert.match(changed, /A rule nobody agreed\./);
  // Draft → Agreed by the agent: back to Draft.
  assert.match(await edit(b, "v4", AGREED), /\| Status \| Draft \|/);
  // Implemented → Agreed by the agent (spec updated to match the code): stays Implemented.
  const IMPL = FILLED.replace("| Status | Draft |", "| Status | Implemented |");
  writeFileSync(a, IMPL);
  assert.match(await edit(a, "v5", `${AGREED}\nRule fixed to match the code.\n`), /\| Status \| Implemented \|/);
});

test("verify run: an Agreed spec the agent sets to Draft itself is handled like any changed Agreed spec", async () => {
  const h = harness({ picks: ["Keep Draft"] });
  await h.fire("session_start");
  mkdirSync(join(h.cwd, "specs"));
  const a = join(h.cwd, "specs/0001_spec_a.md");
  const b = join(h.cwd, "specs/0002_spec_b.md");
  writeFileSync(a, AGREED);
  writeFileSync(b, AGREED);
  await h.commands.spec.handler("verify", h.ctx);
  const selfDraft = AGREED.replace("| Status | Agreed |", "| Status | Draft |");
  // Status only: nothing to agree again, the spec stays Agreed.
  await verifyEdit(h, "specs/0001_spec_a.md", selfDraft, "d1");
  assert.equal(readFileSync(a, "utf8"), AGREED);
  // Status and content: Draft, Version + 1, and offered again when the run ends.
  await verifyEdit(h, "specs/0002_spec_b.md", `${selfDraft}\nA rule nobody agreed.\n`, "d2");
  const md = readFileSync(b, "utf8");
  assert.match(md, /\| Status \| Draft \|/);
  assert.match(md, /\| Version \| 2 \|/);
  await h.fire("agent_settled", { aborted: false });
  assert.equal(h.offered.at(-1)?.[0], "Agree again");
});

test("a project whose own path has a folder starting with - can still write specs", async () => {
  const h = harness();
  const cwd = join(h.cwd, "-perso", "app");
  mkdirSync(cwd, { recursive: true });
  h.ctx.cwd = cwd;
  await h.fire("session_start");
  await h.commands.spec.handler("start", h.ctx);
  const call = (path: string) => h.fire("tool_call", { toolName: "write", toolCallId: "t", input: { path, content: "" } });
  assert.equal(await call(join(cwd, "specs/0001_spec_x.md")), undefined);
  assert.equal(await call("../../-perso/app/specs/0001_spec_x.md"), undefined);
  assert.equal((await call(join(cwd, "specs/-o")))?.block, true);
  assert.equal((await call("specs/-dir/0001_spec_x.md"))?.block, true);
});

test("/spec list shows the specs, or says there are none", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.commands.spec.handler("list", h.ctx);
  assert.match(h.notes.at(-1)!, /No spec in specs\//);
  mkdirSync(join(h.cwd, "specs"), { recursive: true });
  writeFileSync(join(h.cwd, "specs/0001_spec_login.md"), "| Status | Draft |\n");
  await h.commands.spec.handler("list", h.ctx);
  assert.match(h.notes.at(-1)!, /0001 +Draft +never verified +login/);
});
