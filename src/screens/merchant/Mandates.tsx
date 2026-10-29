import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { CollectionStatus, collectionIdOf, decodeReturnCode, MandateStatus, refToBytes32, tokenByAddress, TIME_SCALE } from '@recall/sdk'
import { Chip, DemoPill, EmptyState, ErrorPanel, Skeleton } from '@/components/ui'
import { useCreditorMandates, useRailWindows } from '@/hooks/useMerchant'
import { useRail } from '@/hooks/useWallet'
import { runTx } from '@/lib/actions'
import { useChainNow } from '@/lib/clock'
import { countdownText, durationText, fmtDayTime, formatToken, refText, shortAddress, type TokenSymbol } from '@/lib/format'
import { useNetwork } from '@/lib/network'
import { parseUsdc } from '@/onchain-money'
import { useMerchantCtx } from './ctx'

const PAGE = 10

export interface Prefill {
  mandateId: Hex
  amount: bigint
  note: string
  nonce: number
}

const pad = (n: number) => String(n).padStart(2, '0')
/** `YYYY-MM-DDTHH:mm:ss` in local time, for a datetime-local input. */
export function toLocalInput(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const newE2eId = (): Hex => refToBytes32(`INV-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase()}`)

function CollectionChip({ status, code }: { status: number; code: string }) {
  const c = decodeReturnCode(code)
  switch (status) {
    case CollectionStatus.SCHEDULED:
      return <Chip>Announced</Chip>
    case CollectionStatus.SETTLED:
      return <Chip tone="ink">Settled</Chip>
    case CollectionStatus.FINAL:
      return <Chip tone="ink">Final</Chip>
    case CollectionStatus.REFUNDED:
      return <Chip tone="limetext" mono>Refunded · MD06</Chip>
    case CollectionStatus.RETURNED:
      return <Chip tone="danger" mono>Returned · {c || '—'}</Chip>
    case CollectionStatus.REFUSED:
      return <Chip tone="danger" mono>Refused · MS02</Chip>
    case CollectionStatus.CANCELLED:
      return <Chip tone="quiet">Cancelled</Chip>
    default:
      return <Chip tone="quiet">Expired</Chip>
  }
}

type View = NonNullable<ReturnType<typeof useCreditorMandates>['data']>['views'][number]

function PrenotifyForm({ view, prefill }: { view: View; prefill: Prefill | null }) {
  const { network } = useNetwork()
  const { instance, gate } = useMerchantCtx()
  const rail = useRail(instance)
  const qc = useQueryClient()
  const windows = useRailWindows(network, instance)
  const { now } = useChainNow(network)
  const m = view.mandate
  const notice = Math.max(Math.floor(m.prenoticeLength / TIME_SCALE[instance]), Number(windows.data?.minPrenotice ?? 0n))
  const earliest = now + notice + 12
  const [amountStr, setAmountStr] = useState('')
  const [due, setDue] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const applied = useRef(0)
  useEffect(() => {
    if (prefill && prefill.mandateId === view.id && applied.current !== prefill.nonce) {
      applied.current = prefill.nonce
      setAmountStr((Number(prefill.amount) / 1e6).toFixed(2))
      setNote(prefill.note)
      setDue(toLocalInput(Math.floor(Date.now() / 1000) + notice + 42))
    }
  }, [prefill, view.id, notice])

  let amount: bigint | null = null
  try {
    amount = amountStr.trim() ? parseUsdc(amountStr.trim()) : null
  } catch {
    amount = null
  }
  const dueSec = due ? Math.floor(new Date(due).getTime() / 1000) : NaN
  const tooSoon = Number.isFinite(dueSec) && dueSec < earliest
  const disabled = m.status !== MandateStatus.ACTIVE

  async function submit() {
    if (amount === null || !Number.isFinite(dueSec)) return
    setBusy(true)
    const res = await runTx({
      network,
      pendingTitle: 'Pre-notify',
      title: 'Debit announced',
      successDetail: `The payer is told ${formatToken(amount, tokenByAddress(network, m.token)?.symbol ?? 'EURC')} will be taken on ${fmtDayTime(dueSec)}.`,
      send: () => rail.prenotify(view.id, amount, BigInt(dueSec), newE2eId(), note.trim()),
    })
    setBusy(false)
    if (res.ok) {
      setAmountStr('')
      setNote('')
      await qc.invalidateQueries({ queryKey: ['creditor-view'] })
    }
  }

  return (
    <form
      className="grid gap-3 sm:grid-cols-[8rem_1fr_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      aria-label="Pre-notify a debit"
    >
      <label className="block">
        <span className="text-[12px] text-ink-3">Amount</span>
        <input className="field mt-1" inputMode="decimal" placeholder="0.00" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} disabled={disabled} />
      </label>
      <label className="block">
        <span className="text-[12px] text-ink-3">Due</span>
        <input className="field mt-1" type="datetime-local" step={1} value={due} min={toLocalInput(earliest)} onChange={(e) => setDue(e.target.value)} disabled={disabled} />
      </label>
      <label className="block">
        <span className="text-[12px] text-ink-3">Note for the payer</span>
        <input className="field mt-1 !font-sans" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Monthly membership" disabled={disabled} />
      </label>
      <div className="flex gap-2">
        <button type="button" className="btn btn-line btn-xs" onClick={() => setDue(toLocalInput(earliest + 5))} disabled={disabled}>
          Earliest
        </button>
        <button type="submit" className="btn btn-light btn-xs" disabled={busy || disabled || amount === null || !Number.isFinite(dueSec) || tooSoon || !!gate} title={gate}>
          {busy ? 'Working…' : 'Announce'}
        </button>
      </div>
      <p className="text-[11.5px] text-ink-3 sm:col-span-4">
        The notice period is {durationText(m.prenoticeLength)}
        {instance === 'demo' ? ` (${durationText(notice)} on this rail)` : ''}, so the earliest due time is <span className="mono">{fmtDayTime(earliest)}</span>
        {tooSoon && <span className="ml-2 mono text-danger">PrenoticeTooShort</span>}. The end-to-end id is generated for you.
      </p>
    </form>
  )
}

function CollectionRow({ view, c, onRepresent }: { view: View; c: View['collections'][number]; onRepresent: (p: Omit<Prefill, 'nonce'>) => void }) {
  const { network } = useNetwork()
  const { instance, gate } = useMerchantCtx()
  const rail = useRail(instance)
  const qc = useQueryClient()
  const { now } = useChainNow(network)
  const [busy, setBusy] = useState<'collect' | 'cancel' | null>(null)
  const sym: TokenSymbol = tokenByAddress(network, view.mandate.token)?.symbol ?? 'EURC'
  const id = collectionIdOf(view.id, c.e2eId)
  const scheduled = c.status === CollectionStatus.SCHEDULED
  const due = Number(c.dueAt)
  const retry = c.status === CollectionStatus.RETURNED && ['AM04', 'MS03'].includes(decodeReturnCode(c.code))

  async function run(kind: 'collect' | 'cancel') {
    setBusy(kind)
    const res = await runTx({
      network,
      pendingTitle: kind === 'collect' ? 'Collect' : 'Cancel debit',
      title: kind === 'collect' ? 'Collection run' : 'Debit cancelled',
      successDetail: kind === 'collect' ? 'Settled, returned or refused: the card shows which.' : 'The payer was told and nothing will be taken.',
      send: () => (kind === 'collect' ? rail.collect(id) : rail.cancel(id)),
    })
    setBusy(null)
    if (res.ok) await qc.invalidateQueries({ queryKey: ['creditor-view'] })
  }

  return (
    <li className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="mono text-[13.5px] text-ink">{formatToken(c.amount, sym)}</span>
        <CollectionChip status={c.status} code={c.code} />
        <span className="mono text-[11.5px] text-ink-3">
          {refText(c.e2eId)} · due {fmtDayTime(due)}
          {scheduled && now < due ? ` · in ${countdownText(due - now)}` : ''}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {scheduled && (
          <>
            <button type="button" className="btn btn-light btn-xs" disabled={busy !== null || !!gate || now < due} title={now < due ? 'Not due yet' : gate} onClick={() => void run('collect')}>
              {busy === 'collect' ? 'Working…' : 'Collect'}
            </button>
            <button type="button" className="btn btn-line btn-xs" disabled={busy !== null || !!gate} title={gate} onClick={() => void run('cancel')}>
              {busy === 'cancel' ? 'Working…' : 'Cancel'}
            </button>
          </>
        )}
        {retry && (
          <button type="button" className="btn btn-line btn-xs" onClick={() => onRepresent({ mandateId: view.id, amount: c.amount, note: 'Re-presented' })}>
            Re-present
          </button>
        )}
      </div>
    </li>
  )
}

function MandateCard({ view, open, onToggle, prefill, onRepresent }: { view: View; open: boolean; onToggle: () => void; prefill: Prefill | null; onRepresent: (p: Omit<Prefill, 'nonce'>) => void }) {
  const { network } = useNetwork()
  const { instance } = useMerchantCtx()
  const m = view.mandate
  const sym: TokenSymbol = tokenByAddress(network, m.token)?.symbol ?? 'EURC'
  const status =
    m.status === MandateStatus.ACTIVE ? <Chip tone="lime">Active</Chip> : m.status === MandateStatus.REVOKED ? <Chip tone="danger" mono>Revoked · MD01</Chip> : <Chip tone="quiet">Used</Chip>
  const hidden = view.collectionCount > BigInt(view.collections.length)
  return (
    <li className="py-1">
      <button type="button" className="grid w-full gap-1.5 py-3.5 text-left sm:grid-cols-[1.1fr_1fr_1.4fr_auto] sm:items-center sm:gap-4" aria-expanded={open} onClick={onToggle}>
        <span className="mono text-[13px] text-ink">{shortAddress(m.debtor)}</span>
        <span className="flex flex-wrap items-center gap-2">
          {status}
          {instance === 'demo' && <DemoPill />}
        </span>
        <span className="mono text-[12px] text-ink-3">
          {refText(m.offerRef)} · up to {formatToken(m.maxPerCollection, sym)} · {view.collectionCount.toString()} debit{view.collectionCount === 1n ? '' : 's'}
        </span>
        <ChevronDown size={16} className={`text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="space-y-4 pb-5">
          <PrenotifyForm view={view} prefill={prefill} />
          {view.collections.length === 0 ? (
            <p className="text-[13px] text-ink-3">No debits yet on this mandate.</p>
          ) : (
            <ul className="divide-y divide-line rounded-panel border border-line px-4">
              {[...view.collections].reverse().map((c) => (
                <CollectionRow key={c.e2eId} view={view} c={c} onRepresent={onRepresent} />
              ))}
            </ul>
          )}
          {hidden && <p className="mono text-[11.5px] text-ink-3">Showing the newest {view.collections.length} of {view.collectionCount.toString()} debits.</p>}
        </div>
      )}
    </li>
  )
}

/** The creditor's mandates, newest page first, with everything you can do to a debit. */
export function Mandates() {
  const { network } = useNetwork()
  const { instance, creditor } = useMerchantCtx()
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<Hex | null>(null)
  const [prefill, setPrefill] = useState<Prefill | null>(null)
  const q = useCreditorMandates(network, instance, creditor.id, page * PAGE, PAGE)
  const total = Number(q.data?.total ?? 0n)
  const pages = Math.max(1, Math.ceil(total / PAGE))

  return (
    <section aria-labelledby="mandates-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="mandates-title" className="section-title">
          Mandates and debits
        </h2>
        <span className="mono text-[12px] text-ink-3">{total} mandate{total === 1 ? '' : 's'}</span>
      </div>
      <p className="lede mt-2 max-w-2xl">Announce a debit, collect it when it is due, or cancel it before it runs. Returned debits can be presented again.</p>
      <div className="panel mt-5 p-4 sm:p-6">
        {q.isLoading && <Skeleton className="h-40" />}
        {q.isError && (
          <ErrorPanel code="RpcError" title="Couldn't read your mandates.">
            The chain didn&rsquo;t answer.{' '}
            <button type="button" className="underline underline-offset-4" onClick={() => void q.refetch()}>
              Try again
            </button>
          </ErrorPanel>
        )}
        {q.data && q.data.views.length === 0 && (
          <EmptyState title="No mandates yet">When a payer accepts one of your checkout links, their mandate appears here.</EmptyState>
        )}
        {q.data && q.data.views.length > 0 && (
          <>
            <div className="hidden px-0 pb-2 text-[11.5px] text-ink-3 sm:grid sm:grid-cols-[1.1fr_1fr_1.4fr_auto] sm:gap-4" aria-hidden="true">
              <span>Payer</span>
              <span>Status</span>
              <span>Reference</span>
              <span className="w-4" />
            </div>
            <ul className="divide-y divide-line">
              {[...q.data.views].reverse().map((v) => (
                <MandateCard
                  key={v.id}
                  view={v}
                  open={open === v.id}
                  onToggle={() => setOpen(open === v.id ? null : v.id)}
                  prefill={prefill}
                  onRepresent={(p) => {
                    setOpen(p.mandateId)
                    setPrefill({ ...p, nonce: Date.now() })
                  }}
                />
              ))}
            </ul>
            {pages > 1 && (
              <div className="mt-4 flex items-center justify-between border-t border-line pt-4 text-[13px]">
                <button type="button" className="btn btn-line btn-xs" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  Newer
                </button>
                <span className="mono text-ink-3">
                  page {page + 1} of {pages}
                </span>
                <button type="button" className="btn btn-line btn-xs" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                  Older
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {q.data && q.data.views.length > 0 && <p className="mt-3 text-[12px] text-ink-3">The list refreshes every 15 seconds.</p>}
    </section>
  )
}
