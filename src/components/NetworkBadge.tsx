import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { RailNetwork } from '@recall/sdk'
import { NETWORK_LABEL, useNetwork } from '@/lib/network'

const OPTIONS: RailNetwork[] = ['arc', 'arc-testnet']

/** Small badge in the nav. Switches Arc mainnet / Arc testnet and remembers the choice. */
export function NetworkBadge() {
  const { network, setNetwork } = useNetwork()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        className="net-badge"
        data-net={network}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <i aria-hidden="true" />
        {NETWORK_LABEL[network]}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Network"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-52 rounded-panel border border-line-2 bg-card p-1.5"
        >
          {OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              role="menuitemradio"
              aria-checked={n === network}
              onClick={() => {
                setNetwork(n)
                setOpen(false)
              }}
              className="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-panel px-3 text-left text-[13.5px] hover:bg-white/[.04]"
            >
              <span className={n === network ? 'text-ink' : 'text-ink-2'}>{NETWORK_LABEL[n]}</span>
              <span className="mono text-[11.5px] text-ink-3">{n === 'arc' ? '5042' : '5042002'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
