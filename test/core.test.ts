import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_TRIGGERS, getField, isInside, isReadOnlyCommand, leftovers, matchTrigger, missingSections, nextSpecNumber,
  resolveSpec, setField, verifyQueue,
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

test("triggers: EN/FR, accents, implement before create", () => {
  assert.equal(matchTrigger("Write the spec for offline mode", DEFAULT_TRIGGERS)?.kind, "create");
  assert.equal(matchTrigger("crée une spec pour le mode hors ligne", DEFAULT_TRIGGERS)?.kind, "create");
  assert.equal(matchTrigger("cree une spec", DEFAULT_TRIGGERS)?.kind, "create");
  assert.equal(matchTrigger("vérifie les specs", DEFAULT_TRIGGERS)?.kind, "verify");
  assert.deepEqual(matchTrigger("implémente la spec 0003", DEFAULT_TRIGGERS), { kind: "implement", rest: "0003" });
  assert.equal(matchTrigger("fix the login bug", DEFAULT_TRIGGERS), undefined);
});

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
  const own = readFileSync(new URL("./fixtures/filled_spec.md", import.meta.url), "utf8");
  assert.deepEqual(leftovers(own, template), []);
  assert.deepEqual(missingSections(own, template), []);
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
    "rtk ls doc/specs/", "rtk read a.md --head-lines 20", "rtk git log -5", "rtk proxy cat a", "cd /p && git log -5 2>/dev/null | cat", "ls x 2>&1 | head"])
    assert.ok(isReadOnlyCommand(c), c);
  for (const c of ["rm -rf x", "echo x > f", "sed -i s/a/b/ f", "git commit -m x", "find . -delete", "cat $(whoami)", "npm install", "ls; touch f", "git branch new",
    "rtk npm install", "rtk proxy rm x", "cat a 2> err.log", "ls >/dev/null; echo x > f", "cd /p && rm x"])
    assert.ok(!isReadOnlyCommand(c), c);
});
