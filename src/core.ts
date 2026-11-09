// Pure helpers: no pi imports, so `node --test` can load them directly.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type Intent = { kind: "create" | "verify" | "implement"; rest: string };

export interface Triggers {
  create: string[];
  verify: string[];
  implement: string[];
}

export const DEFAULT_TRIGGERS: Triggers = {
  create: [
    "write the spec", "write a spec", "create a spec", "create the spec", "new spec for",
    "crée une spec", "crée la spec", "créer une spec", "créer la spec", "écris la spec",
    "écris une spec", "rédige la spec", "rédige une spec", "nouvelle spec",
  ],
  verify: ["verify the specs", "check the specs", "vérifie les specs", "vérifier les specs"],
  implement: ["implement the spec", "implement spec", "implémente la spec", "implémenter la spec", "implémente spec"],
};

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Implement and verify are checked before create, so "implement the spec" never reads as a create. */
export function matchTrigger(text: string, triggers: Triggers): Intent | undefined {
  const folded = fold(text);
  for (const kind of ["implement", "verify", "create"] as const) {
    for (const phrase of triggers[kind]) {
      const i = folded.indexOf(fold(phrase));
      // `rest` is folded (lowercase, no accents): only used as a spec id, never shown.
      if (i !== -1) return { kind, rest: folded.slice(i + fold(phrase).length).trim() };
    }
  }
  return undefined;
}

export const SPEC_FILE = /^(\d{4})_spec_(.+)\.md$/;

export function listSpecs(specsDir: string): string[] {
  const out: string[] = [];
  for (const dir of [specsDir, join(specsDir, "Implemented")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (SPEC_FILE.test(f)) out.push(join(dir, f));
  }
  return out.sort();
}

export function nextSpecNumber(specsDir: string): string {
  const max = listSpecs(specsDir).reduce((m, p) => Math.max(m, Number(p.split("/").pop()!.slice(0, 4))), 0);
  return String(max + 1).padStart(4, "0");
}

/** Accepts `NNNN`, `NNNN_spec_xxx.md`, `spec_xxx.md`, `xxx`. */
export function resolveSpec(specsDir: string, arg: string): string | undefined {
  const a = arg.trim().replace(/\.md$/, "").replace(/^spec_/, "");
  if (!a) return undefined;
  return listSpecs(specsDir).find((p) => {
    const m = SPEC_FILE.exec(p.split("/").pop()!)!;
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

/** The two specs verified longest ago: empty date first, ties by path. Empty array when both are already today. */
export function verifyQueue(specsDir: string, today: string): string[] {
  const rows = listSpecs(specsDir).map((p) => ({ p, d: getField(readFileSync(p, "utf8"), "Last verified") ?? "" }));
  rows.sort((a, b) => a.d.localeCompare(b.d) || a.p.localeCompare(b.p));
  const pick = rows.slice(0, 2);
  return pick.every((r) => r.d === today) ? [] : pick.map((r) => r.p);
}

export function isInside(dir: string, cwd: string, p: string): boolean {
  const rel = relative(resolve(cwd, dir), resolve(cwd, p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

const READ_ONLY = new Set([
  "cat", "head", "tail", "less", "grep", "rg", "find", "fd", "ls", "pwd", "echo", "printf", "wc", "sort", "uniq",
  "diff", "file", "stat", "du", "tree", "which", "date", "basename", "dirname", "realpath", "cut", "tr", "jq", "awk", "sed", "true",
]);
const GIT_READ = new Set(["status", "log", "diff", "show", "blame", "grep", "ls-files", "rev-parse", "branch"]);

/** Fail-closed: every command of a pipeline/list must be a known reader; no redirection or substitution. */
export function isReadOnlyCommand(cmd: string): boolean {
  if (/[>`]|\$\(|<\(/.test(cmd)) return false;
  return cmd.split(/\|\||&&|[|;\n&]/).every((part) => {
    const w = part.trim().split(/\s+/);
    if (w[0] === "") return true;
    if (w[0] === "git") return GIT_READ.has(w[1]) && !(w[1] === "branch" && w.length > 2);
    if (!READ_ONLY.has(w[0])) return false;
    if (w[0] === "sed" && w.some((x) => /^-[a-z]*i/.test(x) || x === "--in-place")) return false;
    if ((w[0] === "find" || w[0] === "fd") && w.some((x) => /^-(exec|execdir|delete|ok|fprint)/.test(x) || x === "-x" || x === "-X")) return false;
    if (w[0] === "awk" && /system|print\s*>|\|/.test(part)) return false;
    return true;
  });
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
