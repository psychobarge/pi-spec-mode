# NNNN Spec: <feature name>

> Generic template shipped with pi-spec-mode. Adapt it to your project: run
> `/spec template` to copy it to `specs/spec_template.md`, then rename sections,
> rewrite the hints for your domain (a game, an API, a CLI, a mobile app...) and
> delete what never applies. Spec mode always uses the project's copy when there
> is one.
>
> A spec says what the feature is and how it behaves; it never describes code. One
> line per rule, no repetition, a few pages at most. Delete every `<...>`
> placeholder and *italic hint* when filling it.

| | |
|---|---|
| Status | Draft / Agreed / Implemented / Refused |
| Owner | <who decides> |
| Version | <1> |
| Creation date | <YYYY-MM-DD> |
| Implementation date | <YYYY-MM-DD, empty until implemented> |
| Last verified | <YYYY-MM-DD, the last time the spec was checked against the code> |

## 1. Problem

*What the user cannot do today, does badly, or does not understand. One
paragraph, no solution in it.*

## 2. Goal

*One sentence that says the feature works. If it needs an "and", it is two
specs.*

## 3. Non-goals

*What a reader would reasonably expect and will never get from this feature. A
rejection, not a delay.*

- <...>

## 4. User experience

*The feature as the user lives it, step by step, from the moment it matters to
the moment it is over. Plain words, no internal names.*

1. <...>

## 5. Rules

*Behaviour, numbered so it can be referred to. Each rule is observable from the
outside: something happens, or nothing happens.*

1. <...>

## 6. Feedback

*What the user sees or receives to understand what just happened: messages,
states, errors, confirmations before an irreversible action.*

- <...>

## 7. Numbers and limits

*Sizes, durations, quotas and thresholds the feature needs, as targets with a
reason. Ranges are fine.*

| What | Target | Why that number |
|------|--------|-----------------|
| <...> | <...> | <...> |

## 8. Edge cases

*Where the naive reading of the rules gives a bad answer, and what should happen
instead.*

- <e.g. the list is empty, the network drops mid-action, the user is interrupted>

## 9. Deferred

*Ideas parked for a later version, so they are neither lost nor built by
mistake. Anything that must never happen is a non-goal instead.*

- <...>
