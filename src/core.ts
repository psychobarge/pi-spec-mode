// Pure helpers: no pi imports, so `node --test` can load them directly.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export const SPEC_FILE = /^(\d{4})_spec_(.+)\.md$/;

/** Refused specs (in `Refused/`) are left out unless asked for: only numbering needs them. */
export function listSpecs(specsDir: string, withRefused = false): string[] {
  const out: string[] = [];
  for (const dir of [specsDir, join(specsDir, "Implemented"), ...(withRefused ? [join(specsDir, "Refused")] : [])]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (SPEC_FILE.test(f)) out.push(join(dir, f));
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

/** The `count` specs verified longest ago: empty date first, ties by path. Empty array when all are already today. */
export function verifyQueue(specsDir: string, today: string, count = 2): string[] {
  const rows = listSpecs(specsDir).map((p) => ({ p, d: getField(readFileSync(p, "utf8"), "Last verified") ?? "" }));
  rows.sort((a, b) => a.d.localeCompare(b.d) || a.p.localeCompare(b.p));
  const pick = rows.slice(0, count);
  return pick.every((r) => r.d === today) ? [] : pick.map((r) => r.p);
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

const READ_ONLY = new Set([
  "cat", "head", "tail", "less", "grep", "rg", "find", "fd", "ls", "pwd", "echo", "printf", "wc", "sort", "uniq",
  "diff", "file", "stat", "du", "tree", "which", "date", "basename", "dirname", "realpath", "cut", "tr", "jq", "awk", "sed", "true",
  "cd", "read", // `read` is what rtk turns cat/head into
]);
const GIT_READ = new Set(["status", "log", "diff", "show", "blame", "grep", "ls-files", "rev-parse", "branch"]);

/** Fail-closed: every command of a pipeline/list must be a known reader; no redirection (except to /dev/null) or substitution. */
export function isReadOnlyCommand(cmd: string): boolean {
  cmd = cmd.replace(/[0-9&]?>>?\s*\/dev\/null|[0-9]>&[0-9]/g, "");
  if (/[>`]|\$\(|<\(/.test(cmd)) return false;
  return cmd.split(/\|\||&&|[|;\n&]/).every((part) => {
    const w = part.trim().split(/\s+/);
    // rtk's pi extension rewrites commands to `rtk <cmd>` before spec mode sees them
    if (w[0] === "rtk") w.splice(0, w[1] === "proxy" ? 2 : 1);
    if (w[0] === "") return true;
    // Flags that write a file (--output, -o) or run a command (-O pager, --pre, --exec) turn a reader into a writer.
    if (w[0] === "git") return GIT_READ.has(w[1]) && !(w[1] === "branch" && w.length > 2) && !w.some((x) => /^(--output|-O|--open-files-in-pager)/.test(x));
    if (!READ_ONLY.has(w[0])) return false;
    // sed scripts can write (`w`) or run commands (`e`) anywhere in them: allow only line printing.
    if (w[0] === "sed" && !/^sed -n (['"]?)[\d,$]+p\1( |$)/.test(w.join(" "))) return false;
    if ((w[0] === "sort" || w[0] === "tree") && w.some((x) => /^(-[a-zA-Z]*o|--output)/.test(x))) return false;
    if (w[0] === "rg" && w.some((x) => /^--pre(=|$)/.test(x))) return false;
    if ((w[0] === "find" || w[0] === "fd") && w.some((x) => /^(-(exec|execdir|delete|ok|fprint|fls)|--exec)/.test(x) || x === "-x" || x === "-X")) return false;
    if (w[0] === "awk" && /system|print\s*>|\|/.test(part)) return false;
    return true;
  });
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
