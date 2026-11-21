import { useEffect, useState } from 'preact/hooks'
import type { Settings } from '@/packages/schema'

type Theme = Settings['theme']
type Scheme = 'light' | 'dark'

const STORAGE_KEY = 'xmd-color-scheme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

const metaContent = (theme: Theme): string => (theme === 'system' ? 'light dark' : theme)

const setMetaContent = (content: string): void => {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
  if (meta) meta.content = content
}

const persistIfStorageAllowed = (theme: Theme): void => {
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    return
  }
}

export function useColorScheme(theme: Theme | 'pending'): void {
  useEffect(() => {
    if (theme === 'pending') return
    setMetaContent(metaContent(theme))
    persistIfStorageAllowed(theme)
  }, [theme])

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== STORAGE_KEY) return
      const stored =
        event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : 'system'
      setMetaContent(metaContent(stored))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
}

export function useSystemScheme(): Scheme {
  const [scheme, setScheme] = useState<Scheme>(() =>
    window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light',
  )
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY)
    const onChange = (event: MediaQueryListEvent): void =>
      setScheme(event.matches ? 'dark' : 'light')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return scheme
}
