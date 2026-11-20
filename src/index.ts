import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, ExtensionSelectorComponent, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  emptySections, getField, isInside, isReadOnlyCommand, leftovers, listSpecs, missingSections,
  nextSpecNumber, pickerMove, refuseSpec, resolveSpec, restoreSpec, SPEC_FILE, setField, settingError, specChoices, type SpecChoice, specSummary, specTable, sweepRefused, today, verifyQueue, withSetting,
} from "./core.ts";
import { implementRequest, NORMAL_CONTRACT, specContract, templateRequest, verifyContract } from "./prompts.ts";

type Mode = "off" | "spec" | "verify";
interface State {
  mode: Mode;
  spec?: string; // project-relative path of the spec being written
  before?: "off" | "spec"; // mode to return to after a verify run
  targets?: string[];
  drafts?: string[]; // specs this verify run put back to Draft: offered for a new agreement when it ends
}
interface Settings {
  specsDir: string;
  language: string;
  verifyCount: number;
  renameSession: boolean;
  renamePlanSession: boolean;
}

const STATE_ENTRY = "spec-mode";
const SECTION = "spec-mode";
const MUTEX = "workflow:mutex:v1"; // shared with @narumitw/pi-plan-mode: only one agent workflow at a time
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "spec_question", "spec_complete"]);
const BUNDLED_TEMPLATE = fileURLToPath(new URL("../templates/spec_template.md", import.meta.url));
const USAGE = "/spec start | <request> | list | agree [spec] | refuse [spec] | restore <spec> | verify [spec] | implement <spec> | template | exit | settings";
/** `/spec` menu detail shown after the command word, so the menu reads like the completion. */
const MENU_DETAIL: Record<string, string> = {
  start: "enter spec mode", verify: "check specs against the code", implement: "hand a spec to plan mode",
  restore: "a refused spec", template: "create the project template", exit: "leave spec mode",
};
const DEFAULT_SETTINGS: Settings = { specsDir: "specs", language: "English", verifyCount: 2, renameSession: false, renamePlanSession: false };
/** Menu action → what to say when its picker has nothing to offer. */
const PICKER_EMPTY: Record<string, string> = {
  implement: "No Agreed spec to implement: agree one first (/spec agree).",
  restore: "No refused spec to restore.",
  agree: "No Draft spec to agree.",
  refuse: "No spec to refuse.",
};

export default function specMode(pi: ExtensionAPI) {
  let state: State = { mode: "off" };
  let settings = DEFAULT_SETTINGS;
  let session: object | undefined;
  let completeRequested = false;
  let templateRun = false; // the agent may rewrite specs/spec_template.md during an explicit `/spec template` run
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
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const err = settingError(key, s[key], ctx.cwd);
      if (err) {
        notify(ctx, `pi-spec-mode: ${err}, using ${JSON.stringify(DEFAULT_SETTINGS[key])}`, "warning");
        s = { ...s, [key]: DEFAULT_SETTINGS[key] };
      }
    }
    return s;
  }

  const noSpec = (arg: string) => `No spec "${arg}" in ${settings.specsDir}/ or ${settings.specsDir}/Implemented/`;

  const localTemplate = (ctx: ExtensionContext) => join(specsAbs(ctx), "spec_template.md");

  function template(ctx: ExtensionContext): string {
    return readFileSync(existsSync(localTemplate(ctx)) ? localTemplate(ctx) : BUNDLED_TEMPLATE, "utf8");
  }

  /** Creates the project template: the agent adapts it to the project, or a plain copy when the user prefers. */
  async function createTemplate(ctx: ExtensionContext) {
    const dest = localTemplate(ctx);
    if (existsSync(dest)) return notify(ctx, `${rel(ctx, dest)} already exists: edit it, or ask the agent to adapt it.`, "warning");
    let adapt = false; // no interactive UI: nothing to ask, the copy is all that can be done
    if (ctx.hasUI) {
      const path = rel(ctx, dest);
      adapt = await ctx.ui.confirm(
        "Create the project template?",
        `${path} is created from the generic template, then the agent reads the project (type, stack, domain) and rewrites it for this project. Reread the result: /spec agree checks every spec against it.`,
      );
      if (!adapt && !(await ctx.ui.confirm("Copy the generic template anyway?", `${path} is created from the generic template, unchanged: you adapt it by hand.`)))
        return notify(ctx, "Nothing created.");
    }
    mkdirSync(specsAbs(ctx), { recursive: true });
    writeFileSync(dest, readFileSync(BUNDLED_TEMPLATE, "utf8"));
    if (!adapt) return notify(ctx, `Copied the generic template to ${rel(ctx, dest)}: adapt it by hand, /spec agree checks every spec against it.`);
    templateRun = true;
    pi.sendUserMessage(templateRequest(rel(ctx, dest), settings.specsDir));
    notify(ctx, `Created ${rel(ctx, dest)}: the agent adapts it to the project now — reread it carefully, /spec agree checks every spec against it.`);
  }

  function specStatus(ctx: ExtensionContext, p: string): string | undefined {
    const abs = resolve(ctx.cwd, p);
    return existsSync(abs) ? getField(readFileSync(abs, "utf8"), "Status") : undefined;
  }

  /** pi's selector, except ↑ and ↓ wrap around the list; plain select outside the terminal UI. */
  function pickSpec(ctx: ExtensionContext, title: string, labels: string[]): Promise<string | undefined> {
    if (ctx.mode !== "tui") return ctx.ui.select(title, labels);
    return ctx.ui.custom<string | undefined>((tui, _theme, kb, done) => {
      const list = new ExtensionSelectorComponent(title, labels, done, () => done(undefined), { tui });
      const forward = list.handleInput.bind(list);
      let at = 0; // the selector's cursor is private: track it to know when a move must wrap
      list.handleInput = (key: string) => {
        const move = kb.matches(key, "tui.select.up") || key === "k" ? "up" : kb.matches(key, "tui.select.down") || key === "j" ? "down" : undefined;
        // The selector clamps at both ends: walk it to the other end instead.
        if (move === "up" && at === 0) for (let i = 1; i < labels.length; i++) forward("j");
        else if (move === "down" && at === labels.length - 1) for (let i = 1; i < labels.length; i++) forward("k");
        else forward(key);
        if (move) at = pickerMove(at, labels.length, move);
      };
      return list;
    });
  }

  /** What a menu action may act on: only an Agreed spec can be implemented, only a Refused/ one restored. */
  function specPicker(ctx: ExtensionContext, sub: string): SpecChoice[] {
    const all = specChoices(specsAbs(ctx));
    if (sub === "implement") return all.filter((c) => c.status === "Agreed");
    if (sub === "restore") return all.filter((c) => c.folder === "Refused");
    if (sub === "agree") return all.filter((c) => c.folder === "" && c.status === "Draft");
    return all.filter((c) => c.folder === ""); // refuse resolves only in the specs folder
  }

  function refresh(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    let text: string | undefined;
    if (state.mode === "verify") text = "✎ spec-mode verify";
    else if (state.mode === "spec") {
      const status = state.spec && specStatus(ctx, state.spec);
      text = status ? `✎ spec-mode ${basename(state.spec!).slice(0, 4)} · ${status}` : "✎ spec-mode";
    }
    // mdLink is the blue of the built-in themes; accent is violet and reads as plan mode
    ctx.ui.setStatus("spec-mode", text && ctx.ui.theme.fg("mdLink", text));
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

  /** Checks a spec against the template and sets it to Agreed: returns the problems found, and writes nothing when there are any. */
  function agreeFile(ctx: ExtensionContext, p: string): string[] {
    const md = readFileSync(p, "utf8");
    const tpl = template(ctx);
    const problems = [...missingSections(md, tpl).map((h) => `missing section "${h}"`), ...emptySections(md).map((h) => `empty section "${h}": write "None" if nothing applies`), ...leftovers(md, tpl)];
    if (getField(md, "Status") === undefined) problems.push(`missing header row "Status"`); // setField would silently do nothing
    if (!problems.length) writeFileSync(p, setField(md, "Status", "Agreed"));
    return problems;
  }

  /** Agrees the spec shown in the footer, or the one named: `/spec agree 0003` re-agrees a Draft spec later. */
  function agree(ctx: ExtensionContext, arg = "") {
    if (state.mode === "verify") return notify(ctx, "A spec verify run is in progress: agree when it ends.", "warning");
    let p: string | undefined;
    if (arg.trim()) {
      p = resolveSpec(specsAbs(ctx), arg);
      if (!p) return notify(ctx, noSpec(arg), "warning");
      if (basename(dirname(p)) === "Implemented") return notify(ctx, `${rel(ctx, p)} is already implemented.`, "warning");
    } else {
      if (state.mode !== "spec") return notify(ctx, "Spec mode is not on: /spec agree works on the spec being written, /spec agree <spec> on an existing Draft one.", "warning");
      p = state.spec && resolve(ctx.cwd, state.spec);
      if (!p || !existsSync(p)) return notify(ctx, "No spec written yet in this spec mode session.", "warning");
    }
    const problems = agreeFile(ctx, p);
    if (problems.length) return notify(ctx, `Cannot agree ${rel(ctx, p)}:\n- ${problems.join("\n- ")}`, "error");
    const done = `${basename(p).slice(0, 4)} agreed`;
    // Agreeing the spec in progress closes the session; one agreed on the side leaves it running.
    if (state.mode === "spec" && state.spec && resolve(ctx.cwd, state.spec) === p) return exit(ctx, done);
    notify(ctx, done);
  }

  /** Ends a verify run: each spec it sent back to Draft is offered for a fresh agreement, one question per spec. */
  async function reagreeAll(ctx: ExtensionContext, drafts: string[]) {
    const still = drafts.filter((p) => existsSync(resolve(ctx.cwd, p)) && specStatus(ctx, p) === "Draft");
    if (!still.length) return;
    if (!ctx.hasUI) return notify(ctx, `Changed during verify, back to Draft: ${still.map((p) => basename(p).slice(0, 4)).join(", ")}. Agree again with /spec agree <number>.`, "warning");
    for (const p of still) {
      const pick = await ctx.ui.select(`${rel(ctx, p)} changed during verify, back to Draft — agree it again?`, ["Agree again", "Keep Draft"]);
      if (pick !== "Agree again") continue;
      const problems = agreeFile(ctx, resolve(ctx.cwd, p));
      if (problems.length) notify(ctx, `Cannot agree ${rel(ctx, p)}:\n- ${problems.join("\n- ")}`, "error");
      else notify(ctx, `${basename(p).slice(0, 4)} agreed again`);
    }
  }

  /** Puts the session in a verify run; the caller sends the message that starts it. */
  function startVerify(ctx: ExtensionContext, arg = ""): boolean {
    if (state.mode === "verify") return notify(ctx, "A verify run is already in progress.", "warning"), false;
    sweep(ctx);
    if (!listSpecs(specsAbs(ctx)).length) return notify(ctx, `No specs in ${settings.specsDir}/ to verify.`), false;
    // A named spec is verified even if already verified today: the user asked for it.
    const one = arg && resolveSpec(specsAbs(ctx), arg);
    if (arg && !one) return notify(ctx, noSpec(arg), "warning"), false;
    const targets = one ? [one] : verifyQueue(specsAbs(ctx), today(), settings.verifyCount);
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
    if (!p) return notify(ctx, noSpec(arg), "warning");
    // An extended spec in Implemented/ is Agreed again: the Status check alone decides.
    const status = getField(readFileSync(p, "utf8"), "Status");
    if (status !== "Agreed") return notify(ctx, `${rel(ctx, p)} is ${status ?? "not Agreed"}: agree it first (/spec agree).`, "warning");
    if (!ctx.isIdle()) return notify(ctx, "The agent is running: wait or interrupt, then retry.", "warning");
    if (state.mode !== "off") exit(ctx, "Spec mode off — handing over to plan mode");
    const line = `/${plan.name} ${implementRequest(rel(ctx, p), settings.specsDir)}`;
    if (settings.renamePlanSession) pi.setSessionName(`spec ${basename(p).slice(0, 4)} planning`);
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
    const msg = `${basename(p).slice(0, 4)} refused, moved to ${rel(ctx, dest)}`;
    // Refusing the spec being written ends the session: nothing is left to write.
    if (state.mode !== "off" && state.spec && resolve(ctx.cwd, state.spec) === p) return exit(ctx, `${msg} — spec mode off`);
    notify(ctx, msg);
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

  /** A spec set to Refused by hand or by the agent is moved like /spec refuse would; true when that ended spec mode. */
  function sweep(ctx: ExtensionContext): boolean {
    let left = false;
    try {
      for (const p of sweepRefused(specsAbs(ctx), today())) {
        const msg = `${basename(p).slice(0, 4)} is Refused: moved to ${rel(ctx, p)}`;
        // Same rule as /spec refuse: the spec being written refused by hand also ends spec mode.
        if (state.mode !== "off" && state.spec && basename(state.spec) === basename(p)) {
          exit(ctx, `${msg} — spec mode off`);
          left = true;
        } else notify(ctx, msg);
      }
    } catch (e) {
      notify(ctx, `pi-spec-mode: could not move a refused spec: ${(e as Error).message}`, "warning");
    }
    return left;
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

  /** `/spec settings` with a UI: pick a setting, type its value, pick the file it goes to; Escape leaves. */
  async function editSettings(ctx: ExtensionContext) {
    showSettings(ctx);
    if (!ctx.hasUI) return;
    const keys = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
    for (;;) {
      const labels = keys.map((k) => `${k}: ${JSON.stringify(settings[k])}`);
      const key = keys[labels.indexOf((await ctx.ui.select("pi-spec-mode settings", labels)) ?? "")];
      if (!key) return;
      const raw = typeof DEFAULT_SETTINGS[key] === "boolean"
        ? await ctx.ui.select(key, ["true", "false"])
        : await ctx.ui.input(key, String(settings[key]));
      if (!raw?.trim()) continue; // an empty answer keeps the value
      const value = key === "verifyCount" ? Number(raw) : typeof DEFAULT_SETTINGS[key] === "boolean" ? raw === "true" : raw.trim();
      const err = settingError(key, value, ctx.cwd);
      if (err) {
        notify(ctx, `pi-spec-mode: ${err}, not saved`, "warning");
        continue;
      }
      const global = join(getAgentDir(), "pi-spec-mode.json");
      const project = join(ctx.cwd, ".pi", "pi-spec-mode.json");
      const where = ctx.isProjectTrusted()
        ? await ctx.ui.select(`Save ${key} in`, [`this project (${project})`, `all projects (${global})`])
        : `all projects (${global})`; // an untrusted project file would be ignored
      if (!where) continue;
      const file = where.startsWith("this") ? project : global;
      try {
        const text = withSetting(existsSync(file) ? readFileSync(file, "utf8") : undefined, key, value);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      } catch (e) {
        notify(ctx, `pi-spec-mode: ${file} left unchanged: ${(e as Error).message}`, "warning");
        continue;
      }
      settings = loadSettings(ctx);
      notify(ctx, settings[key] === value ? `${key} set to ${JSON.stringify(value)} in ${file}` : `${key} saved in ${file}, but ${project} overrides it`);
    }
  }

  pi.on("session_start", async (_e, ctx) => restore(ctx));
  pi.on("session_tree", async (_e, ctx) => restore(ctx));

  /** Subcommands the current state accepts, in menu order: the menu and the completion offer the same list. */
  function commands(): string[] {
    if (state.mode === "off") return ["start", "list", "agree", "verify", "implement", "refuse", "restore", "template", "settings"];
    if (state.mode === "spec") return [...(state.spec ? ["agree"] : []), "refuse", "list", "template", "exit", "settings"];
    return ["list", "exit", "settings"];
  }

  pi.registerCommand("spec", {
    description: `Spec mode: ${USAGE}`,
    getArgumentCompletions: (prefix) => {
      const items = commands().filter((s) => s.startsWith(prefix));
      return items.length ? items.map((value) => ({ value, label: value })) : null;
    },
    handler: async function run(args, ctx): Promise<void> {
      const [sub = "", ...restWords] = args.trim().split(/\s+/);
      const rest = restWords.join(" ");
      const idle = ctx.isIdle();
      const busy = () => notify(ctx, "The agent is running: wait or interrupt, then retry.", "warning");
      // `/spec verify that login works offline` is a request: commands without an argument only match alone.
      // `/spec verify 0003` and `/spec agree 0003` name a spec, so they are the command; a number or spec file name
      // that matches nothing is too, so a typo gets "No spec" instead of starting spec mode.
      const namesSpec = ["verify", "agree"].includes(sub) && rest !== "" && (/^\d{1,4}$|^\d{4}_spec_.+\.md$/i.test(rest) || !!resolveSpec(specsAbs(ctx), rest));
      const isRequest = rest !== "" && !namesSpec && ["start", "list", "exit", "off", "agree", "verify", "template", "settings"].includes(sub);

      switch (isRequest ? undefined : sub) {
        case "": {
          if (!ctx.hasUI) return notify(ctx, `Usage: ${USAGE}`);
          // Without a spec in progress, agree and refuse need one picked, like implement and restore.
          const entries = commands().map((sub) => {
            const current = (sub === "agree" || sub === "refuse") && !!state.spec;
            const detail = current ? "the spec in progress" : MENU_DETAIL[sub];
            return { sub, label: detail ? `${sub} (${detail})` : sub, asksSpec: ["agree", "refuse", "implement", "restore"].includes(sub) && !current };
          });
          const pick = await ctx.ui.select("Spec mode", entries.map((e) => e.label));
          const entry = entries.find((e) => e.label === pick);
          // The menu runs the same command as typing it.
          if (!entry) return;
          const menuSub = entry.sub;
          if (!entry.asksSpec) return run(menuSub, ctx);
          const choices = specPicker(ctx, menuSub);
          if (!choices.length) return notify(ctx, PICKER_EMPTY[menuSub] ?? "No spec to pick.", "warning");
          const which = await pickSpec(ctx, `${menuSub}: which spec?`, choices.map((c) => c.label));
          const arg = choices.find((c) => c.label === which)?.arg;
          return arg ? run(`${menuSub} ${arg}`, ctx) : undefined;
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
          return idle ? agree(ctx, rest) : busy();
        case "verify":
          if (!idle) return busy();
          if (startVerify(ctx, rest)) pi.sendUserMessage("Verify the specs.");
          return;
        case "implement":
          return implement(ctx, rest);
        case "refuse":
          return idle ? refuse(ctx, rest) : busy();
        case "restore":
          return idle ? restoreRefused(ctx, rest) : busy();
        case "list": {
          const rows = specTable(specsAbs(ctx), today());
          return notify(ctx, rows.length ? [`Specs in ${settings.specsDir}/:`, ...rows].join("\n") : `No spec in ${settings.specsDir}/ yet.`);
        }
        case "template":
          return idle ? createTemplate(ctx) : busy();
        case "settings":
          return editSettings(ctx);
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
    if (sweep(ctx)) return; // the sweep refused the spec being written: no spec contract this turn
    const specs = listSpecs(specsAbs(ctx)).map((p) => {
      const md = readFileSync(p, "utf8");
      return `${rel(ctx, p)} — ${getField(md, "Status") ?? "?"} — ${specSummary(md)}`;
    });
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
      // The path check is textual: a symlink under specs/ (or specs/ itself), e.g. one a cloned repo ships, would carry the write elsewhere.
      for (let d = abs; ; d = dirname(d)) {
        if (lstatSync(d, { throwIfNoEntry: false })?.isSymbolicLink())
          return { block: true, reason: `Spec mode: ${rel(ctx, d)} is a symbolic link; spec mode does not write through links.` };
        if (d === specsAbs(ctx) || d === dirname(d)) break;
      }
      // Only Markdown: a `.git/config` or `.git/HEAD` under specs/ would make `cd specs/r && git status` run the agent's commands.
      if (!/\.md$/i.test(abs))
        return { block: true, reason: `Spec mode: only Markdown files (.md) can be written in ${settings.specsDir}/.` };
      // A file named `-o` would turn a shell glob like `sort *` into a flag the bash allowlist never saw.
      // Only the part under the specs folder is checked: the project's own path may contain a `-folder`.
      if (relative(specsAbs(ctx), abs).split(/[\\/]/).some((s) => s.startsWith("-")))
        return { block: true, reason: `Spec mode: file and folder names cannot start with "-".` };
      // /spec agree checks a spec against the template: the agent must not be able to weaken it. Lower-cased: macOS and Windows ignore case.
      // The one exception is the run `/spec template` starts, which exists to rewrite it.
      if (abs.toLowerCase() === localTemplate(ctx).toLowerCase() && !templateRun)
        return { block: true, reason: `Spec mode: ${rel(ctx, abs)} is the user's template and cannot be changed in spec mode. Run /spec template to have it adapted, or edit it yourself.` };
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
    if (getField(md, "Status") === "Refused") {
      sweep(ctx);
      return;
    }
    const wasAgreed = getField(before, "Status") === "Agreed";
    let isAgreed = getField(md, "Status") === "Agreed";
    // A verify run may only move an Agreed spec to Implemented: any other status goes back to Agreed, so rule 2 below sees the change.
    if (state.mode === "verify" && wasAgreed && !isAgreed && getField(md, "Status") !== "Implemented") {
      md = setField(md, "Status", "Agreed");
      isAgreed = true;
      writeFileSync(abs, md);
    }
    // A verify run stamps `Last verified` on an Agreed spec: that alone is not a change.
    const unstamped = (s: string) => setField(s, "Last verified", "");
    // Rule 1: only /spec agree makes a spec Agreed.
    const selfAgreed = isAgreed && !wasAgreed;
    // Rule 2: a changed Agreed spec must be agreed again. A verify run may still move it to another status (Implemented).
    const changed = wasAgreed && (state.mode === "spec" || (isAgreed && unstamped(before) !== unstamped(md)));
    if (selfAgreed || changed) {
      // A verify run fixes a spec to match the code: a self-agreed one keeps the status it had (Implemented stays Implemented).
      md = setField(md, "Status", selfAgreed && state.mode === "verify" ? getField(before, "Status") || "Draft" : "Draft");
      // From the Version before the edit: an edit that already bumped it is not bumped twice.
      if (wasAgreed) md = setField(md, "Version", String((Number(getField(before, "Version")) || 1) + 1));
      writeFileSync(abs, md);
      // Only a real change retires an Agreed spec; a run that just stamps `Last verified` keeps it Agreed and is not offered.
      if (changed && state.mode === "verify") save(ctx, { ...state, drafts: [...new Set([...(state.drafts ?? []), p])] });
      notify(ctx, selfAgreed ? `${basename(p).slice(0, 4)}: only /spec agree can set a spec to Agreed, back to ${getField(md, "Status")}` : `${basename(p).slice(0, 4)} changed: back to Draft, agree it again when ready`);
    }
    // Only the session that creates the spec is renamed: editing an existing one is not its creation.
    if (state.mode === "spec" && !before && settings.renameSession) pi.setSessionName(`spec ${basename(p).slice(0, 4)} creation`);
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
    if (templateRun) {
      templateRun = false;
      notify(ctx, `Reread ${rel(ctx, localTemplate(ctx))} before writing a spec: the agent adapted it, and /spec agree checks every spec against it.`, "warning");
    }
    if (state.mode === "verify") {
      const drafts = state.drafts ?? [];
      save(ctx, { mode: state.before ?? "off", spec: state.spec }); // a fresh object: the run's drafts do not outlive it
      await reagreeAll(ctx, drafts);
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
