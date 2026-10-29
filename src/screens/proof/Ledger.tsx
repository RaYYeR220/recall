import { RAIL_ERROR_MESSAGES } from '@recall/sdk'
import { Chip, EmptyState, ErrorPanel, Skeleton, TxLink } from '@/components/ui'
import { PROOF_NETWORK, useLedger, type LedgerEntry } from '@/hooks/useProof'

/** `MD01_NoValidMandate` carries ISO code MD01. */
function isoCode(name: string): string | null {
  return /^([A-Z]{2}\d{2})_/.exec(name)?.[1] ?? null
}

function Row({ e }: { e: LedgerEntry }) {
  const refusal = e.kind === 'refusal'
  const code = e.error ? isoCode(e.error) : null
  return (
    <li className="grid gap-2 py-3.5 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6">
      <div className="min-w-0">
        <div className="text-[14px] leading-snug text-ink">{e.label}</div>
        {refusal && e.error && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="mono text-[12.5px] text-danger">{e.error}</span>
            {code && <span className="mono rounded-pill px-2 py-[1px] text-[11px] text-danger ring-1 ring-danger/30">{code}</span>}
            <span className="text-[12px] text-ink-3">{RAIL_ERROR_MESSAGES[e.error] ?? 'The contract refused it.'}</span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Chip tone={refusal ? 'danger' : 'quiet'} dot={false} mono>
          {e.rail}
        </Chip>
        <TxLink network={PROOF_NETWORK} hash={e.hash} label={refusal ? 'reverted tx' : undefined} />
      </div>
    </li>
  )
}

/** Every hero transaction, with the refusals shown as what they are: the contract saying no, on mainnet. */
export function Ledger() {
  const { data, isLoading, isError, refetch } = useLedger()
  if (isLoading) return <Skeleton className="h-72" />
  if (isError || !data) {
    return (
      <ErrorPanel
        code="LedgerUnavailable"
        title="Couldn't load the transaction ledger."
        action={
          <button type="button" className="btn btn-line btn-sm" onClick={() => void refetch()}>
            Try again
          </button>
        }
      >
        The ledger is the list of recorded mainnet transactions that backs every claim on this page.
      </ErrorPanel>
    )
  }
  if (data.entries.length === 0) return <EmptyState title="No transactions recorded yet" />
  const actions = data.entries.filter((e) => e.kind === 'action')
  const refusals = data.entries.filter((e) => e.kind === 'refusal')
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="panel p-5 sm:p-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[16px] font-medium tracking-tight">What happened</h3>
          <span className="mono text-[11.5px] text-ink-3">{actions.length} transactions</span>
        </div>
        <ul className="mt-2 divide-y divide-line">
          {actions.map((e) => (
            <Row key={e.hash} e={e} />
          ))}
        </ul>
      </div>
      <div className="panel p-5 sm:p-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[16px] font-medium tracking-tight">What the contract refused</h3>
          <span className="mono text-[11.5px] text-ink-3">{refusals.length} reverted</span>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-snug text-ink-3">Each one is a real mainnet transaction that reverted with the error shown.</p>
        <ul className="mt-2 divide-y divide-line">
          {refusals.map((e) => (
            <Row key={e.hash} e={e} />
          ))}
        </ul>
      </div>
    </div>
  )
}
