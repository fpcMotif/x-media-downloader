# Task 012 — Popup consent gate + status (test / Red)

- **type:** test
- **depends-on:** ["005", "009"]
- **files:** `src/entrypoints/popup/cloud-sync.test.ts` (new)

## Objective

Write failing tests for the popup's cloud-sync surface, following the existing
`popup-layout.test.ts` + happy-dom patterns. Covers the first-run disclosure gate (sync off), the
consent requirement to enable, the honest 3-state status line, and the on-demand backup action. The
Convex query (`statusCounts`) and settings are mocked.

**External-dependency isolation:** mock the Convex reactive client / `statusCounts` query and the
settings store; no network.

## BDD Scenario

```gherkin
Scenario: First run shows the disclosure gate with sync off
  Given a fresh install
  When the popup opens
  Then cloud sync is shown as off
  And a disclosure explains what leaves the device

Scenario: Enabling sync requires passing the consent gate
  Given the popup is open with sync off
  When the user toggles cloud sync on
  Then the consent disclosure is presented
  And cloudSyncEnabled becomes true only after acknowledgement

Scenario: The status line shows honest 3-state counts
  Given statusCounts returns { safe: 5, pending: 2, failed: 1 }
  When the popup renders the status line
  Then it shows 5 safe, 2 syncing, 1 failed
  And "safe" reflects a confirmed Convex write

Scenario: On-demand backup from the popup
  Given the popup is open and sync is enabled
  When the user triggers "Back up now"
  Then an on-demand capture is dispatched
```

## Steps

1. Render the popup with sync off → assert disclosure + off state.
2. Toggle on without ack → stays off; ack → becomes true.
3. Mock `statusCounts` → assert the three counts render.
4. Trigger "Back up now" → assert an on-demand capture/flush is dispatched.

## Verification

- `bun run test src/entrypoints/popup` → new cases **FAIL** (UI absent).
