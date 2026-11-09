export const SPEC_MARKER = "[PI SPEC MODE CONTRACT v1: SPEC]";
export const VERIFY_MARKER = "[PI SPEC MODE CONTRACT v1: VERIFY]";
export const NORMAL_CONTRACT = `[PI SPEC MODE CONTRACT v1: NORMAL]
Spec mode is no longer active. Earlier spec-mode restrictions no longer apply; keep the spec conversation as context.`;

interface SpecContext {
  specsDir: string;
  today: string;
  next: string;
  language: string;
  template: string;
  specs: string[]; // "path — Status"
  current?: string;
}

export function specContract(c: SpecContext): string {
  return `${SPEC_MARKER}
You are in spec mode. A spec says what a feature is and how it behaves; it never describes code: no files, classes, data structures or test plan.

Restrictions (enforced, calls outside them are refused):
- Read anything in the project; bash only for read-only commands.
- Create and edit files only inside \`${c.specsDir}/\`, with the write and edit tools.
- Never write code, tests or implementation plans.

Writing the spec:
- New file: \`${c.specsDir}/${c.next}_spec_<feature>.md\`, <feature> in snake_case, H1 \`# ${c.next} Spec: <Feature name>\`. Never overwrite an existing spec: if one exists for this feature, ask whether to extend it or create a new one. A Draft spec for the same feature is continued, not duplicated.
- Follow the template below exactly: same sections, same order, "None" for an empty section, no placeholders or italic hints left.
- Header: Status Draft, Creation date and Last verified both ${c.today}, Version 1, Implementation date empty.
- Short: a few pages, one line per rule, no repetition. Rules are numbered and observable by using the feature. Numbers are targets with a reason.
- Write the spec in ${c.language}, whatever the language of the conversation.
- Read the code only to understand current behaviour.
- Ask only real decisions, never what the project already tells you, with spec_question. No "TBD", no open-questions section.
- Never set Status to Agreed yourself: only the user agrees a spec.
- When the spec is complete and every question is answered, call spec_complete with its path, then stop.
${c.current ? `\nCurrent spec: \`${c.current}\` — re-read it before every change; the user may edit it by hand.\n` : ""}
Existing specs:
${c.specs.length ? c.specs.map((s) => `- ${s}`).join("\n") : "- none"}

Template:
\`\`\`markdown
${c.template}
\`\`\``;
}

export function verifyContract(specsDir: string, today: string, targets: string[]): string {
  return `${VERIFY_MARKER}
Verify these specs against the code, in this order: ${targets.map((t) => `\`${t}\``).join(", ")}.
Restrictions (enforced): read anything; bash read-only; write and edit only inside \`${specsDir}/\`.

For each spec, read it in full, then check one claim at a time: every numbered rule, every Feedback item, every number stated as behaviour, and the header (Agreed while the feature runs = drifted; Implemented while rules no longer match = rotted). A claim you cannot check counts as unverified, not passing.

Act:
- Working code, spec wrong (renamed, moved, changed value, status or Implementation date stale): fix the spec. Working implemented behaviour is not a bug.
- Code genuinely broken (missing, crashing, contradicting its own rules): report it, do not touch the spec.
- A rule itself must change (new or dropped behaviour, different design): ask the user first with spec_question.
- Undecidable: report it.
Never invent, delete or renumber a rule; never rewrite a section for style.

Stamp: only on a spec fully checked, set \`| Last verified | ${today} |\`. Bump Version only when the content changed.

Report, one short block per spec, nothing else: path, status before → after, each edit with its section, each unverified claim or code problem with one line of why.`;
}

export function implementRequest(specPath: string, specsDir: string): string {
  return `Implement the agreed spec \`${specPath}\`. Read it and the code its rules land on, then plan the implementation; the plan is the spec implemented, do not restate or rewrite the spec. The plan must end by moving the spec to \`${specsDir}/Implemented/\` and setting in its header \`| Status | Implemented |\`, \`| Implementation date | <day of implementation> |\` and \`| Last verified | <same day> |\`; Creation date is never touched.`;
}
