import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import {
  decodeTransferRecoveryResponse,
  type SettingsRecoveryStatus,
  type TransferRecoveryItem,
  type TransferRecoveryResponse,
} from '@/core/schema'
import { expectReply, safeSend } from '@/core/messaging'
import { useOptionsSettingsRecovery } from '../settings-recovery-context'
import { ConfirmStrip } from '@/components/confirm-strip'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { PanelHeader, Section, type PanelProps } from '../ui'

const decode = decodeTransferRecoveryResponse
const RECOVERY_PAGE_SIZE = 25

const request = async (
  action: 'inspect' | 'forget',
  id?: string,
): Promise<TransferRecoveryResponse | undefined> => {
  const reply = expectReply(
    await safeSend(() =>
      browser.runtime.sendMessage({
        _tag: 'TransferRecoveryRequest' as const,
        action,
        ...(action === 'forget' && id !== undefined ? { id } : {}),
      }),
    ),
  )
  return reply.status === 'ok' ? decode(reply.reply) : undefined
}

const label = (item: TransferRecoveryItem): string =>
  item.kind === 'prepared-launch'
    ? 'Download setup interrupted'
    : item.kind === 'browser-unresolved'
      ? 'Chrome download unknown'
      : item.kind === 'aria2-unresolved'
        ? 'aria2 request unknown'
        : item.kind === 'forget-pending'
          ? 'Transfer close pending'
          : item.kind === 'legacy-unresolved'
            ? 'Older transfer unknown'
            : 'Download start unknown'

const recoveryKeys = (status: SettingsRecoveryStatus): string => {
  const keys = [...status.invalidKeys, ...status.unknownKeys]
  if (keys.length === 0) return ''
  return `${keys.join(', ')}${status.truncated ? ', …' : ''}`
}

export function RecoveryPanel(_: PanelProps) {
  const [result, setResult] = useState<TransferRecoveryResponse | null>(null)
  const [page, setPage] = useState(0)
  const [requestPending, setRequestPending] = useState(false)
  const [pendingForgetId, setPendingForgetId] = useState<string | null>(null)
  const mounted = useRef(false)
  const responseEpoch = useRef(0)
  const requestInFlight = useRef(false)
  const {
    state: settingsRecovery,
    refresh: refreshSettings,
    recover: recoverSettings,
  } = useOptionsSettingsRecovery()

  const runRequest = useCallback(
    async (action: 'inspect' | 'forget', id?: string): Promise<void> => {
      if (requestInFlight.current) return
      requestInFlight.current = true
      const epoch = ++responseEpoch.current
      setRequestPending(true)
      setPendingForgetId(action === 'forget' ? (id ?? null) : null)
      let next: TransferRecoveryResponse
      try {
        next = (await request(action, id)) ?? { _tag: 'TransferRecoveryUnavailable' }
      } catch {
        next = { _tag: 'TransferRecoveryUnavailable' }
      }
      if (mounted.current && responseEpoch.current === epoch) {
        setResult(next)
        setPage((current) => {
          if (action === 'inspect' || next._tag !== 'TransferRecovery') return 0
          const lastPage = Math.max(0, Math.ceil(next.items.length / RECOVERY_PAGE_SIZE) - 1)
          return Math.min(current, lastPage)
        })
        requestInFlight.current = false
        setRequestPending(false)
        setPendingForgetId(null)
      }
    },
    [],
  )

  useEffect(() => {
    mounted.current = true
    void runRequest('inspect')
    void refreshSettings()
    return () => {
      mounted.current = false
      responseEpoch.current += 1
      requestInFlight.current = false
    }
  }, [refreshSettings, runRequest])

  const items = result?._tag === 'TransferRecovery' ? result.items : []
  const pageCount = Math.max(1, Math.ceil(items.length / RECOVERY_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const pageStart = currentPage * RECOVERY_PAGE_SIZE
  const visibleItems = items.slice(pageStart, pageStart + RECOVERY_PAGE_SIZE)
  const settingsResult = settingsRecovery.status
  return (
    <>
      <PanelHeader
        title="Recovery"
        description="Resolve blocked downloads without guessing what ran."
      />
      <Section
        title="Blocked downloads"
        description="These records block another save of the same media until you resolve them."
      >
        {result === null ? (
          <FieldDescription>Checking transfer recovery…</FieldDescription>
        ) : result._tag === 'TransferRecoveryUnavailable' ? (
          <FieldDescription>Transfer recovery is unavailable. Try again later.</FieldDescription>
        ) : items.length === 0 ? (
          <FieldDescription>No blocked downloads.</FieldDescription>
        ) : (
          visibleItems.map((item) => (
            <Field key={item.id} orientation="horizontal" data-recovery-id={item.id}>
              <FieldContent>
                <FieldLabel>{label(item)}</FieldLabel>
                <FieldDescription className="font-mono">Media {item.id}</FieldDescription>
                <FieldDescription>
                  {item.kind === 'prepared-launch'
                    ? 'No download call ran. Forgetting marks any linked Clear request failed and removes this local transfer lock. Any queued cloud upload stays queued. For a multi-file save, forget every interrupted record for that save.'
                    : item.kind === 'forget-pending'
                      ? 'The prior close did not finish. Forget retries that same close. It does not start another download.'
                      : 'May still run or have written files. Forgetting only removes this transfer record. It never cancels aria2, deletes files, or clears the post.'}
                </FieldDescription>
              </FieldContent>
              <ConfirmStrip
                sentence={
                  item.kind === 'prepared-launch'
                    ? 'Type FORGET to close this interrupted setup. Then save again from the post.'
                    : item.kind === 'forget-pending'
                      ? 'Type FORGET to retry closing this transfer record.'
                      : 'Type FORGET to remove this uncertain record. Then save again from the post.'
                }
                confirmLabel="Forget record"
                kind="one-shot"
                typedWord="FORGET"
                onConfirm={() => void runRequest('forget', item.id)}
              >
                {(arm) => (
                  <button
                    type="button"
                    disabled={requestPending}
                    onClick={arm}
                    className="shrink-0 rounded-sm text-[13px] text-destructive outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {pendingForgetId === item.id ? 'Forgetting…' : 'Forget…'}
                  </button>
                )}
              </ConfirmStrip>
            </Field>
          ))
        )}
        {items.length > RECOVERY_PAGE_SIZE && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>
                Page {currentPage + 1} of {pageCount}
              </FieldLabel>
              <FieldDescription className="font-mono tabular-nums">
                Showing {pageStart + 1}–{Math.min(pageStart + RECOVERY_PAGE_SIZE, items.length)} of{' '}
                {items.length} blocked downloads.
              </FieldDescription>
            </FieldContent>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={requestPending || currentPage === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={requestPending || currentPage + 1 >= pageCount}
                onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              >
                Next
              </Button>
            </div>
          </Field>
        )}
      </Section>
      <Section
        title="Settings recovery"
        description="Corrupt or newer Settings stay untouched until you confirm a repair."
      >
        {settingsRecovery.loading && settingsResult === null ? (
          <FieldDescription>Checking Settings data…</FieldDescription>
        ) : settingsRecovery.failure !== null ? (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Settings recovery unavailable</FieldLabel>
              <FieldDescription>
                {settingsRecovery.failure.reason === 'stale-snapshot'
                  ? 'Settings changed after this check. Check again before acting.'
                  : 'Settings could not be checked. Try again.'}
              </FieldDescription>
            </FieldContent>
            <button
              type="button"
              onClick={() => void refreshSettings()}
              className="shrink-0 rounded-sm text-[13px] outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Check again
            </button>
          </Field>
        ) : settingsResult === null ? (
          <FieldDescription>Settings recovery is unavailable. Try again.</FieldDescription>
        ) : settingsResult.kind === 'healthy' ? (
          <FieldDescription>Settings data is healthy.</FieldDescription>
        ) : (
          <Field>
            <FieldContent>
              <FieldLabel>
                {settingsResult.kind === 'recoverable'
                  ? 'Settings need repair'
                  : 'Settings cannot be read safely'}
              </FieldLabel>
              <FieldDescription>
                Local saves use safe Direct mode. Cloud upload, Cloud Sync, Clear, and Capture
                Mirror stay paused until recovery.
              </FieldDescription>
              {recoveryKeys(settingsResult) !== '' && (
                <FieldDescription className="font-mono">
                  Fields: {recoveryKeys(settingsResult)}
                </FieldDescription>
              )}
            </FieldContent>
            <div className="flex flex-wrap items-start justify-end gap-3">
              {settingsResult.kind === 'recoverable' && (
                <ConfirmStrip
                  sentence="Repair keeps valid Settings, defaults invalid fields, and removes unknown fields."
                  confirmLabel="Repair Settings"
                  kind="one-shot"
                  typedWord="REPAIR"
                  onConfirm={() => void recoverSettings('repair', settingsResult.fingerprint)}
                >
                  {(arm) => (
                    <button
                      type="button"
                      onClick={arm}
                      className="rounded-sm text-[13px] outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      Repair…
                    </button>
                  )}
                </ConfirmStrip>
              )}
              <ConfirmStrip
                sentence="Reset replaces all stored Settings with defaults."
                confirmLabel="Reset Settings"
                kind="one-shot"
                typedWord="RESET"
                onConfirm={() => void recoverSettings('reset', settingsResult.fingerprint)}
              >
                {(arm) => (
                  <button
                    type="button"
                    onClick={arm}
                    className="rounded-sm text-[13px] text-destructive outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    Reset…
                  </button>
                )}
              </ConfirmStrip>
            </div>
          </Field>
        )}
      </Section>
    </>
  )
}
