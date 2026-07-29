import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeClearScopeAttempt } from './clear-scope-attempt'

const article = (scope: 'bookmark' | 'like' | 'notInterested'): HTMLElement => {
  const element = document.createElement('article')
  element.dataset.testid = 'tweet'
  element.innerHTML = `
    <a href="/x/status/1"><time></time></a>
    <button data-testid="${
      scope === 'bookmark' ? 'removeBookmark' : scope === 'like' ? 'unlike' : 'caret'
    }"></button>
  `
  return element
}

const attempt = () => makeClearScopeAttempt({ document, wait: async () => {} })

describe('makeClearScopeAttempt', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('keeps pre-click exceptions retryable', async () => {
    const mounted = article('like')
    const control = mounted.querySelector<HTMLElement>('[data-testid="unlike"]')!
    document.body.append(mounted)
    vi.spyOn(control, 'closest').mockImplementation(() => {
      throw new Error('selector failed')
    })

    await expect(attempt()('1', 'like')).resolves.toBe('preflight-failed')
  })

  it('makes a throwing membership click uncertain', async () => {
    const mounted = article('like')
    const control = mounted.querySelector<HTMLElement>('[data-testid="unlike"]')!
    document.body.append(mounted)
    control.click = () => {
      throw new Error('click failed')
    }

    await expect(attempt()('1', 'like')).resolves.toBe('uncertain')
  })

  it('reports cleared only after a membership flip', async () => {
    const mounted = article('bookmark')
    const control = mounted.querySelector<HTMLElement>('[data-testid="removeBookmark"]')!
    document.body.append(mounted)
    control.click = () => control.remove()

    await expect(attempt()('1', 'bookmark')).resolves.toBe('cleared')
  })

  it('keeps caret-menu failures preflight until the destructive item click', async () => {
    const mounted = article('notInterested')
    const caret = mounted.querySelector<HTMLElement>('[data-testid="caret"]')!
    document.body.append(mounted)
    caret.click = () => {
      throw new Error('menu did not open')
    }

    await expect(attempt()('1', 'notInterested')).resolves.toBe('preflight-failed')
  })

  it('makes a throwing Not Interested item click uncertain', async () => {
    const mounted = article('notInterested')
    const caret = mounted.querySelector<HTMLElement>('[data-testid="caret"]')!
    document.body.append(mounted)
    caret.click = () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      const item = document.createElement('button')
      item.setAttribute('role', 'menuitem')
      item.textContent = 'Not interested in this post'
      item.click = () => {
        throw new Error('destructive click failed')
      }
      menu.append(item)
      document.body.append(menu)
    }

    await expect(attempt()('1', 'notInterested')).resolves.toBe('uncertain')
  })

  it('keeps verified clear when feedback cleanup throws', async () => {
    const cell = document.createElement('div')
    cell.dataset.testid = 'cellInnerDiv'
    const mounted = article('notInterested')
    const caret = mounted.querySelector<HTMLElement>('[data-testid="caret"]')!
    cell.append(mounted)
    document.body.append(cell)
    caret.click = () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      const item = document.createElement('button')
      item.setAttribute('role', 'menuitem')
      item.textContent = 'Not interested in this post'
      item.click = () => {
        caret.remove()
        const feedback = document.createElement('button')
        feedback.textContent = "This post isn't relevant"
        feedback.click = () => {
          throw new Error('cleanup click failed')
        }
        cell.append(feedback)
      }
      menu.append(item)
      document.body.append(menu)
    }

    await expect(attempt()('1', 'notInterested')).resolves.toBe('cleared')
  })
})
