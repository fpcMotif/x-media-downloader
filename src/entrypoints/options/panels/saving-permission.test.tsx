import { render, type ComponentChildren } from 'preact'
import { act } from 'preact/test-utils'
import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '@/core/schema'
import { SavingPanel } from './saving'

vi.mock('@/components/ui/toggle-group', () => ({
  ToggleGroup: ({ children }: { readonly children: ComponentChildren }) => <div>{children}</div>,
  ToggleGroupItem: ({ children }: { readonly children: ComponentChildren }) => (
    <button>{children}</button>
  ),
}))
vi.mock('@/components/ui/field', () => ({
  Field: ({ children }: { readonly children: ComponentChildren }) => <div>{children}</div>,
  FieldContent: ({ children }: { readonly children: ComponentChildren }) => <div>{children}</div>,
  FieldDescription: ({ children }: { readonly children: ComponentChildren }) => <p>{children}</p>,
  FieldLabel: ({ children }: { readonly children: ComponentChildren }) => <label>{children}</label>,
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { readonly children: ComponentChildren }) => <div>{children}</div>,
  SelectContent: ({ children }: { readonly children: ComponentChildren }) => <div>{children}</div>,
  SelectGroup: ({ children }: { readonly children: ComponentChildren }) => <div>{children}</div>,
  SelectItem: ({ children }: { readonly children: ComponentChildren }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { readonly children: ComponentChildren }) => <div>{children}</div>,
  SelectValue: () => null,
}))
vi.mock('@/components/ui/input', () => ({ Input: () => <input /> }))
vi.mock('@/components/ui/switch', () => ({ Switch: () => <input /> }))
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
  }: {
    readonly children: ComponentChildren
    readonly onClick?: () => void
  }) => <button onClick={onClick}>{children}</button>,
}))
vi.mock('@/components/icons', () => ({ EraserIcon: () => null }))
vi.mock('../ui', () => ({
  PanelHeader: () => null,
  Section: ({ children }: { readonly children: ComponentChildren }) => (
    <section>{children}</section>
  ),
}))

const originalPermissionContains = browser.permissions.contains
const originalPermissionRequest = browser.permissions.request

const deferred = <A,>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('SavingPanel aria2 permission', () => {
  let host: HTMLDivElement | undefined

  afterEach(() => {
    browser.permissions.contains = originalPermissionContains
    browser.permissions.request = originalPermissionRequest
    if (host !== undefined) {
      render(null, host)
      host.remove()
    }
    host = undefined
    vi.clearAllMocks()
  })

  const mount = async (initial: Record<string, unknown>) => {
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)
    const rerender = async (settings: Record<string, unknown>) => {
      await act(async () => {
        render(
          <SavingPanel
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

  it('ignores stale A access while B permission remains pending', async () => {
    const originA = deferred<boolean>()
    const originB = deferred<boolean>()
    browser.permissions.contains = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(originA.promise)
      .mockReturnValueOnce(originB.promise) as typeof browser.permissions.contains
    const { panel, rerender } = await mount({
      downloadStrategy: 'aria2',
      aria2RpcUrl: 'http://a.example/jsonrpc',
    })

    await rerender({
      downloadStrategy: 'aria2',
      aria2RpcUrl: 'http://b.example/jsonrpc',
    })

    expect(panel.textContent).not.toContain('localhost access granted')
    expect(panel.textContent).not.toContain('Grant localhost access')

    await act(async () => {
      originA.resolve(true)
      await Promise.resolve()
    })

    expect(panel.textContent).not.toContain('localhost access granted')
    expect(panel.textContent).not.toContain('Grant localhost access')

    await act(async () => {
      originB.resolve(false)
      await Promise.resolve()
    })

    expect(panel.textContent).toContain('Grant localhost access')
    expect(panel.textContent).not.toContain('localhost access granted')
  })

  it('maps a current permission-request rejection to denied access', async () => {
    browser.permissions.contains = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
    browser.permissions.request = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValue(
        new Error('permission request failed'),
      ) as typeof browser.permissions.request
    const { panel } = await mount({
      downloadStrategy: 'aria2',
      aria2RpcUrl: 'http://localhost:6800/jsonrpc',
    })
    await act(async () => {
      await Promise.resolve()
    })
    const button = [...panel.querySelectorAll('button')].find(
      (node) => node.textContent === 'Grant localhost access',
    )
    expect(button).toBeInstanceOf(HTMLButtonElement)
    const grantButton = button as HTMLButtonElement

    await act(async () => {
      grantButton.click()
      await Promise.resolve()
    })

    expect(panel.textContent).toContain('Grant localhost access')
    expect(panel.textContent).not.toContain('localhost access granted')
  })
})
