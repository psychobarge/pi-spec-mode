# 0001 Spec: Dark mode

| | |
|---|---|
| Status | Draft |
| Owner | someone |
| Version | 1 |
| Creation date | 2026-01-01 |
| Implementation date | |
| Last verified | 2026-01-01 |

## 1. Problem

The app is only light; it glares at night.

## 2. Goal

The user can switch the app to a dark theme.

## 3. Non-goals

- No per-screen theme.

## 4. User experience

1. The user opens settings and picks Dark.

## 5. Rules

1. Picking Dark switches every screen at once.

## 6. Feedback

- The chosen theme is checked in settings.

## 7. Numbers and limits

| What | Target | Why that number |
|------|--------|-----------------|
| Switch time | under 200 ms | Feels instant |

## 8. Edge cases

- The system theme changes while the app is open: the app follows only if set to System.

## 9. Deferred

- Custom accent colours.
