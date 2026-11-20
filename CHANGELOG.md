# Changelog

## unreleased

### Added

- In the spec picker of the `/spec` menu, ↑ on the first spec jumps to the last one and ↓ on the last spec back to the first, so the newest specs are one key away.
- `/spec settings` is now interactive: after showing the effective settings it opens a menu to change `specsDir`, `language`, `verifyCount` or `renameSession` and save it in the project or the global file. Invalid values are refused with the same rules as the files, other keys are kept, and a settings file that is not valid JSON is never overwritten.
- `renamePlanSession` setting (off by default): `/spec implement` renames the session `spec NNNN planning` before handing spec `NNNN` to plan mode, whether the spec is typed or picked from the `/spec` menu.
- `renameSession` setting (off by default): the session that creates a spec is renamed `spec NNNN creation`, so `/resume` shows which spec it wrote.
- `/spec verify` ends by asking whether to agree again each spec it changed: an `Agreed` spec that had to be fixed goes back to `Draft`, and you get one question per spec that changed that way (`Agree again` / `Keep Draft`). A spec only stamped `Last verified` stays `Agreed` and is not offered, and so is a spec that was already `Draft`.
- `/spec agree <spec>` agrees an existing `Draft` spec (`/spec agree 0003`) with the same template checks as `/spec agree`: answering `Keep Draft` after a verify run is not final, and you no longer have to edit the `Status` row by hand. `Implemented` and `Refused` specs are refused.

### Changed

- The `/spec` menu uses the command words of `/spec ` + Tab (`exit (leave spec mode)` instead of “Leave spec mode”, `implement (hand a spec to plan mode)`...) and offers exactly the same commands in every state: `agree` outside spec mode (picks a Draft spec), `template` in spec mode and `exit` during a verify run are now in both.
- The footer reads `✎ spec-mode` and is blue instead of violet.
- Spec mode now closes only on the spec it was opened for: `/spec agree 0003` on another spec agrees it and keeps the session that is writing `0004` running, where it used to close. Conversely `/spec refuse` (or a hand-set `Status | Refused`) on the spec in the footer leaves spec mode instead of leaving it open with nothing left to write.

- `/spec template` no longer just copies the generic template: it warns you first, then the agent quickly analyses the project (type, stack, domain) and rewrites `specs/spec_template.md` for it, and asks you to reread the result — `/spec agree` checks every spec against that file. Answer `No` and you are offered the plain copy instead. The agent may change the template only during this run.

### Fixed

- A spec file that is a symbolic link is now ignored: a linked spec whose target said `Status | Refused` made session start write the `REFUSED` banner into the target, outside the specs folder, then move the link into `specs/Refused/` where it no longer resolved.
- `/spec agree 9999` or `/spec verify 9999` (a number or spec file name that matches no spec, or a refused one) now answers `No spec "9999"`: it used to turn spec mode on and send `agree 9999` to the agent as a request.
- During `/spec verify`, an `Agreed` spec the agent set to `Draft` itself is now treated like any changed `Agreed` spec: `Version` + 1, a notice, and the `Agree again` question at the end of the run. It used to stay `Draft` silently with the same `Version`. A spec whose only change is that status line stays `Agreed`.
- A `specsDir` setting that points to an existing file (`"README.md"`) is ignored with a warning and `"specs"` is used, like a path outside the project: it used to make `/spec list` and the other commands fail with `ENOTDIR`.
- `/spec list` shows a `Last verified` date in the future (a typo such as `2027-01-01`) as `0 d ago` instead of a negative age.

## 0.0.2

### Added

- The `/spec` menu no longer asks you to type a spec number: `implement`, `refuse` and `restore` (and `agree` outside spec mode) show a list of the specs they accept (`0001 · Agreed · login`), filtered on what the action can act on: only `Agreed` specs can be implemented, only `specs/Refused/` ones restored, and only the specs folder is offered for a refusal. Nothing to offer → a message naming the command to type. `/spec implement 0003` and friends still work.
- `examples/0001_spec_dark_mode.md` ships with the package: a deliberately barebone but complete spec to read before writing your own. The tests read their fixture from it, so it cannot drift from the format `/spec agree` accepts.
- GitHub Actions runs `npm run typecheck` and `npm test` on every push and pull request (Node 22): a regression in the bash filter or the status rules now shows up without anyone remembering to run the tests.

### Fixed

- `/spec verify` never moves a spec back: an `Implemented` spec fixed to match the code stays `Implemented`. If the agent sets it to `Agreed`, its previous status is restored (it used to go back to `Draft`).
- A `language` setting that is not a non-empty string (`3`, `null`, `""`) is ignored with a warning and replaced by `"English"`: it used to reach the spec contract verbatim and the agent wrote in an unpredictable language.

## 0.0.1

- `/spec list`: every spec, refused ones included, with its `Status`, `Last verified` and how many days ago. Also in the `/spec` menu.
- `/spec agree` refuses a spec with an empty section: write "None" when nothing applies to bypass this.
- `/spec verify <spec>` checks one spec, even if already verified today. `/spec verify` followed by anything that is not a spec name is still sent as a request and not a command. Works with for example 3, 0003, offline_mode, or the complete file name.
- Spec mode checks a new spec for conflicts with existing ones before `spec_complete`. The agent sees only each spec's title and Goal sentence, and reads in full only the `Agreed`/`Implemented` specs on the same subject: cheap on context, but not infallible. A conflicting rule in a spec whose title and goal look unrelated is missed; `/spec verify` remains the safety net.

## 0.0.1-beta4

- The bash filter refuses `$(…)` hidden behind a `'` that bash does not treat as a quote (inside `"…"`, after `\`, in a comment). A command mixing a single-quoted `$` with `"`, `\`, `#` or `<<` is now refused.
- The bash filter refuses `2>&1x`: a `2>&1` redirect must end the word.
- Spec names match `.md` in any case: on macOS and Windows, writing `0001_spec_x.MD` no longer skips the "only `/spec agree` agrees" check.
- Spec mode writes only Markdown (`.md`) files under the specs folder, so the agent cannot plant a git config that `git status` would run.
- The bash filter refuses a word starting with a glob (`sort *`): a file named `-o` in the project would turn it into a flag. Write `./*` instead. `$@`, `$*` and `$1` are refused too.
- Spec mode refuses to write through a symbolic link under the specs folder (or the specs folder itself being one): a link shipped by a cloned repo can no longer send writes outside.
- `/spec implement` accepts an implemented spec that was extended and agreed again (`Status` back to `Agreed` in `specs/Implemented/`).
- `/spec <request>` starting with a command word (`/spec verify that login works offline`, `/spec start with…`) is sent as a request: `start`, `exit`, `off`, `agree`, `verify`, `template` and `settings` run only when typed alone.

## 0.0.1-beta3

- Spec mode writes exactly the path it checked: paths that pi rewrites (`@x`, `~/x`, `file://…`) can no longer escape the specs folder.
- Only `/spec agree` makes a spec `Agreed`: a spec the agent sets to `Agreed` goes back to `Draft`, in spec mode and during `/spec verify`.
- `/spec verify`: an `Agreed` spec whose content changes goes back to `Draft`; stamping `Last verified` alone keeps it `Agreed`.
- The agent cannot change `specs/spec_template.md` in spec mode or during `/spec verify`.
- A project whose own path contains a folder starting with `-` can write specs again.
- The bash filter refuses `>/dev/nullx`.

## 0.0.1-beta2

- Spec mode's bash filter is now an allowlist: each allowed command accepts only known read flags; `awk` and `less` are no longer allowed. Shell expansions that could produce a flag (`${…}`, `$'…'`, `$VAR`, `{a,b}`) are refused.
- Spec mode refuses file and folder names starting with `-`.
- `/spec agree` refuses a spec whose `Status` header row is missing, instead of reporting it agreed.
- README: npm, license, pi and node badges.

## 0.0.1-beta1

- Spec mode refuses read commands whose flags write files or run commands: `sort`/`tree -o`, `git --output`/`-O`, `rg --pre`, `fd --exec`, `find -fls`. `sed` is accepted only as `sed -n '<lines>p'`.
- Spec numbering and lookup work with Windows paths.
- Editing an Agreed spec bumps `Version` once, even when the edit already bumped it.

## 0.0.1-alpha3

- `/spec refuse [spec]`: sets a spec to `Refused`, adds a warning line on top and moves it to `specs/Refused/`. Refused specs are kept but skipped by `/spec verify`, `/spec implement` and the agent; their numbers are never reused.
- A spec whose `Status` is set to `Refused` by hand or by the agent is moved the same way.
- `/spec restore <spec>`: moves a refused spec back to `specs/` as `Draft`.
- `/spec` menu offers refuse and restore.
- `verifyCount` setting: how many specs `/spec verify` checks per run (default 2).
- Spec mode is entered only through `/spec` commands: trigger phrases removed.
- README: workflow diagram.

## 0.0.1-alpha2

- Spec mode accepts rtk-rewritten read commands, `cd` and redirects to `/dev/null`.
- `/spec settings` shows which settings files exist.

## 0.0.1-alpha

- First release: spec mode with write restrictions, `/spec agree`, `/spec verify`, `/spec implement` (via `@narumitw/pi-plan-mode`) and a generic spec template.
