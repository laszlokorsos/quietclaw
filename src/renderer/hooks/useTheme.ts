import { useState, useEffect, useCallback } from 'react'

const api = (window as any).quietclaw

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

function applyTheme(resolved: ResolvedTheme) {
  if (resolved === 'dark') {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>('dark')
  const [resolved, setResolved] = useState<ResolvedTheme>('dark')

  useEffect(() => {
    if (!api) return
    api.theme.get().then((result: { preference: ThemePreference; resolved: ResolvedTheme }) => {
      setPreference(result.preference)
      setResolved(result.resolved)
      applyTheme(result.resolved)
    })

    const unsub = api.on('theme-changed', (newResolved: ResolvedTheme) => {
      setResolved(newResolved)
      applyTheme(newResolved)
    })
    return unsub
  }, [])

  const setTheme = useCallback(async (newPreference: ThemePreference) => {
    if (!api) return
    const result = await api.theme.set(newPreference)
    setPreference(result.preference)
    setResolved(result.resolved)
    applyTheme(result.resolved)
  }, [])

  return { preference, resolved, setTheme }
}
