import { X } from 'lucide-react'
import { toast } from 'sonner'
import type { ReactNode } from 'react'
import type { RailError } from '@recall/sdk'
import type { RailNetwork } from '@recall/sdk'
import { TxLink } from './ui'

function Shell({ id, tone, children }: { id: string | number; tone: 'ok' | 'danger' | 'neutral'; children: ReactNode }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className="relative w-[min(92vw,380px)] rounded-card border border-line-2 bg-card px-4 py-3.5 pr-10 text-left"
    >
      <span
        className={`absolute left-0 top-4 h-8 w-[3px] rounded-seg ${tone === 'danger' ? 'bg-danger' : tone === 'ok' ? 'bg-accent' : 'bg-ink-4'}`}
        aria-hidden="true"
      />
      {children}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => toast.dismiss(id)}
        className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-pill text-ink-3 hover:text-ink"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

export interface ToastBase {
  id: string | number
  title: string
  detail?: string
  network?: RailNetwork
  hash?: string
}

export function InfoToast({ id, title, detail, network, hash, action }: ToastBase & { action?: ReactNode }) {
  return (
    <Shell id={id} tone="neutral">
      <div className="text-[14px] font-medium tracking-tight">{title}</div>
      {detail && <div className="mt-1 text-[12.5px] leading-snug text-ink-3">{detail}</div>}
      {network && hash && (
        <div className="mt-2">
          <TxLink network={network} hash={hash} />
        </div>
      )}
      {action && <div className="mt-2.5">{action}</div>}
    </Shell>
  )
}

export function SuccessToast({ id, title, detail, network, hash, code }: ToastBase & { code?: string }) {
  return (
    <Shell id={id} tone="ok">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-medium tracking-tight">{title}</span>
        {code && <span className="mono text-[12px] text-accent">{code}</span>}
      </div>
      {detail && <div className="mt-1 text-[12.5px] leading-snug text-ink-3">{detail}</div>}
      {network && hash && (
        <div className="mt-2">
          <TxLink network={network} hash={hash} />
        </div>
      )}
    </Shell>
  )
}

/** Refusals are a feature: the contract's own error name and ISO code, in mono, in the danger colour. */
export function RefusalToast({
  id,
  title,
  error,
  network,
  hash,
}: { id: string | number; title: string; error: RailError; network?: RailNetwork; hash?: string }) {
  return (
    <Shell id={id} tone="danger">
      <div className="text-[14px] font-medium tracking-tight">{title}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="mono text-[13px] text-danger">{error.name}</span>
        {error.code && <span className="mono rounded-pill px-2 py-[1px] text-[11.5px] text-danger ring-1 ring-danger/30">{error.code}</span>}
      </div>
      <div className="mt-1 text-[12.5px] leading-snug text-ink-3">{error.message}</div>
      {network && hash && (
        <div className="mt-2">
          <TxLink network={network} hash={hash} />
        </div>
      )}
    </Shell>
  )
}
