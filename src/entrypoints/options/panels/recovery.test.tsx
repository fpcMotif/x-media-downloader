import { render } from 'preact'
import { act } from 'preact/test-utils'
import { useMemo } from 'preact/hooks'
import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Settings } from '@/core/schema'
import {
  initialSettingsRecoveryState,
  OptionsSettingsRecoveryContext,
} from '../settings-recovery-context'
import { RecoveryPanel } from './recovery'

const source = readFileSync('src/entrypoints/options/panels/recovery.tsx', 'utf8')
const originalSendMessage = browser.runtime.sendMessage

const deferred = <A,>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const recoveryItem = (index: number) => ({
  id: `request-${index}`,
  kind: 'unresolved-launch' as const,
  mode: 'direct' as const,
  createdAt: index,
})

function RecoveryHarness({ refresh }: { readonly refresh: () => Promise<void> }) {
  const controller = useMemo(
    () => ({
      state: initialSettingsRecoveryState,
      refresh,
      recover: async () => {},
    }),
    [refresh],
  )
  return (
    <OptionsSettingsRecoveryContext.Provider value={controller}>
      <RecoveryPanel
        settings={Schema.decodeUnknownSync(Settings)({})}
        update={async () => {}}
        reload={async () => {}}
      />
    </OptionsSettingsRecoveryContext.Provider>
  )
}

describe('RecoveryPanel', () => {
  it('requires typed FORGET and offers no retry action', () => {
    expect(source).toContain('typedWord="FORGET"')
    expect(source).toMatch(/runRequest\(["']forget["'], item\.id\)/)
    expect(source).not.toMatch(/action:\s*["']retry["']/)
    expect(source).toMatch(/It never cancels aria2, deletes files,\s*or clears the post\./)
    expect(source).toContain('No download call ran.')
    expect(source).toContain('Any queued cloud upload stays queued.')
    expect(source).toContain('forget every interrupted record for that save.')
    expect(source).toContain('Transfer close pending')
    expect(source).toContain('Forget retries that same close.')
    expect(source).toContain('Resolve blocked downloads')
    expect(source).toContain('No blocked downloads.')
  })

  it('warns about the safe projection and requires typed Settings recovery', () => {
    expect(source).toContain('typedWord="REPAIR"')
    expect(source).toContain('typedWord="RESET"')
    expect(source).toMatch(
      /Local saves use safe Direct mode\. Cloud upload, Cloud Sync, Clear, and Capture\s*Mirror stay paused until recovery\./,
    )
    expect(source).toMatch(/recoverSettings\(['"]repair['"], settingsResult\.fingerprint\)/)
    expect(source).toMatch(/recoverSettings\(['"]reset['"], settingsResult\.fingerprint\)/)
    expect(source).toContain('useOptionsSettingsRecovery')
  })
})

describe('RecoveryPanel lifecycle', () => {
  let host: HTMLDivElement | undefined

  afterEach(() => {
    browser.runtime.sendMessage = originalSendMessage
    if (host !== undefined) {
      render(null, host)
      host.remove()
    }
    host = undefined
    vi.clearAllMocks()
  })

  const draw = async (refresh: () => Promise<void>) => {
    const panel = host ?? document.createElement('div')
    if (host === undefined) {
      host = panel
      document.body.append(panel)
    }
    await act(async () => {
      render(<RecoveryHarness refresh={refresh} />, panel)
      await Promise.resolve()
    })
    return panel
  }

  it('mounts at most one page of a 5000-row recovery ledger', async () => {
    const items = Array.from({ length: 5_000 }, (_, index) => recoveryItem(index))
    browser.runtime.sendMessage = vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve({ _tag: 'TransferRecovery', items }),
    ) as unknown as typeof browser.runtime.sendMessage
    const panel = await draw(vi.fn<() => Promise<void>>().mockResolvedValue(undefined))

    await vi.waitFor(() => {
      expect(panel.querySelectorAll('[data-recovery-id]')).toHaveLength(25)
    })
    expect(panel.querySelector('[data-recovery-id]')?.getAttribute('data-recovery-id')).toBe(
      'request-0',
    )
    expect(panel.textContent).toContain('Page 1 of 200')

    const next = [...panel.querySelectorAll('button')].find(
      (button) => button.textContent === 'Next',
    )
    expect(next).toBeInstanceOf(HTMLButtonElement)
    await act(async () => {
      next?.click()
    })

    expect(panel.querySelectorAll('[data-recovery-id]')).toHaveLength(25)
    expect(panel.querySelector('[data-recovery-id]')?.getAttribute('data-recovery-id')).toBe(
      'request-25',
    )
    expect(panel.textContent).toContain('Page 2 of 200')
  })

  it('rejects an old inspect reply after the effect restarts', async () => {
    const stale = deferred<unknown>()
    const fresh = deferred<unknown>()
    let requests = 0
    browser.runtime.sendMessage = vi.fn<() => Promise<unknown>>(() =>
      requests++ === 0 ? stale.promise : fresh.promise,
    ) as unknown as typeof browser.runtime.sendMessage

    await draw(vi.fn<() => Promise<void>>().mockResolvedValue(undefined))
    const panel = await draw(vi.fn<() => Promise<void>>().mockResolvedValue(undefined))
    expect(requests).toBe(2)

    await act(async () => {
      fresh.resolve({ _tag: 'TransferRecovery', items: [recoveryItem(2)] })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(panel.textContent).toContain('Media request-2')

    await act(async () => {
      stale.resolve({ _tag: 'TransferRecovery', items: [recoveryItem(1)] })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(panel.textContent).toContain('Media request-2')
    expect(panel.textContent).not.toContain('Media request-1')
  })
})
