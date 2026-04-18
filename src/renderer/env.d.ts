declare module '*.svg' {
  const src: string
  export default src
}

// The preload script exposes a typed API on window.quietclaw via
// contextBridge. Declaring it as ambient here means renderer components
// can access `window.quietclaw` with full type-checking instead of casting
// to `any`. Optional because tests and edge cases (e.g., before preload
// finishes loading) may not have it.
import type { QuietClawAPI } from '../preload'

declare global {
  interface Window {
    quietclaw?: QuietClawAPI
  }
}
