# Task 013 — Popup consent gate + status (impl / Green)

- **type:** impl
- **depends-on:** ["012"]
- **files:** `src/entrypoints/popup/App.tsx` (modify), `src/entrypoints/popup/CloudSyncPanel.tsx` (new), `src/components/ui/*` (reuse)

## Objective

Build the popup cloud-sync surface so 012 passes: Convex Auth sign-in, a master `cloudSync` toggle
gated by a disclosure/consent component (off by default), one quiet status line bound reactively to
`statusCounts`, and an on-demand "Back up now" action. Keep the popup light — **no provider matrix, no
library grid, no connections management** (that is the Phase-2 options page). Reuse the vendored
shadcn `Switch`/`Card`/`Button`.

## Contracts (signatures only — no bodies)

```tsx
// src/entrypoints/popup/CloudSyncPanel.tsx
export function CloudSyncPanel(props: {
  signedIn: boolean
  settings: { cloudSyncEnabled: boolean; syncTrigger: SyncTrigger; cloudConvexUrl: string }
  counts: { safe: number; pending: number; failed: number }
  onSignIn(): void
  onEnableWithConsent(): void   // toggles on only after the disclosure is acknowledged
  onBackupNow(): void
}): JSX.Element
```

## BDD Scenario

```gherkin
Scenario: Enabling sync requires passing the consent gate
  Given the popup is open with sync off
  When the user toggles cloud sync on
  Then the consent disclosure is presented
  And cloudSyncEnabled becomes true only after acknowledgement

Scenario: The status line shows honest 3-state counts
  Given statusCounts returns { safe: 5, pending: 2, failed: 1 }
  When the popup renders the status line
  Then it shows 5 safe, 2 syncing, 1 failed
```

## Steps

1. Add `CloudSyncPanel` with sign-in, the consent-gated toggle, the status line, and "Back up now".
2. Wire it into `App.tsx` behind the reactive Convex client (constructed only when `cloudConvexUrl` set).
3. Bind the status line to `statusCounts`; label `pending` as "syncing".

## Verification

- `bun run test src/entrypoints/popup` → **GREEN**.
- Manual popup smoke: off by default; enabling shows the disclosure; counts render.
