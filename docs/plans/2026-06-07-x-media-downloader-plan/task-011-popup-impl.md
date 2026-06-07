# Task 011 — Popup (impl)

**type:** impl
**depends-on:** ["006-settings-impl", "007-download-queue-impl", "008-messaging-impl"]

## BDD Scenario

```gherkin
Scenario: Live queue display
  Given downloads are in progress
  When the popup is open
  Then each item shows progress and supports retry/cancel

Scenario: Edit settings
  Given the popup settings panel
  When the user changes the filename template or toggles auth-fallback and saves
  Then SettingsService persists it and the change survives reopen
```

## Files

- `src/entrypoints/popup/index.html` + `main.tsx`
- `src/ui/popup/*` (Preact + Tailwind)

## Steps

1. Subscribe to `QueueUpdate` events via `Messaging`; render queue with
   progress/retry/cancel.
2. Settings panel bound to `SettingsService` (template, concurrency, auth toggle, theme).
3. Minimalist Tailwind; light/dark; keyboard-operable.

## Verification

- Component tests for queue list + settings form.
- Manual: progress reflects real downloads; settings persist.
