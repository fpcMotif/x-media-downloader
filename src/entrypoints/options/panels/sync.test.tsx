import { render } from 'preact'
import { act } from 'preact/test-utils'
import { Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '@/core/schema'
import { SyncPanel } from './sync'

const originalSendMessage = browser.runtime.sendMessage
const originalPermissionRequest = browser.permissions.request
const originalPermissionContains = browser.permissions.contains

const deferred = <A,>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const disconnectButton = (panel: HTMLDivElement): HTMLButtonElement => {
  const button = [...panel.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('Disconnect'),
  )
  expect(button).toBeInstanceOf(HTMLButtonElement)
  return button as HTMLButtonElement
}

const buttonNamed = (panel: HTMLDivElement, name: string): HTMLButtonElement => {
  const button = [...panel.querySelectorAll('button')].find((node) => node.textContent === name)
  expect(button).toBeInstanceOf(HTMLButtonElement)
  return button as HTMLButtonElement
}

const click = async (button: HTMLButtonElement): Promise<void> => {
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('SyncPanel disconnect', () => {
  let host: HTMLDivElement | undefined

  beforeEach(() => {
    browser.permissions.contains = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
  })

  afterEach(() => {
    browser.runtime.sendMessage = originalSendMessage
    browser.permissions.request = originalPermissionRequest
    browser.permissions.contains = originalPermissionContains
    if (host !== undefined) {
      render(null, host)
      host.remove()
    }
    host = undefined
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  const mount = async (disconnect: () => unknown) => {
    const reload = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const send = vi.fn<(message: { _tag: string }) => unknown>((message) => {
      if (message._tag === 'CloudDisconnectRequest') return disconnect()
      if (message._tag === 'CloudStatusRequest') return Promise.resolve(null)
      return Promise.resolve(undefined)
    })
    browser.runtime.sendMessage = send as unknown as typeof browser.runtime.sendMessage
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)
    await act(async () => {
      render(
        <SyncPanel
          settings={Schema.decodeUnknownSync(Settings)({
            cloudUploadEnabled: true,
            gdriveClientId: 'client-id',
            gdriveRefreshToken: 'refresh-token',
          })}
          update={async () => {}}
          reload={reload}
        />,
        panel,
      )
    })
    return { panel, reload, send }
  }

  const disconnect = async (panel: HTMLDivElement): Promise<void> => {
    await act(async () => {
      disconnectButton(panel).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  const mountCloud = async (
    settings: Record<string, unknown>,
    replies: {
      readonly connect?: () => unknown
      readonly backfill?: () => unknown
    },
  ) => {
    const reload = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const send = vi.fn<(message: { _tag: string }) => unknown>((message) => {
      if (message._tag === 'CloudConnectRequest') return replies.connect?.()
      if (message._tag === 'CloudBackfillRequest') return replies.backfill?.()
      if (message._tag === 'CloudStatusRequest') return Promise.resolve(null)
      return Promise.resolve(undefined)
    })
    browser.runtime.sendMessage = send as unknown as typeof browser.runtime.sendMessage
    browser.permissions.request = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)
    await act(async () => {
      render(
        <SyncPanel
          settings={Schema.decodeUnknownSync(Settings)({ cloudUploadEnabled: true, ...settings })}
          update={async () => {}}
          reload={reload}
        />,
        panel,
      )
    })
    return { panel, reload }
  }

  const mountStatusPanel = async (
    send: (message: { _tag: string }) => unknown,
    initial: Record<string, unknown>,
  ) => {
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)
    browser.runtime.sendMessage = send as unknown as typeof browser.runtime.sendMessage
    const rerender = async (settings: Record<string, unknown>) => {
      await act(async () => {
        render(
          <SyncPanel
            settings={Schema.decodeUnknownSync(Settings)(settings)}
            update={async () => {}}
            reload={async () => {}}
          />,
          panel,
        )
      })
    }
    await rerender(initial)
    return { panel, rerender }
  }

  it('shows success only for the exact acknowledged reply', async () => {
    const { panel, reload } = await mount(() => Promise.resolve({ ok: true }))

    await disconnect(panel)

    expect(reload).toHaveBeenCalledOnce()
    expect(panel.textContent).toContain('Disconnected Google Drive.')
  })

  it.each([
    ['negative reply', () => Promise.resolve({ ok: false })],
    ['router failure', () => Promise.resolve({ ok: false, error: 'handler failed' })],
    ['malformed reply', () => Promise.resolve({ ok: true, extra: 'unexpected' })],
    ['unclaimed reply', () => Promise.resolve(undefined)],
    [
      'synchronous throw',
      () => {
        throw new Error('no receiver')
      },
    ],
    ['rejection', () => Promise.reject(new Error('port closed'))],
  ])('shows failure and reloads after a %s', async (_name, outcome) => {
    const { panel, reload } = await mount(outcome)

    await disconnect(panel)

    expect(reload).toHaveBeenCalledOnce()
    expect(panel.textContent).toContain('Could not disconnect Google Drive. Try again.')
  })

  it('blocks duplicate disconnect while the provider is pending', async () => {
    let finish: ((reply: { ok: true }) => void) | undefined
    const { panel, reload, send } = await mount(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const button = disconnectButton(panel)

    await act(async () => {
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Disconnecting…')
    expect(
      [...panel.querySelectorAll('button')].find((node) => node.textContent === 'Reconnect')
        ?.disabled,
    ).toBe(true)
    button.click()
    expect(
      send.mock.calls.filter(
        ([message]) => (message as { _tag?: string })._tag === 'CloudDisconnectRequest',
      ),
    ).toHaveLength(1)

    await act(async () => {
      finish?.({ ok: true })
    })
    expect(reload).toHaveBeenCalledOnce()
  })

  it('renders OAuth detail only from an exact claimed reply', async () => {
    const { panel, reload } = await mountCloud(
      { gdriveClientId: 'client-id' },
      { connect: () => Promise.resolve({ ok: true, detail: 'Connected Google Drive.' }) },
    )

    await click(buttonNamed(panel, 'Connect'))

    expect(reload).toHaveBeenCalledOnce()
    expect(panel.textContent).toContain('Connected Google Drive.')
  })

  it('does not render malformed OAuth or backfill detail', async () => {
    const { panel } = await mountCloud(
      { gdriveClientId: 'client-id', gdriveRefreshToken: 'refresh-token' },
      {
        connect: () => Promise.resolve({ ok: false, detail: 'Forged OAuth detail.', stale: true }),
        backfill: () => Promise.resolve({ detail: 'Forged backfill detail.' }),
      },
    )

    await click(buttonNamed(panel, 'Reconnect'))
    expect(panel.textContent).toContain('The extension background did not respond.')
    expect(panel.textContent).not.toContain('Forged OAuth detail.')

    await click(buttonNamed(panel, 'Back up past downloads'))
    expect(panel.textContent).toContain('The extension background did not respond.')
    expect(panel.textContent).not.toContain('Forged backfill detail.')
  })

  it('does not let a pre-toggle sync poll overwrite the fresh remount', async () => {
    const stale = deferred<unknown>()
    const fresh = deferred<unknown>()
    let polls = 0
    const { panel, rerender } = await mountStatusPanel(
      (message) => {
        if (message._tag === 'SyncStatusRequest')
          return polls++ === 0 ? stale.promise : fresh.promise
        return Promise.resolve(null)
      },
      { cloudSyncEnabled: true },
    )

    await rerender({ cloudSyncEnabled: false })
    await rerender({ cloudSyncEnabled: true })

    await act(async () => {
      fresh.resolve({ ok: true, detail: 'Fresh sync status.', pending: 0 })
      await Promise.resolve()
    })
    await act(async () => {
      stale.resolve({ ok: false, detail: 'Stale sync status.', pending: 1 })
      await Promise.resolve()
    })

    expect(panel.textContent).toContain('Fresh sync status.')
    expect(panel.textContent).not.toContain('Stale sync status.')
  })

  it('does not let a pre-toggle upload poll overwrite the fresh remount', async () => {
    const stale = deferred<unknown>()
    const fresh = deferred<unknown>()
    let polls = 0
    const { panel, rerender } = await mountStatusPanel(
      (message) => {
        if (message._tag === 'CloudStatusRequest')
          return polls++ === 0 ? stale.promise : fresh.promise
        return Promise.resolve(null)
      },
      { cloudUploadEnabled: true },
    )

    await rerender({ cloudUploadEnabled: false })
    await rerender({ cloudUploadEnabled: true })

    await act(async () => {
      fresh.resolve({
        summary: { pending: 0, uploading: 0, succeeded: 0, failed: 0, dead: 0, skipped: 0 },
        lastError: 'Fresh upload status.',
      })
      await Promise.resolve()
    })
    await act(async () => {
      stale.resolve({
        summary: { pending: 0, uploading: 0, succeeded: 0, failed: 0, dead: 0, skipped: 0 },
        lastError: 'Stale upload status.',
      })
      await Promise.resolve()
    })

    expect(panel.textContent).toContain('Fresh upload status.')
    expect(panel.textContent).not.toContain('Stale upload status.')
  })

  it('waits for each upload poll to finish and stops after unmount', async () => {
    vi.useFakeTimers()
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    let polls = 0
    const send = vi.fn<(message: { _tag: string }) => Promise<unknown>>((message) => {
      if (message._tag !== 'CloudStatusRequest') return Promise.resolve(null)
      return polls++ === 0 ? first.promise : second.promise
    })
    const { panel } = await mountStatusPanel(send, { cloudUploadEnabled: true })
    const status = {
      summary: { pending: 0, uploading: 0, succeeded: 0, failed: 0, dead: 0, skipped: 0 },
      lastError: null,
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(
      send.mock.calls.filter(([message]) => message._tag === 'CloudStatusRequest'),
    ).toHaveLength(1)

    await act(async () => {
      first.resolve(status)
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999)
    })
    expect(
      send.mock.calls.filter(([message]) => message._tag === 'CloudStatusRequest'),
    ).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(
      send.mock.calls.filter(([message]) => message._tag === 'CloudStatusRequest'),
    ).toHaveLength(2)

    await act(async () => {
      render(null, panel)
      second.resolve(status)
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(
      send.mock.calls.filter(([message]) => message._tag === 'CloudStatusRequest'),
    ).toHaveLength(2)
  })

  it('drops a Convex test reply after its settings change', async () => {
    const test = deferred<unknown>()
    const { panel, rerender } = await mountStatusPanel(
      (message) => (message._tag === 'SyncTestRequest' ? test.promise : Promise.resolve(null)),
      {
        cloudSyncEnabled: true,
        convexUrl: 'https://old.convex.cloud',
        convexSyncSecret: 'old',
      },
    )

    await click(buttonNamed(panel, 'Test connection'))
    await rerender({
      cloudSyncEnabled: true,
      convexUrl: 'https://new.convex.cloud',
      convexSyncSecret: 'new',
    })
    await act(async () => {
      test.resolve({ ok: false, detail: 'Old deployment failed.', pending: 0 })
      await Promise.resolve()
    })

    expect(panel.textContent).not.toContain('Old deployment failed.')
  })

  it('keeps the latest provider result in the shared notice', async () => {
    const drive = deferred<unknown>()
    const dropbox = deferred<unknown>()
    browser.permissions.request = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
    const { panel } = await mountStatusPanel(
      (message) => {
        if (message._tag !== 'CloudConnectRequest') return Promise.resolve(null)
        return (message as unknown as { readonly provider: string }).provider === 'gdrive'
          ? drive.promise
          : dropbox.promise
      },
      {
        cloudUploadEnabled: true,
        gdriveClientId: 'drive-client',
        dropboxClientId: 'dropbox-client',
      },
    )
    const connect = [...panel.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Connect',
    )

    await click(connect[0]!)
    await click(connect[1]!)
    await act(async () => {
      dropbox.resolve({ ok: true, detail: 'Dropbox connected.' })
      await Promise.resolve()
    })
    await act(async () => {
      drive.resolve({ ok: true, detail: 'Drive connected.' })
      await Promise.resolve()
    })

    expect(panel.textContent).toContain('Dropbox connected.')
    expect(panel.textContent).not.toContain('Drive connected.')
  })

  it('keeps only the current origin permission result', async () => {
    const oldOrigin = deferred<boolean>()
    const newOrigin = deferred<boolean>()
    browser.permissions.contains = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(oldOrigin.promise)
      .mockReturnValueOnce(newOrigin.promise) as typeof browser.permissions.contains
    const { panel, rerender } = await mountStatusPanel(() => Promise.resolve(null), {
      cloudSyncEnabled: true,
      convexUrl: 'https://old.convex.cloud',
      convexSyncSecret: 'x',
    })
    await rerender({
      cloudSyncEnabled: true,
      convexUrl: 'https://new.convex.cloud',
      convexSyncSecret: 'x',
    })
    await act(async () => {
      newOrigin.resolve(true)
      await Promise.resolve()
    })
    await act(async () => {
      oldOrigin.resolve(false)
      await Promise.resolve()
    })

    expect(panel.textContent).toContain('access granted')
    expect(panel.textContent).not.toContain('Grant access')
  })

  it('clears A access while B permission remains pending', async () => {
    const oldOrigin = deferred<boolean>()
    const newOrigin = deferred<boolean>()
    browser.permissions.contains = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(oldOrigin.promise)
      .mockReturnValueOnce(newOrigin.promise) as typeof browser.permissions.contains
    const { panel, rerender } = await mountStatusPanel(() => Promise.resolve(null), {
      cloudSyncEnabled: true,
      convexUrl: 'https://old.convex.cloud',
      convexSyncSecret: 'x',
    })
    await act(async () => {
      oldOrigin.resolve(true)
      await Promise.resolve()
    })
    expect(panel.textContent).toContain('access granted')

    await rerender({
      cloudSyncEnabled: true,
      convexUrl: 'https://new.convex.cloud',
      convexSyncSecret: 'x',
    })

    expect(panel.textContent).not.toContain('access granted')
    expect(panel.textContent).not.toContain('Grant access')
  })

  it('clears access when the deployment URL is blank', async () => {
    browser.permissions.contains = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
    const { panel, rerender } = await mountStatusPanel(() => Promise.resolve(null), {
      cloudSyncEnabled: true,
      convexUrl: 'https://old.convex.cloud',
      convexSyncSecret: 'x',
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(panel.textContent).toContain('access granted')

    await rerender({ cloudSyncEnabled: true, convexUrl: '', convexSyncSecret: 'x' })

    expect(panel.textContent).not.toContain('access granted')
    expect(panel.textContent).not.toContain('Grant access')
  })

  it('maps a current permission rejection to denied access', async () => {
    browser.permissions.contains = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValue(
        new Error('permission probe failed'),
      ) as typeof browser.permissions.contains
    const { panel } = await mountStatusPanel(() => Promise.resolve(null), {
      cloudSyncEnabled: true,
      convexUrl: 'https://old.convex.cloud',
      convexSyncSecret: 'x',
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(panel.textContent).toContain('Grant access')
    expect(panel.textContent).not.toContain('access granted')
  })

  it('maps a current permission-request rejection to denied access', async () => {
    browser.permissions.contains = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
    browser.permissions.request = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValue(
        new Error('permission request failed'),
      ) as typeof browser.permissions.request
    const { panel } = await mountStatusPanel(() => Promise.resolve(null), {
      cloudSyncEnabled: true,
      convexUrl: 'https://old.convex.cloud',
      convexSyncSecret: 'x',
    })
    await act(async () => {
      await Promise.resolve()
    })
    await click(buttonNamed(panel, 'Grant access'))

    expect(panel.textContent).toContain('Grant access')
    expect(panel.textContent).not.toContain('access granted')
  })
})
