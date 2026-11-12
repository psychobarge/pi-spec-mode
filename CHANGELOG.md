# Changelog

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
