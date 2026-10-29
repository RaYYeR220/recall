import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, QrCode } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toDataURL } from 'qrcode'
import { debitRailAbi, decodeCheckoutToken, tokenByAddress, type CheckoutLinkPayload } from '@recall/sdk'
import { Chip, EmptyState } from '@/components/ui'
import { useRail } from '@/hooks/useWallet'
import { runTx } from '@/lib/actions'
import { getPublicClient } from '@/lib/clients'
import { durationText, fmtDate, formatToken, refText } from '@/lib/format'
import { useNetwork } from '@/lib/network'
import { notify } from '@/lib/notify'
import { loadOffers, saveOffers, type StoredOffer } from '@/lib/offerStore'
import { useMerchantCtx } from './ctx'
import { OfferForm, type CreatedOffer } from './OfferForm'

const linkOf = (token: string) => `${window.location.origin}/m/${token}`

function OfferRow({ stored, onCancelled }: { stored: StoredOffer; onCancelled: () => void }) {
  const { network } = useNetwork()
  const { instance, gate } = useMerchantCtx()
  const rail = useRail(instance)
  const qc = useQueryClient()
  const [qr, setQr] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  let payload: CheckoutLinkPayload | null = null
  try {
    payload = decodeCheckoutToken(stored.token)
  } catch {
    payload = null
  }

  const status = useQuery({
    enabled: !!payload,
    queryKey: ['offer-status', network, instance, stored.token.slice(-24)],
    queryFn: async () => {
      if (!payload) throw new Error('no offer')
      const offerHash = await rail.offerHash(payload.offer)
      const pc = getPublicClient(network)
      const [cancelled, uses, block] = await Promise.all([
        pc.readContract({ address: rail.rail, abi: debitRailAbi, functionName: 'offerCancelled', args: [offerHash] }),
        pc.readContract({ address: rail.rail, abi: debitRailAbi, functionName: 'offerUses', args: [offerHash] }),
        pc.getBlock(),
      ])
      return { cancelled, uses, now: Number(block.timestamp) }
    },
    staleTime: 15_000,
  })

  const showQr = useCallback(async () => {
    if (qr) {
      setQr(null)
      return
    }
    try {
      setQrError(null)
      setQr(await toDataURL(linkOf(stored.token), { errorCorrectionLevel: 'L', margin: 1, width: 280, color: { dark: '#0a0a0b', light: '#f5f5f7' } }))
    } catch {
      setQrError('This link carries too much text for a QR code. Share the link itself.')
    }
  }, [qr, stored.token])

  if (!payload) return null
  const o = payload.offer
  const sym = tokenByAddress(network, o.token)?.symbol ?? 'EURC'
  const s = status.data
  const state = !s ? null : s.cancelled ? 'cancelled' : s.now > Number(o.validUntil) ? 'expired' : o.maxUses > 0 && s.uses >= o.maxUses ? 'used' : 'live'

  async function copy() {
    try {
      await navigator.clipboard.writeText(linkOf(stored.token))
      notify.info({ title: 'Link copied', duration: 2500 })
    } catch {
      notify.info({ title: 'Could not copy', detail: 'Select the link and copy it by hand.' })
    }
  }

  async function cancel() {
    if (!payload) return
    setBusy(true)
    const res = await runTx({
      network,
      pendingTitle: 'Cancel offer',
      title: 'Offer cancelled',
      successDetail: 'The link can no longer be accepted.',
      send: () => rail.cancelOffer(payload.offer),
    })
    setBusy(false)
    if (res.ok) {
      await qc.invalidateQueries({ queryKey: ['offer-status'] })
      onCancelled()
    }
  }

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="mono text-[13px] text-ink">{refText(o.offerRef)}</span>
        {state === 'live' && <Chip tone="lime">Live</Chip>}
        {state === 'cancelled' && <Chip tone="danger" mono>Cancelled · OfferCancelled_</Chip>}
        {state === 'expired' && <Chip tone="quiet">Expired</Chip>}
        {state === 'used' && <Chip tone="quiet">Used up</Chip>}
        <Chip tone="quiet" dot={false} mono>
          {o.scheme === 0 ? 'Core' : 'B2B'}
        </Chip>
        <span className="mono ml-auto text-[11.5px] text-ink-3">{s ? `${s.uses} accepted` : '…'}</span>
      </div>
      <p className="mono mt-1.5 text-[12px] text-ink-3">
        up to {formatToken(o.maxPerCollection, sym)} per debit · {formatToken(o.maxPerPeriod, sym)} per {durationText(o.periodLength)} · until {fmtDate(o.validUntil)}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-line btn-xs" onClick={() => void copy()}>
          <Copy size={13} className="mr-1.5" aria-hidden="true" />
          Copy link
        </button>
        <button type="button" className="btn btn-line btn-xs" onClick={() => void showQr()} aria-expanded={!!qr}>
          <QrCode size={13} className="mr-1.5" aria-hidden="true" />
          {qr ? 'Hide QR' : 'QR code'}
        </button>
        {state === 'live' && (
          <button type="button" className="btn btn-line btn-xs" disabled={busy || !!gate} title={gate} onClick={() => void cancel()}>
            {busy ? 'Working…' : 'Cancel offer'}
          </button>
        )}
      </div>
      {qrError && <p className="mt-2 text-[12px] text-ink-3">{qrError}</p>}
      {qr && <img src={qr} alt="QR code for the checkout link" width={280} height={280} className="mt-3 rounded-panel" />}
    </li>
  )
}

/** Offers created from this browser (kept in localStorage) with the form above them. */
export function Offers() {
  const { network } = useNetwork()
  const { instance, creditor, wallet } = useMerchantCtx()
  const [list, setList] = useState<StoredOffer[]>(() => loadOffers(network, instance, creditor.id, wallet))
  const [fresh, setFresh] = useState<CreatedOffer | null>(null)
  const [qr, setQr] = useState<string | null>(null)

  function created(o: CreatedOffer) {
    const next = [{ token: o.token, createdAt: Date.now() }, ...list]
    setList(next)
    saveOffers(network, instance, creditor.id, wallet, next)
    setFresh(o)
    setQr(null)
    toDataURL(linkOf(o.token), { errorCorrectionLevel: 'L', margin: 1, width: 280, color: { dark: '#0a0a0b', light: '#f5f5f7' } }).then(setQr, () => setQr(null))
  }

  return (
    <section aria-labelledby="offers-title" className="space-y-6">
      <div>
        <h2 id="offers-title" className="section-title">
          Offers
        </h2>
        <p className="lede mt-2 max-w-2xl">Sign a mandate offer once. Anyone with the link can accept it, within the limits you set.</p>
      </div>
      <OfferForm onCreated={created} />
      {fresh && (
        <div className="panel p-5 sm:p-6" role="status" aria-label="New checkout link">
          <div className="flex flex-wrap items-start gap-6">
            <div className="min-w-0 flex-1">
              <Chip tone="lime">Link ready</Chip>
              <p className="mt-3 text-[13px] text-ink-3">Share this. The offer inside is signed and checked against the rail.</p>
              <input className="field mt-3" readOnly value={linkOf(fresh.token)} onFocus={(e) => e.currentTarget.select()} aria-label="Checkout link" />
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className="btn btn-light btn-xs"
                  onClick={() => void navigator.clipboard.writeText(linkOf(fresh.token)).then(() => notify.info({ title: 'Link copied', duration: 2500 }))}
                >
                  Copy link
                </button>
                <a className="btn btn-line btn-xs" href={linkOf(fresh.token)} target="_blank" rel="noopener noreferrer">
                  Open as a payer
                </a>
              </div>
            </div>
            {qr ? (
              <img src={qr} alt="QR code for the checkout link" width={200} height={200} className="rounded-panel" />
            ) : (
              <p className="max-w-[12rem] text-[12px] text-ink-3">No QR code: this link carries too much text. Share the link itself.</p>
            )}
          </div>
        </div>
      )}
      <div className="panel p-5 sm:p-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[16px] font-medium tracking-tight">Offers made in this browser</h3>
          <span className="mono text-[11.5px] text-ink-3">{list.length}</span>
        </div>
        {list.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="No offers yet">Create one above. It is listed here, with its status read from the rail.</EmptyState>
          </div>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {list.map((o) => (
              <OfferRow key={o.createdAt} stored={o} onCancelled={() => undefined} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
