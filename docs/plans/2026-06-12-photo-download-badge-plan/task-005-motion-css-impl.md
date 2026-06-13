# Task 005: Badge motion CSS

**depends-on**: none (shares the `.xmd-badge` class contract with task 004)

## Description

Add the badge's visual and motion styles to the overlay stylesheet, implementing spec §3 exactly. Pure CSS; no logic.

## Execution Context

**Task Number**: 8 of 8
**Phase**: Core Features
**Prerequisites**: none

## BDD Scenarios (manually verified)

```gherkin
Scenario: Lively entrance
  Given a badge element gains xmd-badge--shown
  Then it plays a 480ms entrance (cubic-bezier(0.23,1,0.32,1)):
    opacity 0 / translateY(14px) / scale(0.5) → overshoot translateY(-8px) scale(1.18) at 48% → settle through 0.95 and 1.04 to rest
  And it never animates from scale(0)

Scenario: Two-hop nudge
  Given xmd-badge--nudged is applied
  Then a single 720ms two-hop plays: -7px @ scale 1.06, settle, -4px @ scale 1.03, settle

Scenario: State visuals
  Then idle shows dark glass oklch(0.18 0.012 255 / 0.88), blur(8px), inset ring oklch(0.62 0.18 245 / 0.5), glow 0 0 6px oklch(0.62 0.18 245 / 0.18), azure glyph oklch(0.72 0.16 245)
  And saved shows green glass oklch(0.32 0.06 160 / 0.92), ring oklch(0.7 0.16 160 / 0.7), check oklch(0.84 0.14 160)
  And failed uses the --xmd-danger family
  And :active scales to 0.96
  And icon swaps cross-fade opacity/scale(0.25→1)/blur(4px→0) over 220ms cubic-bezier(0.2,0,0,1)

Scenario: Reduced motion
  Given prefers-reduced-motion: reduce
  Then entrance and nudge animations are disabled and only a 150ms opacity fade remains

Scenario: Hit area
  Then a pseudo-element extends the interactive area to at least 44x44px without growing the visible circle
```

**Spec Source**: `docs/superpowers/specs/2026-06-12-photo-download-badge-design.md` §3

## Files to Modify/Create

- Modify: `src/entrypoints/overlay.content/style.css` (new `.xmd-badge` block after `.xmd-grab`; new tokens join the `:host,:root` block)

## Steps

### Step 1: Implement styles
- Follow the file's existing conventions: oklch everywhere, `--xmd-ease`, explicit `transition-property` lists (never `all`), `@starting-style` where it fits, `@media (hover:hover) and (pointer:fine)` for hover-only rules, and extend the existing `prefers-reduced-motion` block.
- Class contract (must match task 004): `.xmd-badge`, `.xmd-badge--lightbox` (40px, 21px glyph), phase modifiers `--shown/--nudged/--queued/--saved/--failed`, `.xmd-badge__icon`.

### Step 2: Verify
- `bun run check` (oxfmt covers CSS formatting); visual QA rides task 004's checklist with DevTools slow-mo.

## Verification Commands

```bash
bun run check
```

## Success Criteria

- All §3 values present verbatim; reduced-motion handled; no `transition: all`; tokens consistent with the existing `--xmd-*` family.
