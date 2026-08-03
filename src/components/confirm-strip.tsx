import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import {
  disarmDeadline,
  guardMs,
  isGuardElapsed,
  outsideClickArmed,
  typedWordSatisfied,
  underlineStart,
  type GuardKind,
} from './confirm-strip-logic'

// Only one ConfirmStrip may be armed at a time across a whole surface (popup
// or options) — arming any strip disarms whichever other strip was already
// armed. Module-level by design (spec §2.4 "Arbitration"): every ConfirmStrip
// instance registers/deregisters itself here regardless of which component
// tree it lives in.
let disarmCurrent: (() => void) | null = null

const TICK_MS = 100

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

export interface ConfirmStripProps {
  /** The consequence sentence shown once armed (13px, tier-colored). */
  readonly sentence: string
  /** The literal-action confirm button's label — never the bare word
   *  "Confirm" (design contract line 4). */
  readonly confirmLabel: string
  /** `one-shot` = 450ms guard (Release/Erase); `pre-committed` = 250ms guard
   *  (the toggle-ON gate). Also selects the strip's tier styling. */
  readonly kind: GuardKind
  /** Present only for the whole-list release gate — renders the typed-word
   *  `<Input>` and adds it to the confirm gate (§2.5). The word to match
   *  against (case-insensitive, trimmed); pass `RELEASE_WORD.toLowerCase()`
   *  or similar from action-copy.ts. */
  readonly typedWord?: string
  readonly onConfirm: () => void
  /** Render-prop trigger: the idle control keeps its own styling and calls
   *  `arm()` on activation (click, or Enter/Space via a normal `<button>`). */
  readonly children: (arm: () => void) => VNode
}

/** The shared arm→confirm control behind every destructive/precommitted
 *  action in popup + options (spec §2.4/§2.5). Replaces every `confirm()`
 *  call in the product. */
export function ConfirmStrip(props: ConfirmStripProps): VNode {
  const { sentence, confirmLabel, kind, typedWord, onConfirm, children } = props
  const [armedAt, setArmedAt] = useState<number | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())
  const [typedValue, setTypedValue] = useState('')
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const triggerFocusRef = useRef<HTMLElement | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)

  // Stable identity (empty deps — it closes only over the useState setters,
  // which Preact guarantees never change) so the effects below can safely
  // list it as a dependency without refiring on every render.
  const disarm = useCallback((): void => {
    setArmedAt(null)
    setTypedValue('')
    if (disarmCurrent === disarm) disarmCurrent = null
  }, [])

  const arm = (): void => {
    triggerFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    disarmCurrent?.()
    disarmCurrent = disarm
    const t = Date.now()
    setArmedAt(t)
    setNow(t)
  }

  // Tick while armed so the guard-window inertness and the auto-disarm
  // underline are driven by wall-clock timestamps, not CSS transitions — see
  // confirm-strip-logic.ts's module doc for why that matters under
  // prefers-reduced-motion.
  useEffect(() => {
    if (armedAt === null) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [armedAt])

  useEffect(() => {
    if (armedAt === null) return
    if (now >= disarmDeadline(armedAt)) disarm()
  }, [now, armedAt, disarm])

  // Focus moves to Cancel on arm — repeating the arming keystroke cancels,
  // never confirms (§2.4 "Keyboard path").
  useEffect(() => {
    if (armedAt === null) return
    cancelRef.current?.focus()
  }, [armedAt])

  useEffect(() => {
    if (armedAt === null) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        disarm()
        triggerFocusRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [armedAt, disarm])

  useEffect(() => {
    if (armedAt === null) return
    const onPointerDown = (e: MouseEvent): void => {
      if (!outsideClickArmed(armedAt, Date.now())) return
      if (stripRef.current && e.target instanceof Node && stripRef.current.contains(e.target))
        return
      disarm()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [armedAt, disarm])

  const startedAt = armedAt ?? Date.now()
  const guardElapsed = armedAt !== null && isGuardElapsed(startedAt, now, kind)
  const guardWindowMs = guardMs(kind)
  const guardProgress = Math.min(1, Math.max(0, (now - startedAt) / guardWindowMs))
  const guardOpacity = guardElapsed ? 1 : 0.4 + 0.6 * guardProgress

  const underlineStartsAt = underlineStart(startedAt)
  const showUnderline = armedAt !== null && now >= underlineStartsAt && !prefersReducedMotion()
  const underlineRemaining = showUnderline
    ? Math.max(
        0,
        (disarmDeadline(startedAt) - now) / (disarmDeadline(startedAt) - underlineStartsAt),
      )
    : 0

  const wordOk = typedWord === undefined || typedWordSatisfied(typedValue, typedWord)
  const confirmInert = !guardElapsed || !wordOk

  const preCommitted = kind === 'pre-committed'
  const announceText = armedAt !== null ? `Press ${confirmLabel} to continue, or Cancel.` : ''

  return (
    <>
      <output key="confirm-strip-output" aria-live="polite" aria-atomic="true" className="sr-only">
        {announceText}
      </output>

      {armedAt === null ? (
        children(arm)
      ) : (
        <div
          ref={stripRef}
          className={cn(
            'animate-in fade-in grid gap-2 rounded-[var(--xmd-radius-3)] p-3 duration-[180ms] ease-[var(--xmd-ease)]',
            preCommitted ? 'bg-muted' : 'bg-destructive/8',
          )}
        >
          <p
            className={cn(
              'text-pretty text-[13px]',
              preCommitted ? 'text-foreground' : 'text-destructive',
            )}
          >
            {sentence}
          </p>
      {typedWord !== undefined && (
        <label className="grid min-h-10 gap-1 text-xs text-muted-foreground">
          Type {typedWord.toUpperCase()} to continue
          <Input
            value={typedValue}
            autoComplete="off"
            spellCheck={false}
            onChange={(e: Event) => setTypedValue((e.target as HTMLInputElement).value)}
            onKeyDown={(e: KeyboardEvent) => {
              // The typed-word gate cannot fire on Enter alone — Enter inside
              // the input is inert; firing requires an explicit activation of
              // the confirm button (§2.5).
              if (e.key === 'Enter') e.preventDefault()
            }}
          />
        </label>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          ref={cancelRef}
          data-slot="button"
          className="h-10 min-w-[96px] rounded-[var(--xmd-radius-3)] text-xs font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={disarm}
        >
          Cancel
        </button>
        <button
          type="button"
          data-slot="button"
          aria-disabled={confirmInert}
          style={{ opacity: guardOpacity }}
          className={cn(
            'h-10 min-w-[96px] rounded-[var(--xmd-radius-3)] text-xs font-semibold outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50',
            confirmInert && 'pointer-events-none',
            preCommitted
              ? 'bg-primary text-primary-foreground'
              : 'bg-destructive/10 text-destructive hover:bg-destructive/20',
          )}
          onClick={() => {
            if (confirmInert) return
            onConfirm()
            disarm()
          }}
        >
          {confirmLabel}
        </button>
      </div>

      {showUnderline && (
        <div aria-hidden="true" className="relative h-[2px] w-full overflow-hidden rounded-full">
          <div
            className="absolute inset-y-0 left-0 bg-destructive/40"
            style={{ width: `${underlineRemaining * 100}%` }}
          />
        </div>
      )}
        </div>
      )}
    </>
  )
}
