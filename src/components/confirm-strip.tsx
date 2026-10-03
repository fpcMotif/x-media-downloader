import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
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

const HOVER = '@media (hover: hover)'

// `transition-colors` (Tailwind v4) — verbatim property list.
const TRANSITION_COLORS =
  'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to'
// `focus-visible:ring-3 focus-visible:ring-ring/50` — five box-shadow layers.
const FOCUS_RING =
  '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent), 0 0 #0000'

// `animate-in fade-in` (no slide/zoom modifier — translate/scale stay at rest).
const fadeIn = stylex.keyframes({
  '0%': {
    opacity: 0,
    transform: 'translate3d(0, 0, 0) scale3d(1, 1, 1) rotate(0)',
    filter: 'blur(0)',
  },
})

const styles = stylex.create({
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  armed: {
    display: 'grid',
    gap: '0.5rem',
    borderRadius: tokens['--xmd-radius-3'],
    padding: '0.75rem',
    animationName: fadeIn,
    animationDuration: '0.18s',
    animationTimingFunction: 'var(--xmd-ease)',
    // `duration-[180ms] ease-[…]` also set transition-duration/-timing-function
    // (default `transition-property: all`).
    transitionDuration: '0.18s',
    transitionTimingFunction: 'var(--xmd-ease)',
    animationDelay: '0s',
    animationIterationCount: 1,
    animationDirection: 'normal',
    animationFillMode: 'none',
  },
  armedMuted: {
    backgroundColor: tokens['--muted'],
  },
  armedDestructiveBg: {
    backgroundColor: 'color-mix(in oklab, var(--destructive) 8%, transparent)',
  },
  sentence: {
    textWrap: 'pretty',
    fontSize: '13px',
  },
  sentenceForeground: {
    color: tokens['--foreground'],
  },
  sentenceDestructive: {
    color: tokens['--destructive'],
  },
  typedLabel: {
    display: 'grid',
    minHeight: '2.5rem',
    gap: '0.25rem',
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    color: tokens['--muted-foreground'],
  },
  actionsRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '0.5rem',
  },
  // `data-slot="button"` override baked in: transitionDuration '0.16s',
  // transitionTimingFunction 'var(--xmd-ease)' beat the element's own
  // (nonexistent, here) duration-*/ease-* utilities (spec §3).
  cancelButton: {
    height: '2.5rem',
    minWidth: '96px',
    borderRadius: tokens['--xmd-radius-3'],
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    fontWeight: 500,
    color: tokens['--foreground'],
    outlineStyle: 'none',
    transitionProperty: TRANSITION_COLORS,
    transitionDuration: '0.16s',
    transitionTimingFunction: 'var(--xmd-ease)',
    backgroundColor: { default: null, [HOVER]: { ':hover': tokens['--muted'] } },
    boxShadow: { default: null, ':focus-visible': FOCUS_RING },
  },
  confirmButton: {
    height: '2.5rem',
    minWidth: '96px',
    borderRadius: tokens['--xmd-radius-3'],
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    fontWeight: 600,
    outlineStyle: 'none',
    transitionProperty: TRANSITION_COLORS,
    transitionDuration: '0.16s',
    transitionTimingFunction: 'var(--xmd-ease)',
    boxShadow: { default: null, ':focus-visible': FOCUS_RING },
  },
  confirmPrecommitted: {
    backgroundColor: tokens['--primary'],
    color: tokens['--primary-foreground'],
  },
  confirmDestructive: {
    backgroundColor: {
      default: 'color-mix(in oklab, var(--destructive) 10%, transparent)',
      [HOVER]: { ':hover': 'color-mix(in oklab, var(--destructive) 20%, transparent)' },
    },
    color: tokens['--destructive'],
  },
  confirmInert: {
    pointerEvents: 'none',
  },
  underlineTrack: {
    position: 'relative',
    height: '2px',
    width: '100%',
    overflow: 'hidden',
    borderRadius: '3.40282e38px',
  },
  underlineFill: {
    position: 'absolute',
    insetBlock: 0,
    left: 0,
    backgroundColor: 'color-mix(in oklab, var(--destructive) 40%, transparent)',
  },
})

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
      <output
        key="confirm-strip-output"
        aria-live="polite"
        aria-atomic="true"
        {...stylex.props(styles.srOnly)}
      >
        {announceText}
      </output>

      {armedAt === null ? (
        children(arm)
      ) : (
        <div
          ref={stripRef}
          {...stylex.props(
            styles.armed,
            preCommitted ? styles.armedMuted : styles.armedDestructiveBg,
          )}
        >
          <p
            {...stylex.props(
              styles.sentence,
              preCommitted ? styles.sentenceForeground : styles.sentenceDestructive,
            )}
          >
            {sentence}
          </p>
          {typedWord !== undefined && (
            <label {...stylex.props(styles.typedLabel)}>
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

          <div {...stylex.props(styles.actionsRow)}>
            <button
              type="button"
              ref={cancelRef}
              data-slot="button"
              {...stylex.props(styles.cancelButton)}
              onClick={disarm}
            >
              Cancel
            </button>
            <button
              type="button"
              data-slot="button"
              aria-disabled={confirmInert}
              style={{ opacity: guardOpacity }}
              {...stylex.props(
                styles.confirmButton,
                preCommitted ? styles.confirmPrecommitted : styles.confirmDestructive,
                confirmInert && styles.confirmInert,
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
            <div aria-hidden="true" {...stylex.props(styles.underlineTrack)}>
              <div
                {...stylex.props(styles.underlineFill)}
                style={{ width: `${underlineRemaining * 100}%` }}
              />
            </div>
          )}
        </div>
      )}
    </>
  )
}
