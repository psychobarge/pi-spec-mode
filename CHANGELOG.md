# Changelog

## 0.0.1-beta3

- Spec mode writes exactly the path it checked: paths that pi rewrites (`@x`, `~/x`, `file://…`) can no longer escape the specs folder.

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
