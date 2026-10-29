import { RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { addressUrl, railAddresses, tokenBySymbol, type RailInstance } from '@recall/sdk'
import { Chip, DemoPill, ExtLink, Skeleton } from '@/components/ui'
import { PROOF_NETWORK, useLiveHealth, useSourcify, useStats } from '@/hooks/useProof'
import { formatAmountPlain, shortAddress, type TokenSymbol } from '@/lib/format'
import { networkInfo } from '@recall/sdk'

type Health = NonNullable<ReturnType<typeof useLiveHealth>['data']>['health']['eurc']

function Check({ ok, id, rule, detail }: { ok: boolean; id: string; rule: string; detail: ReactNode }) {
  return (
    <li className="grid gap-1 py-3 sm:grid-cols-[3.2rem_1fr_auto] sm:items-center sm:gap-4">
      <span className="mono text-[12px] text-ink-3">{id}</span>
      <div>
        <div className="text-[13.5px] text-ink">{rule}</div>
        <div className="mono mt-0.5 text-[11.5px] text-ink-3">{detail}</div>
      </div>
      <Chip tone={ok ? 'lime' : 'danger'} mono>
        {ok ? 'holds' : 'BROKEN'}
      </Chip>
    </li>
  )
}

function TokenHealth({ symbol, h }: { symbol: TokenSymbol; h: Health }) {
  const accounted = h.reserves + h.held + h.claimables
  const f = formatAmountPlain
  return (
    <div className="inner p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-[15px] font-medium tracking-tight">{symbol}</h4>
        <span className="mono text-[11.5px] text-ink-3">balance {f(h.balance)}</span>
      </div>
      <ul className="mt-2 divide-y divide-line" aria-label={`${symbol} invariants`}>
        <Check ok={h.i1} id="I1" rule="Balance ≥ reserves + held + claimables" detail={`${f(h.balance)} ≥ ${f(h.reserves)} + ${f(h.held)} + ${f(h.claimables)} = ${f(accounted)}`} />
        <Check ok={h.i2} id="I2" rule="Open exposure = locked + held" detail={`${f(h.exposureTotal)} = ${f(h.lockedTotal)} + ${f(h.held)}`} />
        <Check ok={h.i3} id="I3" rule="Locked ≤ reserves" detail={`${f(h.lockedTotal)} ≤ ${f(h.reserves)}`} />
      </ul>
      <div className="mt-3 rounded-panel border border-line px-3.5 py-2.5 text-[12.5px] leading-snug text-ink-3">
        <span className="text-ink-2">Surplus </span>
        <span className="mono text-ink">{f(h.surplus)} {symbol}</span>: unaccounted, not anyone&rsquo;s. Tokens sent to the contract outside its
        functions. It is not a reserve and nobody can claim it.
      </div>
    </div>
  )
}

function Counter({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11.5px] text-ink-3">{label}</dt>
      <dd className="mono mt-1 text-[14px] text-ink">{value}</dd>
    </div>
  )
}

function Stats({ instance }: { instance: RailInstance }) {
  const { data, isLoading } = useStats(instance)
  if (isLoading) return <Skeleton className="h-24" />
  if (!data) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {(['eurc', 'usdc'] as const).map((k) => {
        const s = data[k]
        const sym: TokenSymbol = k === 'eurc' ? 'EURC' : 'USDC'
        return (
          <div key={k} className="inner p-4">
            <div className="text-[13px] font-medium tracking-tight">{sym} · lifetime</div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              <Counter label="Collected" value={formatAmountPlain(s.collected)} />
              <Counter label="Refunded" value={formatAmountPlain(s.refunded)} />
              <Counter label="Settled" value={s.settledCount.toString()} />
              <Counter label="Refunded" value={s.refundedCount.toString()} />
              <Counter label="Returned" value={s.returnedCount.toString()} />
            </dl>
          </div>
        )
      })}
    </div>
  )
}

function AddressRow({ label, address, chainId }: { label: string; address: string; chainId: number }) {
  const s = useSourcify(address, chainId)
  const state = s.data?.state
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2.5 text-[13px]">
      <span className="w-24 flex-none text-ink-3">{label}</span>
      <ExtLink href={addressUrl(PROOF_NETWORK, address)}>
        <span className="mono sm:hidden">{shortAddress(address)}</span>
        <span className="mono hidden sm:inline">{address}</span>
      </ExtLink>
      <span className="ml-auto flex items-center gap-3">
        {s.isLoading ? (
          <span className="mono text-[11.5px] text-ink-3">checking Sourcify…</span>
        ) : state === 'perfect' || state === 'partial' ? (
          <Chip tone="lime" mono title="Source verified on Sourcify">
            verified · {state}
          </Chip>
        ) : state === 'unverified' ? (
          <Chip tone="quiet" mono>
            not on Sourcify
          </Chip>
        ) : (
          <Chip tone="quiet" mono title="Sourcify did not answer">
            Sourcify unreachable
          </Chip>
        )}
        <ExtLink href={`https://sourcify.dev/#/lookup/${address}`}>Sourcify</ExtLink>
      </span>
    </li>
  )
}

/** One rail, proven live from the chain: addresses, the three invariants for both tokens, and lifetime counters. */
export function RailProof({ instance }: { instance: RailInstance }) {
  const { rail, lens } = railAddresses(PROOF_NETWORK)[instance]
  const info = networkInfo(PROOF_NETWORK)
  const { data, isLoading, isError, refetch, isFetching, dataUpdatedAt } = useLiveHealth(instance)
  const all = data ? [data.health.eurc, data.health.usdc] : []
  const healthy = all.length > 0 && all.every((h) => h.i1 && h.i2 && h.i3)

  return (
    <section className="panel p-5 sm:p-7" aria-labelledby={`rail-${instance}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={`rail-${instance}`} className="text-[20px] font-medium tracking-[-0.03em]">
          {instance === 'prod' ? 'Prod rail' : 'Demo rail'}
        </h2>
        {instance === 'demo' && <DemoPill />}
        {data && (
          <Chip tone={healthy ? 'lime' : 'danger'} mono>
            {healthy ? 'all invariants hold' : 'invariant broken'}
          </Chip>
        )}
        <span className="mono ml-auto flex items-center gap-2 text-[11.5px] text-ink-3" aria-live="polite">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
          {data ? `block ${data.block.toString()}` : 'reading…'} · every 15 s
          <button type="button" className="btn-text" onClick={() => void refetch()} aria-label="Refresh now">
            <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
        </span>
      </div>

      <ul className="mt-4 divide-y divide-line">
        <AddressRow label="DebitRail" address={rail} chainId={info.chainId} />
        <AddressRow label="RailLens" address={lens} chainId={info.chainId} />
        <AddressRow label="EURC" address={tokenBySymbol(PROOF_NETWORK, 'EURC').address} chainId={info.chainId} />
        <AddressRow label="USDC" address={tokenBySymbol(PROOF_NETWORK, 'USDC').address} chainId={info.chainId} />
      </ul>

      {isLoading && (
        <div className="mt-5 grid gap-3 lg:grid-cols-2" aria-busy="true">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      )}
      {isError && !data && (
        <div className="mt-5 rounded-panel border border-danger/30 p-4" role="alert">
          <div className="text-[13.5px]">Couldn&rsquo;t read RailLens.health() from Arc mainnet.</div>
          <button type="button" className="btn btn-line btn-xs mt-3" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      )}
      {data && (
        <div className="mt-5 grid gap-3 lg:grid-cols-2">
          <TokenHealth symbol="EURC" h={data.health.eurc} />
          <TokenHealth symbol="USDC" h={data.health.usdc} />
        </div>
      )}
      {data && <p className="mono mt-3 text-[11px] text-ink-3">read {new Date(dataUpdatedAt).toLocaleTimeString('en-GB')}</p>}

      <h3 className="mt-7 text-[14px] font-medium tracking-tight">Lifetime counters</h3>
      <div className="mt-3">
        <Stats instance={instance} />
      </div>
    </section>
  )
}
