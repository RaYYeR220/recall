import { toast } from 'sonner'
import type { ReactNode } from 'react'
import type { RailError, RailNetwork } from '@recall/sdk'
import { InfoToast, RefusalToast, SuccessToast } from '@/components/Toasts'

let seq = 0
const nextId = () => `recall-${++seq}`

/** Every on-chain action reports through these: pending, decoded success, decoded refusal. */
export const notify = {
  pending(title: string, detail?: string, network?: RailNetwork, hash?: string, id: string | number = nextId()) {
    toast.custom((t) => <InfoToast id={t} title={title} detail={detail} network={network} hash={hash} />, {
      id,
      duration: Infinity,
    })
    return id
  },
  success(opts: { id?: string | number; title: string; detail?: string; code?: string; network?: RailNetwork; hash?: string }) {
    const id = opts.id ?? nextId()
    toast.custom(
      (t) => (
        <SuccessToast id={t} title={opts.title} detail={opts.detail} code={opts.code} network={opts.network} hash={opts.hash} />
      ),
      { id, duration: 12_000 },
    )
    return id
  },
  refusal(opts: { id?: string | number; title: string; error: RailError; network?: RailNetwork; hash?: string }) {
    const id = opts.id ?? nextId()
    toast.custom(
      (t) => <RefusalToast id={t} title={opts.title} error={opts.error} network={opts.network} hash={opts.hash} />,
      { id, duration: 15_000 },
    )
    return id
  },
  info(opts: { id?: string | number; title: string; detail?: string; action?: ReactNode; duration?: number }) {
    const id = opts.id ?? nextId()
    toast.custom((t) => <InfoToast id={t} title={opts.title} detail={opts.detail} action={opts.action} />, {
      id,
      duration: opts.duration ?? 6000,
    })
    return id
  },
  dismiss(id: string | number) {
    toast.dismiss(id)
  },
}
