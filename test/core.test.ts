import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  emptySections, getField, isInside, isReadOnlyCommand, leftovers, missingSections, nextSpecNumber, pickerMove,
  refuseSpec, resolveSpec, restoreSpec, setField, settingError, specChoices, specSummary, specTable, sweepRefused, verifyQueue, withSetting,
} from "../src/core.ts";

const template = readFileSync(new URL("../templates/spec_template.md", import.meta.url), "utf8");
const spec = (status: string, verified: string) =>
  `# x\n\n| | |\n|---|---|\n| Status | ${status} |\n| Version | 1 |\n| Last verified | ${verified} |\n`;

function specsDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "specs-"));
  mkdirSync(join(dir, "Implemented"));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  return dir;
}

test("numbering counts Implemented/ and never reuses", () => {
  const dir = specsDir({ "0001_spec_a.md": "", "Implemented/0004_spec_b.md": "", "spec_template.md": "" });
  assert.equal(nextSpecNumber(dir), "0005");
  assert.equal(nextSpecNumber(specsDir({})), "0001");
});

test("resolveSpec accepts every documented form", () => {
  const dir = specsDir({ "0003_spec_offline_mode.md": "", "Implemented/0001_spec_login.md": "" });
  for (const a of ["0003", "3", "0003_spec_offline_mode.md", "spec_offline_mode.md", "offline_mode"])
    assert.ok(resolveSpec(dir, a)?.endsWith("0003_spec_offline_mode.md"), a);
  assert.ok(resolveSpec(dir, "login")?.includes("Implemented"));
  assert.equal(resolveSpec(dir, "nope"), undefined);
});

test("header fields read and write", () => {
  const md = setField(spec("Draft", "2026-01-01"), "Status", "Agreed");
  assert.equal(getField(md, "Status"), "Agreed");
  assert.equal(getField(md, "Last verified"), "2026-01-01");
});

test("agree check: the raw template fails, a filled spec passes", () => {
  assert.ok(leftovers(template, template).length > 0);
  const own = readFileSync(new URL("../examples/0001_spec_dark_mode.md", import.meta.url), "utf8");
  assert.deepEqual(leftovers(own, template), []);
  assert.deepEqual(missingSections(own, template), []);
  assert.deepEqual(emptySections(own), []);
  assert.deepEqual(emptySections("# x\n\n## 1. A\n\n## 2. B\ntext\n## 3. C\n  \n## 4. D"), ["## 1. A", "## 3. C", "## 4. D"]);
  assert.deepEqual(missingSections("## 1. Problem\n", template).length, 8);
});

test("verify queue: empty date first, ties by path, nothing when both done today", () => {
  const dir = specsDir({
    "0001_spec_a.md": spec("Agreed", "2026-03-01"),
    "0002_spec_b.md": spec("Draft", ""),
    "Implemented/0003_spec_c.md": spec("Implemented", "2026-01-01"),
  });
  assert.deepEqual(verifyQueue(dir, "2026-11-09").map((p) => p.split("/").pop()), ["0002_spec_b.md", "0003_spec_c.md"]);
  const done = specsDir({ "0001_spec_a.md": spec("Draft", "2026-11-09"), "0002_spec_b.md": spec("Draft", "2026-11-09") });
  assert.deepEqual(verifyQueue(done, "2026-11-09"), []);
  assert.deepEqual(verifyQueue(dir, "2026-11-09", 1).map((p) => p.split("/").pop()), ["0002_spec_b.md"]);
});

test("writes stay inside the specs folder", () => {
  assert.ok(isInside("specs", "/p", "specs/0001_spec_a.md"));
  assert.ok(isInside("specs", "/p", "/p/specs/Implemented/x.md"));
  assert.ok(!isInside("specs", "/p", "src/index.ts"));
  assert.ok(!isInside("specs", "/p", "specs/../src/x.ts"));
  assert.ok(!isInside("specs", "/p", "specs"));
  assert.ok(!isInside(".", "/p", "../elsewhere"));
});

test("bash: readers pass, anything that writes is refused", () => {
  for (const c of ["ls -la", "grep -rn foo src | head", "git log --oneline -5", "cat a && wc -l b", "sed -n 1,20p f", "find . -name '*.md'",
    "rtk ls doc/specs/", "rtk read a.md --head-lines 20", "rtk git log -5", "rtk proxy cat a", "cd /p && git log -5 2>/dev/null | cat", "ls x 2>&1 | head",
    "sed -n '5,$p' f", "sort -u a | uniq -c", "head -n 20 f", "tree -L 2", "rg -n -t ts foo src", "fd -e md", "grep -rn -A 3 'a b' src",
    "git diff --stat HEAD~1", "git status --short", "git log --format=%h -n 3", "jq -r '.name' package.json", "sort ./*", "ls src/*.ts"])
    assert.ok(isReadOnlyCommand(c), c);
  for (const c of ["rm -rf x", "echo x > f", "sed -i s/a/b/ f", "git commit -m x", "find . -delete", "cat $(whoami)", "npm install", "ls; touch f", "git branch new",
    "rtk npm install", "rtk proxy rm x", "cat a 2> err.log", "ls >/dev/null; echo x > f", "ls >/dev/nullx", "cd /p && rm x",
    "sort -o out a", "sort --output=out a", "tree -o out", "sed -n 'w out' a", "sed 's/a/b/e' a", "git diff --output=out", "git grep -O vim x",
    "rg --pre rm x .", "fd --exec rm {}", "fd --exec-batch rm", "find . -fls out",
    "uniq a.md src/index.ts", "awk -f specs/x.awk", "sort --compress-program=sh f", "sed -n 1p -i f", "file -C -m x", "less -o log f",
    "sort \"-o\" out a", "sort \\-o out a", "sort ${X:--o} out", "sort $'\\x2do' out", "echo -o; sort $_ out", "sort x$IFS-o out", "sort {-o,out}",
    "git log --ext-diff", "git -c core.pager=sh log", "rg -z x", "read x", "date -s 12:00",
    "echo \"'\" $(touch pwned) \"'\"", "echo \\' $(touch pwned) \\'", "ls # '\necho $(touch pwned) # '", "echo hi2>&1x", "echo payload2>&1/../escaped.txt",
    "echo `id`", "cat `echo a.md`", "sort *", "find . * \\;", "cat ?x", "cat [-a]x", "sort \"\"*", "sort \"$@\"*", "sort $1", "constructor x", "constructor -x", "toString"])
    assert.ok(!isReadOnlyCommand(c), c);
});

test("refused spec: banner, status, moved, skipped by verify but still numbered", () => {
  const dir = specsDir({ "0001_spec_a.md": spec("Draft", ""), "0002_spec_b.md": spec("Draft", "2026-01-01") });
  const dest = refuseSpec(dir, join(dir, "0001_spec_a.md"), "2026-11-12");
  assert.ok(dest.endsWith("Refused/0001_spec_a.md") && !existsSync(join(dir, "0001_spec_a.md")));
  const md = readFileSync(dest, "utf8");
  assert.match(md, /^> \*\*REFUSED on 2026-11-12/);
  assert.equal(getField(md, "Status"), "Refused");
  assert.deepEqual(verifyQueue(dir, "2026-11-12").map((p) => p.split("/").pop()), ["0002_spec_b.md"]);
  assert.equal(resolveSpec(dir, "a"), undefined);
  assert.equal(nextSpecNumber(dir), "0003");
});

test("refused spec: restore undoes it, a hand-set Refused status is swept", () => {
  const dir = specsDir({ "0001_spec_a.md": spec("Agreed", ""), "0002_spec_b.md": spec("Refused", "") });
  const back = restoreSpec(dir, refuseSpec(dir, join(dir, "0001_spec_a.md"), "2026-11-12"));
  assert.equal(readFileSync(back, "utf8"), spec("Draft", ""));
  assert.ok(resolveSpec(dir, "a"));
  assert.deepEqual(sweepRefused(dir, "2026-11-12").map((p) => p.split("/").slice(-2).join("/")), ["Refused/0002_spec_b.md"]);
  assert.ok(resolveSpec(dir, "b", true)?.includes("Refused"));
});

test("specTable lists every spec with status and verification age, Refused/ included", () => {
  const dir = specsDir({ "0001_spec_login.md": spec("Agreed", "2026-11-06"), "Implemented/0002_spec_offline.md": spec("Implemented", "") });
  refuseSpec(dir, join(dir, "0001_spec_login.md"), "2026-11-12");
  const rows = specTable(dir, "2026-11-16");
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^0001 +Refused +verified 2026-11-06 \(10 d ago\) +login$/);
  assert.match(rows[1], /^0002 +Implemented +never verified +offline$/);
  assert.deepEqual(specTable(specsDir({}), "2026-11-16"), []);
});

test("specTable shows a Last verified date in the future as 0 days ago, never a negative age", () => {
  const rows = specTable(specsDir({ "0001_spec_a.md": spec("Agreed", "2027-01-01") }), "2026-11-20");
  assert.match(rows[0], /verified 2027-01-01 \(0 d ago\)/);
});

test("specChoices: one picker entry per spec, Refused/ included, number as argument", () => {
  const dir = specsDir({ "0001_spec_login.md": spec("Agreed", ""), "Implemented/0002_spec_offline.md": spec("Implemented", "") });
  refuseSpec(dir, join(dir, "0001_spec_login.md"), "2026-11-12");
  writeFileSync(join(dir, "Refused/0003_spec_old.md"), spec("Refused", ""));
  writeFileSync(join(dir, "0004_spec_todo.md"), "# no header\n");
  assert.deepEqual(specChoices(dir), [
    { num: "0001", status: "Refused", folder: "Refused", label: "0001 · Refused · login", arg: "0001" },
    { num: "0002", status: "Implemented", folder: "Implemented", label: "0002 · Implemented · offline", arg: "0002" },
    { num: "0003", status: "Refused", folder: "Refused", label: "0003 · Refused · old", arg: "0003" },
    { num: "0004", status: "?", folder: "", label: "0004 · ? · todo", arg: "0004" },
  ]);
  assert.deepEqual(specChoices(specsDir({})), []);
});

test("specSummary: H1 title and the first line of Goal, capped", () => {
  assert.equal(specSummary("# 0003 Spec: Offline mode\n\n## 2. Goal\n\nThe app works without network.\nmore\n"), "Offline mode: The app works without network.");
  assert.equal(specSummary("# 0003 Spec: Offline mode\n\n## Problem\n\nx\n"), "Offline mode");
  assert.equal(specSummary("## 2. Goal\n\n## 3. Non-goals\n"), "");
  assert.equal(specSummary(`# T\n## Goal\n${"x".repeat(300)}`).length, 200);
});

test("settingError accepts valid values and names the rule a bad one breaks", () => {
  const cwd = mkdtempSync(join(tmpdir(), "set-"));
  writeFileSync(join(cwd, "file.md"), "");
  assert.equal(settingError("specsDir", "doc/specs", cwd), undefined);
  assert.match(settingError("specsDir", "../out", cwd)!, /inside the project/);
  assert.match(settingError("specsDir", "file.md", cwd)!, /folder/);
  assert.equal(settingError("language", "Français", cwd), undefined);
  assert.match(settingError("language", "  ", cwd)!, /non-empty/);
  assert.equal(settingError("verifyCount", 3, cwd), undefined);
  assert.match(settingError("verifyCount", 0, cwd)!, /positive integer/);
  assert.match(settingError("verifyCount", Number("two"), cwd)!, /positive integer/);
  assert.match(settingError("renameSession", "yes", cwd)!, /true or false/);
  assert.match(settingError("renamePlanSession", 1, cwd)!, /renamePlanSession must be true or false/);
  assert.match(settingError("other", 1, cwd)!, /unknown setting/);
});

test("withSetting sets one key, keeps the others and refuses a file that is not a JSON object", () => {
  assert.deepEqual(JSON.parse(withSetting('{ "language": "French" }', "verifyCount", 4)), { language: "French", verifyCount: 4 });
  assert.deepEqual(JSON.parse(withSetting(undefined, "renameSession", true)), { renameSession: true });
  assert.throws(() => withSetting("{ broken", "language", "French"));
  assert.throws(() => withSetting("[1]", "language", "French"), /not a JSON object/);
});

test("pickerMove: up on the first spec wraps to the last, down on the last wraps to the first", () => {
  assert.equal(pickerMove(0, 4, "up"), 3);
  assert.equal(pickerMove(2, 4, "up"), 1);
  assert.equal(pickerMove(1, 4, "down"), 2);
  assert.equal(pickerMove(3, 4, "down"), 0);
  assert.equal(pickerMove(0, 1, "up"), 0);
});
