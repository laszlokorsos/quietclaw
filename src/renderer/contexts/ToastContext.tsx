import { createContext, useContext, useState, useCallback } from 'react'

export interface Toast {
  id: string
  message: string
  variant: 'success' | 'error' | 'info'
}

interface ToastContextValue {
  toasts: Toast[]
  addToast: (message: string, variant?: Toast['variant']) => void
  removeToast: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const addToast = useCallback((message: string, variant: Toast['variant'] = 'success') => {
    const id = crypto.randomUUID()
    setToasts((prev) => {
      const next = [...prev, { id, message, variant }]
      return next.length > 5 ? next.slice(-5) : next
    })
    setTimeout(() => removeToast(id), 3000)
  }, [removeToast])

  return (
    <ToastContext value={{ toasts, addToast, removeToast }}>
      {children}
    </ToastContext>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
