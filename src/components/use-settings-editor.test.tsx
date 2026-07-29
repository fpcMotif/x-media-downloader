import { render } from 'preact'
import { act } from 'preact/test-utils'
import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '@/core/schema'
import {
  useSettingsEditor,
  type SettingsEditor,
  type SettingsEditorDeps,
} from './use-settings-editor'

const settings = Schema.decodeUnknownSync(Settings)({})

const deferred = <A,>() => {
  let resolve!: (value: A) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<A>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const withTemplate = (filenameTemplate: string): Settings => ({ ...settings, filenameTemplate })

function Editor({
  deps,
  onEditor,
}: {
  readonly deps: SettingsEditorDeps
  readonly onEditor?: (editor: SettingsEditor) => void
}) {
  const editor = useSettingsEditor(deps)
  onEditor?.(editor)
  return (
    <>
      <output data-testid="load">{editor.load.status}</output>
      <output data-testid="notice">{editor.notice}</output>
      <output data-testid="template">{editor.load.settings?.filenameTemplate ?? ''}</output>
      <button type="button" onClick={() => void editor.reload()}>
        Retry
      </button>
    </>
  )
}

describe('useSettingsEditor', () => {
  let host: HTMLDivElement | undefined

  afterEach(() => {
    vi.useRealTimers()
    if (host !== undefined) {
      render(null, host)
      host.remove()
    }
    host = undefined
  })

  it('shows unavailable after a failed bootstrap and recovers on retry', async () => {
    let attempts = 0
    const read = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('storage unavailable')
      return settings
    }
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(<Editor deps={{ read, successMs: 1 }} />, panel)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(panel.querySelector('[data-testid="load"]')?.textContent).toBe('unavailable')

    await act(async () => {
      ;[...panel.querySelectorAll('button')][0]?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(panel.querySelector('[data-testid="load"]')?.textContent).toBe('ready')
  })

  it('does not let a stale reload overwrite a newer write', async () => {
    const pendingReload = deferred<Settings>()
    let reads = 0
    let editor: SettingsEditor | undefined
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <Editor
          deps={{
            read: async () => (reads++ === 0 ? settings : pendingReload.promise),
            write: async () => withTemplate('newer'),
            successMs: 1,
          }}
          onEditor={(next) => {
            editor = next
          }}
        />,
        panel,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    let reload!: Promise<void>
    let write!: Promise<void>
    await act(async () => {
      reload = editor?.reload() as Promise<void>
      write = editor?.update({ filenameTemplate: 'newer' }) as Promise<void>
      await write
    })
    expect(panel.querySelector('[data-testid="template"]')?.textContent).toBe('newer')

    await act(async () => {
      pendingReload.resolve(withTemplate('stale'))
      await reload
    })
    expect(panel.querySelector('[data-testid="template"]')?.textContent).toBe('newer')
  })

  it('does not let an older write overwrite a newer write', async () => {
    const first = deferred<Settings>()
    const second = deferred<Settings>()
    let writes = 0
    let editor: SettingsEditor | undefined
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <Editor
          deps={{
            read: async () => settings,
            write: async () => (writes++ === 0 ? first.promise : second.promise),
            successMs: 1,
          }}
          onEditor={(next) => {
            editor = next
          }}
        />,
        panel,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const older = editor?.update({ filenameTemplate: 'older' }) as Promise<void>
    const newer = editor?.update({ filenameTemplate: 'newer' }) as Promise<void>
    await act(async () => {
      first.resolve(withTemplate('older'))
      await older
    })
    expect(panel.querySelector('[data-testid="template"]')?.textContent).toBe(
      settings.filenameTemplate,
    )

    await act(async () => {
      second.resolve(withTemplate('newer'))
      await newer
    })
    expect(panel.querySelector('[data-testid="template"]')?.textContent).toBe('newer')
  })

  it('keeps an external canonical publication over a delayed local write result', async () => {
    const localResult = deferred<Settings>()
    let reads = 0
    let publish: (() => void) | undefined
    let editor: SettingsEditor | undefined
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <Editor
          deps={{
            read: async () => (reads++ === 0 ? settings : withTemplate('S2')),
            write: async () => localResult.promise,
            subscribe: (onChange) => {
              publish = onChange
              return () => undefined
            },
            successMs: 1,
          }}
          onEditor={(next) => {
            editor = next
          }}
        />,
        panel,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const local = editor?.update({ filenameTemplate: 'S1' }) as Promise<void>
    await act(async () => {
      publish?.()
      await Promise.resolve()
    })
    expect(panel.querySelector('[data-testid="template"]')?.textContent).toBe('S2')

    await act(async () => {
      localResult.resolve(withTemplate('S1'))
      await local
    })
    expect(panel.querySelector('[data-testid="template"]')?.textContent).toBe('S2')
  })

  it('clears a saved notice when a canonical publication supersedes its timer', async () => {
    vi.useFakeTimers()
    let reads = 0
    let publish: (() => void) | undefined
    let editor: SettingsEditor | undefined
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <Editor
          deps={{
            read: async () => (reads++ === 0 ? settings : withTemplate('canonical')),
            write: async () => withTemplate('local'),
            subscribe: (onChange) => {
              publish = onChange
              return () => undefined
            },
            successMs: 100,
          }}
          onEditor={(next) => {
            editor = next
          }}
        />,
        panel,
      )
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    await act(async () => {
      await editor?.update({ filenameTemplate: 'local' })
    })
    expect(panel.querySelector('[data-testid="notice"]')?.textContent).toBe('saved')

    await act(async () => {
      publish?.()
      await Promise.resolve()
    })
    expect(panel.querySelector('[data-testid="notice"]')?.textContent).toBe('idle')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(panel.querySelector('[data-testid="notice"]')?.textContent).toBe('idle')
  })

  it('re-reads the committed state when the newer write fails', async () => {
    const olderWrite = deferred<Settings>()
    const newerWrite = deferred<Settings>()
    let writes = 0
    let reads = 0
    let editor: SettingsEditor | undefined
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <Editor
          deps={{
            read: async () => (reads++ === 0 ? settings : withTemplate('committed')),
            write: async () => (writes++ === 0 ? olderWrite.promise : newerWrite.promise),
            successMs: 1,
          }}
          onEditor={(next) => {
            editor = next
          }}
        />,
        panel,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const older = editor?.update({ filenameTemplate: 'committed' }) as Promise<void>
    const newer = editor?.update({ filenameTemplate: 'rejected' }) as Promise<void>
    await act(async () => {
      olderWrite.resolve(withTemplate('committed'))
      await older
    })
    expect(panel.querySelector('[data-testid="template"]')?.textContent).toBe(
      settings.filenameTemplate,
    )

    await act(async () => {
      newerWrite.reject(new Error('rejected'))
      await newer
    })
    expect(panel.querySelector('[data-testid="template"]')?.textContent).toBe('committed')
    expect(panel.querySelector('[data-testid="notice"]')?.textContent).toBe('failed')
  })

  it('does not let a stale reload overwrite a newer settings publication', async () => {
    const staleReload = deferred<Settings>()
    let reads = 0
    let publish: (() => void) | undefined
    let editor: SettingsEditor | undefined
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <Editor
          deps={{
            read: async () => {
              const read = reads++
              if (read === 0) return settings
              if (read === 1) return staleReload.promise
              return withTemplate('published')
            },
            subscribe: (onChange) => {
              publish = onChange
              return () => undefined
            },
            successMs: 1,
          }}
          onEditor={(next) => {
            editor = next
          }}
        />,
        panel,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const reload = editor?.reload() as Promise<void>
    await act(async () => {
      publish?.()
      await Promise.resolve()
    })
    expect(panel.querySelector('[data-testid="template"]')?.textContent).toBe('published')

    await act(async () => {
      staleReload.resolve(withTemplate('stale'))
      await reload
    })
    expect(panel.querySelector('[data-testid="template"]')?.textContent).toBe('published')
  })

  it('publishes only the latest canonical read when storage wakes reorder', async () => {
    const olderRead = deferred<Settings>()
    const newerRead = deferred<Settings>()
    let reads = 0
    let publish: (() => void) | undefined
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <Editor
          deps={{
            read: async () => {
              const read = reads++
              if (read === 0) return settings
              return read === 1 ? olderRead.promise : newerRead.promise
            },
            subscribe: (onChange) => {
              publish = onChange
              return () => undefined
            },
            successMs: 1,
          }}
        />,
        panel,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      publish?.()
      publish?.()
    })
    await act(async () => {
      newerRead.resolve(withTemplate('newer'))
      await newerRead.promise
    })
    await act(async () => {
      olderRead.resolve(withTemplate('older'))
      await olderRead.promise
    })

    expect(panel.querySelector('[data-testid="template"]')?.textContent).toBe('newer')
  })

  it('unsubscribes when unmounted', async () => {
    let unsubscribeCalls = 0
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <Editor
          deps={{
            read: async () => settings,
            subscribe: () => () => {
              unsubscribeCalls += 1
            },
            successMs: 1,
          }}
        />,
        panel,
      )
    })
    await act(async () => {
      render(null, panel)
    })

    expect(unsubscribeCalls).toBe(1)
  })
})
