// Pure helpers: no pi imports, so `node --test` can load them directly.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

// `i`: on a case-insensitive disk (macOS, Windows) `x.MD` is the same file as `x.md`.
export const SPEC_FILE = /^(\d{4})_spec_(.+)\.md$/i;

/** Refused specs (in `Refused/`) are left out unless asked for: only numbering needs them. */
export function listSpecs(specsDir: string, withRefused = false): string[] {
  const out: string[] = [];
  for (const dir of [specsDir, join(specsDir, "Implemented"), ...(withRefused ? [join(specsDir, "Refused")] : [])]) {
    if (!existsSync(dir)) continue;
    // A linked spec is skipped: reading, refusing or moving it would write to the link's target, outside the specs folder.
    for (const f of readdirSync(dir)) if (SPEC_FILE.test(f) && !lstatSync(join(dir, f)).isSymbolicLink()) out.push(join(dir, f));
  }
  return out.sort();
}

export function nextSpecNumber(specsDir: string): string {
  const max = listSpecs(specsDir, true).reduce((m, p) => Math.max(m, Number(basename(p).slice(0, 4))), 0);
  return String(max + 1).padStart(4, "0");
}

/** Accepts `NNNN`, `NNNN_spec_xxx.md`, `spec_xxx.md`, `xxx`. */
export function resolveSpec(specsDir: string, arg: string, withRefused = false): string | undefined {
  const a = arg.trim().replace(/\.md$/, "").replace(/^spec_/, "");
  if (!a) return undefined;
  return listSpecs(specsDir, withRefused).find((p) => {
    const m = SPEC_FILE.exec(basename(p))!;
    return a === m[1] || a === `${m[1]}_spec_${m[2]}` || a === m[2] || (/^\d{1,4}$/.test(a) && Number(a) === Number(m[1]));
  });
}

const rowRe = (field: string) => new RegExp(`^\\|\\s*${field}\\s*\\|([^|\\n]*)\\|`, "m");

export function getField(md: string, field: string): string | undefined {
  return rowRe(field).exec(md)?.[1].trim();
}

export function setField(md: string, field: string, value: string): string {
  return md.replace(rowRe(field), `| ${field} | ${value} |`);
}

/** Template lines a finished spec must not contain: `<placeholders>`, italic hints and the copy instructions. */
export function leftovers(spec: string, template: string): string[] {
  const found = new Set<string>();
  // Placeholders from the copy instructions (`> ...` lines) are examples like `<feature>`, not slots to fill.
  const body = template.split("\n").filter((l) => !l.startsWith(">")).join("\n");
  for (const ph of body.match(/<[^>\n]+>/g) ?? []) if (spec.includes(ph)) found.add(`placeholder ${ph}`);
  for (const line of template.split("\n")) {
    const l = line.trim();
    if ((/^\*[^*\s]/.test(l) || l.startsWith("> ")) && l.length > 12 && spec.includes(l)) found.add(`template hint "${l.slice(0, 50)}…"`);
  }
  return [...found];
}

export function missingSections(spec: string, template: string): string[] {
  const heads = (md: string) => md.split("\n").filter((l) => /^## /.test(l)).map((l) => l.trim());
  const have = new Set(heads(spec));
  return heads(template).filter((h) => !have.has(h));
}

/** "Title: goal" from a spec's H1 and the first line of its Goal section (if the template has one), capped at 200 chars. */
export function specSummary(md: string): string {
  const title = /^# (?:\d{4} Spec: )?(.+)$/m.exec(md)?.[1].trim() ?? "";
  const goal = /^## (?:\d+\.\s*)?Goal\b.*\n+([^#\n][^\n]*)/im.exec(md)?.[1].trim() ?? "";
  return [title, goal].filter(Boolean).join(": ").slice(0, 200);
}

/** `## ` sections with nothing under them: a section that does not apply says so ("None"). */
export function emptySections(spec: string): string[] {
  return spec.split(/^(?=## )/m)
    .map((s) => s.split("\n"))
    .filter(([head, ...body]) => head.startsWith("## ") && !body.join("\n").trim())
    .map(([head]) => head.trim());
}

/** The `count` specs verified longest ago: empty date first, ties by path. Empty array when all are already today. */
export function verifyQueue(specsDir: string, today: string, count = 2): string[] {
  const rows = listSpecs(specsDir).map((p) => ({ p, d: getField(readFileSync(p, "utf8"), "Last verified") ?? "" }));
  rows.sort((a, b) => a.d.localeCompare(b.d) || a.p.localeCompare(b.p));
  const pick = rows.slice(0, count);
  return pick.every((r) => r.d === today) ? [] : pick.map((r) => r.p);
}

/** Every spec, Refused/ included, by number: what /spec list and the picker show. */
function specRows(specsDir: string) {
  return listSpecs(specsDir, true)
    .sort((a, b) => basename(a).localeCompare(basename(b)))
    .map((p) => {
      const md = readFileSync(p, "utf8");
      const [, num, name] = SPEC_FILE.exec(basename(p))!;
      const dir = basename(dirname(p));
      const folder: SpecChoice["folder"] = dir === "Implemented" || dir === "Refused" ? dir : "";
      return { num, name, status: getField(md, "Status") || "?", folder, verified: getField(md, "Last verified") || "" };
    });
}

/** One line per spec, Refused/ included: number, Status, Last verified with its age, name. */
export function specTable(specsDir: string, today: string): string[] {
  return specRows(specsDir).map(({ num, name, status, verified: d }) => {
    const age = /^\d{4}-\d{2}-\d{2}$/.test(d) ? ` (${Math.max(0, Math.round((Date.parse(today) - Date.parse(d)) / 864e5))} d ago)` : "";
    const verified = d ? `verified ${d}${age}` : "never verified";
    return `${num}  ${status.padEnd(11)}  ${verified.padEnd(32)}  ${name}`;
  });
}

export interface SpecChoice {
  num: string;
  status: string;
  folder: "" | "Implemented" | "Refused";
  label: string; // what the picker shows
  arg: string; // what the command accepts: the number, which is unique
}

/** One picker entry per spec, Refused/ included: `0001 · Agreed · login`. */
export function specChoices(specsDir: string): SpecChoice[] {
  return specRows(specsDir).map(({ num, name, status, folder }) => ({ num, status, folder, label: `${num} · ${status} · ${name}`, arg: num }));
}

/** Spec picker cursor after ↑ or ↓: both wrap around, ↑ on the first spec to the last and ↓ on the last to the first. */
export function pickerMove(at: number, count: number, key: "up" | "down"): number {
  return (at + (key === "up" ? count - 1 : 1)) % count;
}

export const REFUSED_BANNER = (date: string) =>
  `> **REFUSED on ${date}: ignore this spec.** Kept for reference only; it is not a requirement: do not implement, verify or extend it.`;

/** Sets Status to Refused, puts the banner on top and moves the spec to `Refused/`. Returns the new path. */
export function refuseSpec(specsDir: string, path: string, date: string): string {
  const dest = join(specsDir, "Refused", basename(path));
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  mkdirSync(join(specsDir, "Refused"), { recursive: true });
  const md = setField(stripBanner(readFileSync(path, "utf8")), "Status", "Refused");
  writeFileSync(path, `${REFUSED_BANNER(date)}\n\n${md}`);
  renameSync(path, dest);
  return dest;
}

const stripBanner = (md: string) => md.replace(/^> \*\*REFUSED on [^\n]*\n\n?/, "");

/** Undoes refuseSpec: back to the specs folder as Draft, to be agreed again. Returns the new path. */
export function restoreSpec(specsDir: string, path: string): string {
  const dest = join(specsDir, basename(path));
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  writeFileSync(path, setField(stripBanner(readFileSync(path, "utf8")), "Status", "Draft"));
  renameSync(path, dest);
  return dest;
}

/** Moves to `Refused/` the specs whose Status was set to Refused by hand (or by the agent). Returns the new paths. */
export function sweepRefused(specsDir: string, date: string): string[] {
  return listSpecs(specsDir)
    .filter((p) => getField(readFileSync(p, "utf8"), "Status") === "Refused")
    .map((p) => refuseSpec(specsDir, p, date));
}

export function isInside(dir: string, cwd: string, p: string): boolean {
  const rel = relative(resolve(cwd, dir), resolve(cwd, p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Why a settings value is refused, or undefined when it is valid. Shared by the settings files and `/spec settings`. */
export function settingError(key: string, value: unknown, cwd: string): string | undefined {
  switch (key) {
    // The specs folder is the only place spec mode may write: never let a setting point it outside the project.
    // A folder not created yet is fine (no spec written yet); an existing file is not.
    case "specsDir":
      return typeof value !== "string" || !isInside(".", cwd, value) || statSync(resolve(cwd, value), { throwIfNoEntry: false })?.isDirectory() === false
        ? "specsDir must be a folder inside the project" : undefined;
    case "language":
      return typeof value !== "string" || !value.trim() ? "language must be a non-empty string" : undefined;
    case "verifyCount":
      return !Number.isInteger(value) || (value as number) < 1 ? "verifyCount must be a positive integer" : undefined;
    case "renameSession":
    case "renamePlanSession":
      return typeof value !== "boolean" ? `${key} must be true or false` : undefined;
  }
  return `unknown setting ${key}`;
}

/** A settings file's text with one key set, other keys kept. Throws on a file that is not a JSON object rather than overwrite it. */
export function withSetting(text: string | undefined, key: string, value: unknown): string {
  const obj = text?.trim() ? JSON.parse(text) : {};
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new Error("not a JSON object");
  return `${JSON.stringify({ ...obj, [key]: value }, null, 2)}\n`;
}

const NONE = /(?!)/;
/** Allowlist: the commands spec mode may run and the flags each accepts. Other arguments are files, patterns or flag values. */
const FLAGS: Record<string, RegExp> = {
  cat: /^-[nb]$/, head: /^-[nc]?\d*$/, tail: /^-[nc]?\d*$/, ls: /^-[alhRtrSd1AF]+$/, wc: /^-[lwcm]+$/,
  grep: /^-[rRnilvwcEFhHoqsABC\d]+$|^--(include|exclude|exclude-dir)=/, rg: /^-[nilvwcFSoltgABC\d]+$|^--(type|glob|files|hidden)(=|$)/,
  find: /^-(name|iname|path|ipath|type|maxdepth|mindepth|newer|size|mtime|empty|not|o|a|or|and|print)$/,
  fd: /^-[eHItd]$|^--(extension|hidden|type|max-depth)(=|$)/, tree: /^-[Ldaf]$|^-L\d+$/,
  sort: /^-[nrufk\d,]+$/, uniq: /^-[cdui]+$/, cut: /^-[dfcs]/, tr: /^-[dcs]+$/, diff: /^-[uqrNwb]+$/,
  stat: /^-[fcLx]/, du: /^-[shdac\d]+$/, file: /^-[biL]+$/, jq: /^-[rcSe]+$/, echo: /^-[neE]+$/, date: /^-u$/,
  which: /^-a$/, pwd: /^-[LP]$/, cd: /^-[LP]$/, sed: NONE, printf: NONE, basename: NONE, dirname: NONE, realpath: NONE, true: NONE,
  "rtk read": /^--(head|tail)-lines(=\d+)?$/, // what rtk turns cat/head into
};
const GIT_READ = new Set(["status", "log", "diff", "show", "blame", "grep", "ls-files", "rev-parse", "branch"]);
const GIT_FLAGS = /^-\d+$|^-[nplsiwLb]$|^--(oneline|stat|name-only|name-status|graph|all|short|porcelain|cached|staged|abbrev-ref|show-toplevel)$|^--(format|pretty|since|until|author|grep)=/;

/** Fail-closed: every command of a pipeline/list must be on the allowlist with allowed flags; no redirection (except to /dev/null), substitution or expansion. */
export function isReadOnlyCommand(cmd: string): boolean {
  cmd = cmd.replace(/[0-9&]?>>?\s*\/dev\/null(?=[\s|;&)]|$)|[0-9]>&[0-9]+(?=[\s|;&)]|$)/g, ""); // the lookaheads refuse `>/dev/nullx` and `2>&1x`
  if (/[>`]|<\(/.test(cmd)) return false;
  // Expansions can produce a flag the check never saw: `$(…)`, `${X:--o}`, `$'\x2do'`, `$_`, `$IFS` splitting, `{-o,out}`.
  // Single quotes stop `$` only if each `'` is a real quote: a `'` inside "…", after `\`, in a comment or a heredoc is text.
  const unquoted = /["\\#]|<</.test(cmd) ? cmd : cmd.replace(/'[^']*'/g, "''");
  // `$@`, `$*`, `$1`… can expand to a glob like `*` (see below).
  if (/\$[A-Za-z_{('"@*!0-9]/.test(unquoted) || /\{[^}]*(,|\.\.)[^}]*\}/.test(cmd)) return false;
  return cmd.split(/\|\||&&|[|;\n&]/).every((part) => {
    const w = part.trim().split(/\s+/);
    // A leading glob can expand to a file named like a flag (`sort *` with a `-o` file is `sort -o …`): `./*` cannot.
    if (w.some((a) => /^[*?[]/.test(a.replace(/''|""/g, "")))) return false;
    // rtk's pi extension rewrites commands to `rtk <cmd>` before spec mode sees them
    const rtk = w[0] === "rtk";
    if (rtk) w.splice(0, w[1] === "proxy" ? 2 : 1);
    if (w[0] === "") return true;
    const key = rtk && w[0] === "read" ? "rtk read" : w[0];
    // Own keys only: `constructor` or `toString` are on every object.
    let flags = Object.hasOwn(FLAGS, key) ? FLAGS[key] : undefined;
    let args = w.slice(1);
    if (w[0] === "git") {
      if (!GIT_READ.has(w[1]) || (w[1] === "branch" && w.length > 2)) return false;
      [flags, args] = [GIT_FLAGS, w.slice(2)];
    }
    // sed scripts can write (`w`) or run commands (`e`): only `sed -n '<lines>p' files`.
    if (w[0] === "sed") {
      if (w[1] !== "-n" || !/^(['"]?)[\d,$]+p\1$/.test(w[2] ?? "")) return false;
      args = w.slice(3);
    }
    // Quotes and backslashes do not hide a flag: `"-o"` and `\-o` reach the command as `-o`.
    const bare = args.map((a) => a.replace(/['"\\]/g, ""));
    // uniq's second file is its output.
    if (w[0] === "uniq" && bare.filter((a) => !a.startsWith("-")).length > 1) return false;
    return !!flags && bare.every((a) => !a.startsWith("-") || flags.test(a));
  });
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
