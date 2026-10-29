import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { networkInfo, type NetworkInfo, type RailNetwork } from '@recall/sdk'

const STORAGE_KEY = 'recall.network'

function readStored(): RailNetwork {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === 'arc' || v === 'arc-testnet') return v
  } catch {
    /* storage can be blocked (private mode, sandboxed frames) */
  }
  return 'arc' // Arc mainnet is the default
}

interface NetworkContextValue {
  network: RailNetwork
  info: NetworkInfo
  setNetwork: (n: RailNetwork) => void
}

const NetworkContext = createContext<NetworkContextValue | null>(null)

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [network, setNetworkState] = useState<RailNetwork>(readStored)

  const setNetwork = useCallback((n: RailNetwork) => {
    setNetworkState(n)
    try {
      window.localStorage.setItem(STORAGE_KEY, n)
    } catch {
      /* ignore */
    }
  }, [])

  const value = useMemo(() => ({ network, info: networkInfo(network), setNetwork }), [network, setNetwork])
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
}

export function useNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext)
  if (!ctx) throw new Error('useNetwork must be used inside <NetworkProvider>')
  return ctx
}

export const NETWORK_LABEL: Record<RailNetwork, string> = {
  arc: 'Arc mainnet',
  'arc-testnet': 'Arc testnet',
}
