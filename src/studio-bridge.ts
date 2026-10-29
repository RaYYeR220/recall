/**
 * Arc Studio preview instrumentation (request tracing and console capture), loaded only where it is wanted.
 *
 * Both instrumentation modules report to the page that frames this app. That is only ever
 * https://studio.arc.io, and the origin is pinned: it is the postMessage target, and
 * `event.origin` is checked on every message that comes back. They are loaded when
 *   - the page is framed by that origin, or
 *   - the dev server is running.
 * A production build served anywhere else never loads them, so it posts nothing to anyone.
 */

export const STUDIO_ORIGIN = 'https://studio.arc.io'

/** True when the immediate parent frame is the pinned Studio origin. */
export function isFramedByStudio(): boolean {
  if (typeof window === 'undefined' || window.parent === window) return false
  try {
    const ancestors = window.location.ancestorOrigins
    if (ancestors && ancestors.length > 0) return ancestors[0] === STUDIO_ORIGIN
  } catch {
    /* sandboxed frames can throw */
  }
  try {
    return document.referrer !== '' && new URL(document.referrer).origin === STUDIO_ORIGIN
  } catch {
    return false
  }
}

export function shouldLoadStudioInstrumentation(): boolean {
  return import.meta.env.DEV || isFramedByStudio()
}

let registerChainImpl: ((chainId: number, rpcUrl: string) => void) | undefined
const pendingChains: [number, string][] = []

/** Tells the tracer which chain an RPC URL belongs to. A no-op when the instrumentation is not loaded. */
export function registerChain(chainId: number, rpcUrl: string): void {
  if (registerChainImpl) registerChainImpl(chainId, rpcUrl)
  else pendingChains.push([chainId, rpcUrl])
}

/** Loads the instrumentation (before any app code runs) if this page is allowed to use it. */
export async function loadStudioInstrumentation(): Promise<void> {
  if (!shouldLoadStudioInstrumentation()) return
  const tracing = await import('./tracing')
  await import('./console-capture')
  registerChainImpl = tracing.registerChain
  for (const [id, url] of pendingChains.splice(0)) tracing.registerChain(id, url)
}
