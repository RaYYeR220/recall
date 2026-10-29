import { Scheme, MandateStatus } from '@recall/sdk'
import { ActionButtons } from '@/components/ActionButtons'
import { Chip, DemoPill, EmptyState } from '@/components/ui'
import { durationText, formatToken, refText } from '@/lib/format'
import { mandateStatusView, type MandateRecord, type TokenSymbolLike } from '@/lib/model'
import type { Path } from '@/hooks/usePayerActions'
import type { Hex } from 'viem'

export interface MandateRowModel {
  id: Hex
  mandate: MandateRecord
  creditorName: string
  symbol: TokenSymbolLike
  lapsed: boolean
  collectionCount: number
  shown: number
}

export function MandateList({
  rows,
  demo,
  busyKey,
  blocked,
  onRevoke,
  onShowAll,
  showingAll,
}: {
  rows: MandateRowModel[]
  demo: boolean
  busyKey: string | null
  blocked: string | undefined
  onRevoke: (id: Hex, p: Path) => void
  onShowAll: (id: Hex) => void
  showingAll: (id: Hex) => boolean
}) {
  if (rows.length === 0) {
    return (
      <EmptyState title="No mandates on this rail.">
        A mandate appears here once you sign a merchant&rsquo;s offer. You always see its limits, and you can revoke it at any time.
      </EmptyState>
    )
  }
  return (
    <ul className="panel divide-y divide-line overflow-hidden" aria-label="Mandates">
      {rows.map((r) => {
        const st = mandateStatusView(r.mandate, r.lapsed)
        const m = r.mandate
        const active = m.status === MandateStatus.ACTIVE && !r.lapsed
        return (
          <li key={r.id} className="px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <span className="avatar !h-9 !w-9 !text-[14px]" aria-hidden="true">
                {r.creditorName.trim().charAt(0) || '·'}
              </span>
              <div className="min-w-0 flex-1 basis-44">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[14.5px] font-medium tracking-tight">{r.creditorName}</span>
                  {demo && <DemoPill />}
                </div>
                <div className="mono truncate text-[11.5px] text-ink-3">
                  {m.scheme === Scheme.CORE ? 'Core' : 'B2B'} · {r.symbol} · {refText(m.offerRef)}
                </div>
              </div>
              <Chip tone={st.tone}>{st.text}</Chip>
              {active && (
                <ActionButtons
                  label="Revoke"
                  tone="plain"
                  busy={busyKey === `revoke:${r.id}`}
                  disabled={!!blocked}
                  disabledReason={blocked}
                  onRun={(p) => onRevoke(r.id, p)}
                />
              )}
            </div>
            <dl className="mono mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-[12px] text-ink-3 sm:grid-cols-3">
              <div>
                <dt className="sr-only">Per debit</dt>
                <dd>up to {formatToken(m.maxPerCollection, r.symbol)} per debit</dd>
              </div>
              <div>
                <dt className="sr-only">Per period</dt>
                <dd>
                  {formatToken(m.maxPerPeriod, r.symbol)} per {durationText(m.periodLength)}
                </dd>
              </div>
              <div>
                <dt className="sr-only">Notice</dt>
                <dd>notice {durationText(m.prenoticeLength)}</dd>
              </div>
            </dl>
            {r.collectionCount > r.shown && !showingAll(r.id) && (
              <button type="button" className="btn-text mt-2 !px-0" onClick={() => onShowAll(r.id)}>
                Show all {r.collectionCount} debits
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
