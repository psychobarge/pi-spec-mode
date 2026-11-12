import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  getField, isInside, isReadOnlyCommand, leftovers, listSpecs, missingSections,
  nextSpecNumber, refuseSpec, resolveSpec, restoreSpec, SPEC_FILE, setField, sweepRefused, today, verifyQueue,
} from "./core.ts";
import { implementRequest, NORMAL_CONTRACT, specContract, verifyContract } from "./prompts.ts";

type Mode = "off" | "spec" | "verify";
interface State {
  mode: Mode;
  spec?: string; // project-relative path of the spec being written
  before?: "off" | "spec"; // mode to return to after a verify run
  targets?: string[];
}
interface Settings {
  specsDir: string;
  language: string;
  verifyCount: number;
}

const STATE_ENTRY = "spec-mode";
const SECTION = "spec-mode";
const MUTEX = "workflow:mutex:v1"; // shared with @narumitw/pi-plan-mode: only one agent workflow at a time
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "spec_question", "spec_complete"]);
const BUNDLED_TEMPLATE = fileURLToPath(new URL("../templates/spec_template.md", import.meta.url));
const USAGE = "/spec start | <request> | agree | refuse [spec] | restore <spec> | verify | implement <spec> | template | exit | settings";
const DEFAULT_SETTINGS: Settings = { specsDir: "specs", language: "English", verifyCount: 2 };

export default function specMode(pi: ExtensionAPI) {
  let state: State = { mode: "off" };
  let settings = DEFAULT_SETTINGS;
  let session: object | undefined;
  let completeRequested = false;
  const beforeEdit = new Map<string, string>(); // toolCallId of a write/edit in the specs folder → the file's content before it ("" for a new file)

  const specsAbs = (ctx: ExtensionContext) => resolve(ctx.cwd, settings.specsDir);
  const rel = (ctx: ExtensionContext, p: string) => relative(ctx.cwd, resolve(ctx.cwd, p));
  const notify = (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error" = "info") =>
    ctx.hasUI ? ctx.ui.notify(msg, level) : console.error(msg);

  function loadSettings(ctx: ExtensionContext): Settings {
    const files = [join(getAgentDir(), "pi-spec-mode.json")];
    if (ctx.isProjectTrusted()) files.push(join(ctx.cwd, ".pi", "pi-spec-mode.json"));
    let s: Settings = { ...DEFAULT_SETTINGS };
    for (const f of files) {
      if (!existsSync(f)) continue;
      try {
        s = { ...s, ...JSON.parse(readFileSync(f, "utf8")) };
      } catch (e) {
        notify(ctx, `pi-spec-mode: ignoring ${f}: ${(e as Error).message}`, "warning");
      }
    }
    // The specs folder is the only place spec mode may write: never let a setting point it outside the project.
    if (typeof s.specsDir !== "string" || !isInside(".", ctx.cwd, s.specsDir)) {
      notify(ctx, `pi-spec-mode: specsDir must be a folder inside the project, using "specs"`, "warning");
      s.specsDir = "specs";
    }
    if (!Number.isInteger(s.verifyCount) || s.verifyCount < 1) {
      notify(ctx, `pi-spec-mode: verifyCount must be a positive integer, using 2`, "warning");
      s.verifyCount = 2;
    }
    return s;
  }

  const localTemplate = (ctx: ExtensionContext) => join(specsAbs(ctx), "spec_template.md");

  function template(ctx: ExtensionContext): string {
    return readFileSync(existsSync(localTemplate(ctx)) ? localTemplate(ctx) : BUNDLED_TEMPLATE, "utf8");
  }

  function createTemplate(ctx: ExtensionContext) {
    const dest = localTemplate(ctx);
    if (existsSync(dest)) return notify(ctx, `${rel(ctx, dest)} already exists: edit it to fit your project.`, "warning");
    mkdirSync(specsAbs(ctx), { recursive: true });
    writeFileSync(dest, readFileSync(BUNDLED_TEMPLATE, "utf8"));
    notify(ctx, `Created ${rel(ctx, dest)} — adapt its sections and hints to your project; spec mode now uses it.`);
  }

  function specStatus(ctx: ExtensionContext, p: string): string | undefined {
    const abs = resolve(ctx.cwd, p);
    return existsSync(abs) ? getField(readFileSync(abs, "utf8"), "Status") : undefined;
  }

  function refresh(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    let text: string | undefined;
    if (state.mode === "verify") text = "spec-mode verify";
    else if (state.mode === "spec") {
      const status = state.spec && specStatus(ctx, state.spec);
      text = status ? `spec-mode ${basename(state.spec!).slice(0, 4)} · ${status}` : "spec-mode";
    }
    ctx.ui.setStatus("spec-mode", text && ctx.ui.theme.fg("accent", text));
  }

  function save(ctx: ExtensionContext, next: State) {
    state = next;
    pi.appendEntry(STATE_ENTRY, state);
    refresh(ctx);
  }

  function restore(ctx: ExtensionContext) {
    settings = loadSettings(ctx);
    session = ctx.sessionManager;
    const entry = ctx.sessionManager
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === STATE_ENTRY)
      .pop() as { data?: State } | undefined;
    state = entry?.data ?? { mode: "off" };
    // A verify run never outlives its run: a resumed one goes back to where it started.
    if (state.mode === "verify") state = { mode: state.before ?? "off", spec: state.spec };
    refresh(ctx);
    sweep(ctx);
  }

  // Answer other workflows (plan mode) asking whether the session is free.
  pi.events.on(MUTEX, (payload) => {
    try {
      const a = payload as { session?: unknown; group?: unknown; busy?: unknown };
      if (state.mode !== "off" && a.session === session && a.group === "agent-workflow" && typeof a.busy === "boolean") a.busy = true;
    } catch {
      // protocol listeners ignore malformed payloads
    }
  });

  function otherWorkflowActive(ctx: ExtensionContext): boolean {
    const attempt = { session: ctx.sessionManager, group: "agent-workflow", busy: false };
    pi.events.emit(MUTEX, attempt);
    return attempt.busy;
  }

  /** Returns an error message, or undefined when spec mode is on. */
  function enter(ctx: ExtensionContext): string | undefined {
    if (state.mode === "spec") return "Spec mode is already on.";
    if (state.mode === "verify") return "A spec verify run is in progress.";
    if (otherWorkflowActive(ctx)) return "Plan mode (or another workflow) is active: finish or exit it before starting spec mode.";
    save(ctx, { mode: "spec" });
    notify(ctx, `Spec mode on — writes limited to ${settings.specsDir}/`);
    if (!existsSync(localTemplate(ctx)))
      notify(ctx, `Using the generic spec template. Run /spec template to create your own in ${settings.specsDir}/ and adapt it to your project.`, "warning");
    return undefined;
  }

  function exit(ctx: ExtensionContext, message?: string) {
    if (state.mode === "off") return notify(ctx, "Spec mode is not on.", "warning");
    completeRequested = false;
    save(ctx, { mode: "off" });
    pi.sendMessage({ customType: "spec-mode-contract", content: NORMAL_CONTRACT, display: false }, { deliverAs: "nextTurn" });
    notify(ctx, message ?? "Spec mode off");
  }

  /** Agrees the spec shown in the footer: only in spec mode, once a spec file is written. */
  function agree(ctx: ExtensionContext) {
    if (state.mode !== "spec") return notify(ctx, "Spec mode is not on: /spec agree works on the spec being written.", "warning");
    const p = state.spec && resolve(ctx.cwd, state.spec);
    if (!p || !existsSync(p)) return notify(ctx, "No spec written yet in this spec mode session.", "warning");
    const md = readFileSync(p, "utf8");
    const tpl = template(ctx);
    const problems = [...missingSections(md, tpl).map((h) => `missing section "${h}"`), ...leftovers(md, tpl)];
    if (getField(md, "Status") === undefined) problems.push(`missing header row "Status"`); // setField would silently do nothing
    if (problems.length) return notify(ctx, `Cannot agree ${rel(ctx, p)}:\n- ${problems.join("\n- ")}`, "error");
    writeFileSync(p, setField(md, "Status", "Agreed"));
    exit(ctx, `${basename(p).slice(0, 4)} agreed`);
  }

  /** Puts the session in a verify run; the caller sends the message that starts it. */
  function startVerify(ctx: ExtensionContext): boolean {
    if (state.mode === "verify") return notify(ctx, "A verify run is already in progress.", "warning"), false;
    sweep(ctx);
    const targets = verifyQueue(specsAbs(ctx), today(), settings.verifyCount);
    if (!listSpecs(specsAbs(ctx)).length) return notify(ctx, `No specs in ${settings.specsDir}/ to verify.`), false;
    if (!targets.length) return notify(ctx, `The ${settings.verifyCount} oldest specs were already verified today: nothing to do.`), false;
    if (state.mode === "off" && otherWorkflowActive(ctx))
      return notify(ctx, "Plan mode (or another workflow) is active: exit it before verifying specs.", "warning"), false;
    save(ctx, { mode: "verify", before: state.mode as "off" | "spec", spec: state.spec, targets: targets.map((t) => rel(ctx, t)) });
    return true;
  }

  function implement(ctx: ExtensionContext, arg: string) {
    const plan = pi.getCommands().find((c) => c.source === "extension" && /^plan(:\d+)?$/.test(c.name));
    if (!plan) return notify(ctx, "Implementing a spec needs plan mode: pi install npm:@narumitw/pi-plan-mode", "warning");
    if (!arg.trim()) return notify(ctx, "Which spec? /spec implement <number or name>", "warning");
    const p = resolveSpec(specsAbs(ctx), arg);
    if (!p) return notify(ctx, `No spec "${arg}" in ${settings.specsDir}/ or ${settings.specsDir}/Implemented/`, "warning");
    if (basename(dirname(p)) === "Implemented") return notify(ctx, `${rel(ctx, p)} is already implemented.`, "warning");
    const status = getField(readFileSync(p, "utf8"), "Status");
    if (status !== "Agreed") return notify(ctx, `${rel(ctx, p)} is ${status ?? "not Agreed"}: agree it first (/spec agree).`, "warning");
    if (!ctx.isIdle()) return notify(ctx, "The agent is running: wait or interrupt, then retry.", "warning");
    if (state.mode !== "off") exit(ctx, "Spec mode off — handing over to plan mode");
    const line = `/${plan.name} ${implementRequest(rel(ctx, p), settings.specsDir)}`;
    try {
      pi.sendUserMessage(line, { expandPromptTemplates: true });
    } catch (e) {
      notify(ctx, `Plan mode did not start (${(e as Error).message}). Run it yourself:\n${line}`, "error");
    }
  }

  /** Moves a spec to Refused/: kept for later, ignored by verify and the agent. Defaults to the spec being written. */
  function refuse(ctx: ExtensionContext, arg: string) {
    if (state.mode === "verify") return notify(ctx, "A spec verify run is in progress.", "warning");
    const p = arg.trim() ? resolveSpec(specsAbs(ctx), arg) : state.spec && resolve(ctx.cwd, state.spec);
    if (!p || !existsSync(p)) return notify(ctx, arg.trim() ? `No spec "${arg}" in ${settings.specsDir}/` : "Which spec? /spec refuse <number or name>", "warning");
    if (basename(dirname(p)) === "Implemented") return notify(ctx, `${rel(ctx, p)} is already implemented.`, "warning");
    let dest: string;
    try {
      dest = refuseSpec(specsAbs(ctx), p, today());
    } catch (e) {
      return notify(ctx, `Cannot refuse ${rel(ctx, p)}: ${(e as Error).message}`, "error");
    }
    if (state.spec && resolve(ctx.cwd, state.spec) === p) save(ctx, { ...state, spec: undefined });
    notify(ctx, `${basename(p).slice(0, 4)} refused, moved to ${rel(ctx, dest)}`);
  }

  /** Brings a refused spec back to the specs folder as Draft. */
  function restoreRefused(ctx: ExtensionContext, arg: string) {
    if (state.mode === "verify") return notify(ctx, "A spec verify run is in progress.", "warning");
    if (!arg.trim()) return notify(ctx, "Which spec? /spec restore <number or name>", "warning");
    const p = resolveSpec(specsAbs(ctx), arg, true);
    if (!p || basename(dirname(p)) !== "Refused") return notify(ctx, `No refused spec "${arg}" in ${settings.specsDir}/Refused/`, "warning");
    try {
      notify(ctx, `${basename(p).slice(0, 4)} restored as Draft to ${rel(ctx, restoreSpec(specsAbs(ctx), p))}`);
    } catch (e) {
      notify(ctx, `Cannot restore ${rel(ctx, p)}: ${(e as Error).message}`, "error");
    }
  }

  /** A spec set to Refused by hand or by the agent is moved like /spec refuse would. */
  function sweep(ctx: ExtensionContext) {
    try {
      for (const p of sweepRefused(specsAbs(ctx), today())) {
        if (state.spec && basename(state.spec) === basename(p)) save(ctx, { ...state, spec: undefined });
        notify(ctx, `${basename(p).slice(0, 4)} is Refused: moved to ${rel(ctx, p)}`);
      }
    } catch (e) {
      notify(ctx, `pi-spec-mode: could not move a refused spec: ${(e as Error).message}`, "warning");
    }
  }

  function showSettings(ctx: ExtensionContext) {
    settings = loadSettings(ctx); // pick up a file created since the session started
    const global = join(getAgentDir(), "pi-spec-mode.json");
    const project = join(ctx.cwd, ".pi", "pi-spec-mode.json");
    const state = (f: string) => (existsSync(f) ? "found" : "not found");
    notify(
      ctx,
      [
        "pi-spec-mode settings — both files are optional; anything they do not set uses the default.",
        `  global:  ${global} (${state(global)})`,
        `  project: ${project} (${ctx.isProjectTrusted() ? state(project) : "ignored: project not trusted"})`,
        `Effective:\n${JSON.stringify(settings, null, 2)}`,
      ].join("\n"),
    );
  }

  pi.on("session_start", async (_e, ctx) => restore(ctx));
  pi.on("session_tree", async (_e, ctx) => restore(ctx));

  pi.registerCommand("spec", {
    description: `Spec mode: ${USAGE}`,
    getArgumentCompletions: (prefix) => {
      // Offer only what the current state accepts.
      const valid =
        state.mode === "off" ? ["start", "verify", "implement", "refuse", "restore", "template", "settings"]
        : state.mode === "spec" ? [...(state.spec ? ["agree"] : []), "refuse", "exit", "template", "settings"]
        : ["settings"];
      const items = valid.filter((s) => s.startsWith(prefix));
      return items.length ? items.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const [sub = "", ...restWords] = args.trim().split(/\s+/);
      const rest = restWords.join(" ");
      const idle = ctx.isIdle();
      const busy = () => notify(ctx, "The agent is running: wait or interrupt, then retry.", "warning");

      switch (sub) {
        case "": {
          if (!ctx.hasUI) return notify(ctx, `Usage: ${USAGE}`);
          const options =
            state.mode === "off"
              ? ["Start spec mode", "Verify specs", "Implement a spec", "Refuse a spec", "Restore a refused spec", "Create the project template", "Settings"]
              : [...(state.spec ? ["Agree the spec", "Refuse the spec"] : []), "Leave spec mode", "Settings"];
          const pick = await ctx.ui.select("Spec mode", options);
          if (pick === "Start spec mode") return idle ? void enter(ctx) : busy();
          if (pick === "Verify specs") return idle ? (startVerify(ctx) ? pi.sendUserMessage("Verify the specs.") : undefined) : busy();
          if (pick === "Implement a spec") {
            const which = await ctx.ui.input("Spec number or name:", "0001");
            return which ? implement(ctx, which) : undefined;
          }
          if (pick === "Refuse a spec" || pick === "Restore a refused spec") {
            const which = await ctx.ui.input("Spec number or name:", "0001");
            if (!which) return;
            return idle ? (pick === "Refuse a spec" ? refuse(ctx, which) : restoreRefused(ctx, which)) : busy();
          }
          if (pick === "Refuse the spec") return idle ? refuse(ctx, "") : busy();
          if (pick === "Agree the spec") return idle ? agree(ctx) : busy();
          if (pick === "Leave spec mode") return idle ? exit(ctx) : busy();
          if (pick === "Create the project template") return createTemplate(ctx);
          if (pick === "Settings") return showSettings(ctx);
          return;
        }
        case "start": {
          if (!idle) return busy();
          const err = enter(ctx);
          return err ? notify(ctx, err, "warning") : undefined;
        }
        case "exit":
        case "off":
          return idle ? exit(ctx) : busy();
        case "agree":
          return idle ? agree(ctx) : busy();
        case "verify":
          if (!idle) return busy();
          if (startVerify(ctx)) pi.sendUserMessage("Verify the specs.");
          return;
        case "implement":
          return implement(ctx, rest);
        case "refuse":
          return idle ? refuse(ctx, rest) : busy();
        case "restore":
          return idle ? restoreRefused(ctx, rest) : busy();
        case "template":
          return createTemplate(ctx);
        case "settings":
          return showSettings(ctx);
        default: {
          if (state.mode === "spec") return pi.sendUserMessage(args, idle ? undefined : { deliverAs: "followUp" });
          if (!idle) return busy();
          const err = enter(ctx);
          if (err) return notify(ctx, err, "warning");
          pi.sendUserMessage(args);
        }
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const sections = event.systemPromptOptions.sections;
    if (state.mode === "off") {
      delete sections[SECTION];
      return;
    }
    if (state.mode === "verify") {
      sections[SECTION] = verifyContract(settings.specsDir, today(), state.targets ?? []);
      return;
    }
    sweep(ctx);
    const specs = listSpecs(specsAbs(ctx)).map((p) => `${rel(ctx, p)} — ${getField(readFileSync(p, "utf8"), "Status") ?? "?"}`);
    sections[SECTION] = specContract({
      specsDir: settings.specsDir,
      today: today(),
      next: nextSpecNumber(specsAbs(ctx)),
      language: settings.language,
      template: template(ctx),
      specs,
      current: state.spec,
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    if (state.mode === "off" || READ_TOOLS.has(event.toolName)) return;
    if (event.toolName === "bash") {
      const cmd = String(event.input.command ?? "");
      if (isReadOnlyCommand(cmd)) return;
      return { block: true, reason: `Spec mode: only read-only shell commands are allowed. Change spec files with write/edit.` };
    }
    if (event.toolName === "write" || event.toolName === "edit") {
      const p = String(event.input.path ?? "");
      if (!isInside(settings.specsDir, ctx.cwd, p))
        return { block: true, reason: `Spec mode: files can be created or edited only inside ${settings.specsDir}/.` };
      const abs = resolve(ctx.cwd, p);
      // A file named `-o` would turn a shell glob like `sort *` into a flag the bash allowlist never saw.
      // Only the part under the specs folder is checked: the project's own path may contain a `-folder`.
      if (relative(specsAbs(ctx), abs).split(/[\\/]/).some((s) => s.startsWith("-")))
        return { block: true, reason: `Spec mode: file and folder names cannot start with "-".` };
      // /spec agree checks a spec against the template: the agent must not be able to weaken it. Lower-cased: macOS and Windows ignore case.
      if (abs.toLowerCase() === localTemplate(ctx).toLowerCase())
        return { block: true, reason: `Spec mode: ${rel(ctx, abs)} is the user's template and cannot be changed in spec mode. Ask the user to edit it.` };
      // pi rewrites `@x`, `~/x`, `file://…` and (on Windows) `/c/x` before writing: give it the absolute path that was just checked.
      event.input.path = abs;
      beforeEdit.set(event.toolCallId, existsSync(abs) ? readFileSync(abs, "utf8") : "");
      return;
    }
    return { block: true, reason: `Spec mode: the ${event.toolName} tool is not available. Leave spec mode (/spec exit) to use it.` };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (state.mode === "off" || (event.toolName !== "write" && event.toolName !== "edit")) return;
    const before = beforeEdit.get(event.toolCallId) ?? "";
    beforeEdit.delete(event.toolCallId);
    if (event.isError) return;
    const p = rel(ctx, String(event.input.path ?? ""));
    if (!SPEC_FILE.test(basename(p)) || !isInside(settings.specsDir, ctx.cwd, p)) return;
    const abs = resolve(ctx.cwd, p);
    let md = readFileSync(abs, "utf8");
    // Refused wins over the "back to Draft" rules below.
    if (getField(md, "Status") === "Refused") return sweep(ctx);
    const wasAgreed = getField(before, "Status") === "Agreed";
    const isAgreed = getField(md, "Status") === "Agreed";
    // A verify run stamps `Last verified` on an Agreed spec: that alone is not a change.
    const unstamped = (s: string) => setField(s, "Last verified", "");
    // Rule 1: only /spec agree makes a spec Agreed.
    const selfAgreed = isAgreed && !wasAgreed;
    // Rule 2: a changed Agreed spec must be agreed again. A verify run may still move it to another status (Implemented).
    const changed = wasAgreed && (state.mode === "spec" || (isAgreed && unstamped(before) !== unstamped(md)));
    if (selfAgreed || changed) {
      md = setField(md, "Status", "Draft");
      // From the Version before the edit: an edit that already bumped it is not bumped twice.
      if (wasAgreed) md = setField(md, "Version", String((Number(getField(before, "Version")) || 1) + 1));
      writeFileSync(abs, md);
      notify(ctx, selfAgreed ? `${basename(p).slice(0, 4)}: only /spec agree can set a spec to Agreed, back to Draft` : `${basename(p).slice(0, 4)} changed: back to Draft, agree it again when ready`);
    }
    if (state.mode === "spec" && state.spec !== p) save(ctx, { ...state, spec: p });
    else refresh(ctx);
  });

  pi.registerTool({
    name: "spec_question",
    label: "Spec question",
    description: "Ask the user 1-4 decisions while writing or verifying a spec in spec mode. Each question has 2-4 options, most likely first.",
    promptSnippet: "Ask the user spec decisions as option menus (spec mode only)",
    promptGuidelines: ["Use spec_question only in spec mode, only for real decisions the project cannot answer."],
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String(),
          options: Type.Array(Type.Object({ title: Type.String(), description: Type.String() }), { minItems: 2, maxItems: 4 }),
        }),
        { minItems: 1, maxItems: 4 },
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (state.mode === "off") throw new Error("spec_question works only in spec mode.");
      if (!ctx.hasUI) throw new Error("No interactive UI: ask these questions in plain text and stop.");
      const answers: string[] = [];
      for (const q of params.questions) {
        const labels = q.options.map((o) => `${o.title} — ${o.description}`);
        const other = "Other (type my own answer)";
        const pick = await ctx.ui.select(q.question, [...labels, other]);
        const answer = pick === other ? await ctx.ui.input(q.question, "") : q.options[labels.indexOf(pick ?? "")]?.title;
        answers.push(`Q: ${q.question}\nA: ${answer?.trim() || "(no answer — the user dismissed the question)"}`);
      }
      return { content: [{ type: "text", text: answers.join("\n\n") }], details: {} };
    },
  });

  pi.registerTool({
    name: "spec_complete",
    label: "Spec complete",
    description: "Signal that the spec being written in spec mode is complete, every question answered. The user then decides to agree it.",
    promptSnippet: "Mark the spec being written as complete (spec mode only)",
    promptGuidelines: ["Call spec_complete only in spec mode, once the spec file is written and complete, then stop."],
    parameters: Type.Object({ path: Type.String({ description: "Path of the spec file" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (state.mode !== "spec") throw new Error("spec_complete works only in spec mode.");
      const p = rel(ctx, params.path);
      if (!isInside(settings.specsDir, ctx.cwd, p) || !SPEC_FILE.test(basename(p)) || !existsSync(resolve(ctx.cwd, p)))
        throw new Error(`${p} is not a spec file in ${settings.specsDir}/.`);
      save(ctx, { ...state, spec: p });
      completeRequested = true;
      return { content: [{ type: "text", text: "Recorded. Stop now: the user decides whether to agree the spec." }], details: {} };
    },
  });

  pi.on("agent_settled", async (_e, ctx) => {
    if (state.mode === "verify") {
      save(ctx, { mode: state.before ?? "off", spec: state.spec });
      return;
    }
    if (!completeRequested || state.mode !== "spec" || !state.spec) return;
    completeRequested = false;
    if (!ctx.hasUI) return;
    const pick = await ctx.ui.select(`Spec ${state.spec} (${specStatus(ctx, state.spec) ?? "?"}) — what next?`, [
      "Agree",
      "Keep discussing",
      "Leave spec mode",
    ]);
    if (pick === "Agree") agree(ctx);
    else if (pick === "Leave spec mode") exit(ctx);
  });
}
