import { RefreshCw } from 'lucide-react'
import { railAddresses, RAIL_INSTANCES, type RailInstance } from '@recall/sdk'
import { Chip, DemoPill, ExtLink, Skeleton } from '@/components/ui'
import { Reveal } from '@/components/Reveal'
import { useHealth } from '@/hooks/useHealth'
import { useChainNow } from '@/lib/clock'
import { formatAmountPlain, shortAddress, type TokenSymbol } from '@/lib/format'
import { buildAddressUrl } from '@/lib/links'

const NETWORK = 'arc' as const // the landing makes a mainnet claim, so it reads mainnet

interface Figures {
  token: string
  balance: bigint
  reserves: bigint
  held: bigint
  claimables: bigint
  surplus: bigint
  lockedTotal: bigint
  exposureTotal: bigint
  i1: boolean
  i2: boolean
  i3: boolean
}

function Invariant({ ok, id, text }: { ok: boolean; id: string; text: string }) {
  return (
    <Chip tone={ok ? 'lime' : 'danger'} mono title={text}>
      {id} {ok ? 'holds' : 'BROKEN'}
    </Chip>
  )
}

function Figure({ label, value, symbol }: { label: string; value: bigint; symbol: TokenSymbol }) {
  return (
    <div>
      <dt className="text-[11.5px] text-ink-3">{label}</dt>
      <dd className="mono mt-1 text-[13.5px] text-ink">
        {formatAmountPlain(value)}
        <span className="ml-1 text-[11px] text-ink-3">{symbol}</span>
      </dd>
    </div>
  )
}

function TokenBlock({ symbol, f }: { symbol: TokenSymbol; f: Figures }) {
  const exposure = f.exposureTotal
  const lockedShare = exposure > 0n ? Number((f.lockedTotal * 1000n) / exposure) / 10 : 0
  const heldShare = exposure > 0n ? Number((f.held * 1000n) / exposure) / 10 : 0
  return (
    <div className="inner p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13.5px] font-medium tracking-tight">{symbol}</span>
        <span className="mono text-[11.5px] text-ink-3">refundable now: {formatAmountPlain(exposure)}</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3.5 sm:grid-cols-5">
        <Figure label="Contract balance" value={f.balance} symbol={symbol} />
        <Figure label="Merchant reserves" value={f.reserves} symbol={symbol} />
        <Figure label="Locked" value={f.lockedTotal} symbol={symbol} />
        <Figure label="Held" value={f.held} symbol={symbol} />
        <Figure label="Open exposure" value={f.exposureTotal} symbol={symbol} />
      </dl>
      <div className="mt-4" aria-label={exposure > 0n ? `Exposure backed ${lockedShare}% by locked reserve and ${heldShare}% by held funds` : 'No refundable debits are open'}>
        <div className="flex h-[6px] gap-[3px]" aria-hidden="true">
          {exposure > 0n ? (
            <>
              {f.lockedTotal > 0n && <i className="rounded-seg bg-accent" style={{ width: `${lockedShare}%` }} />}
              {f.held > 0n && <i className="rounded-seg bg-ink-2" style={{ width: `${heldShare}%` }} />}
            </>
          ) : (
            <i className="w-full rounded-seg bg-ink-4/70" />
          )}
        </div>
        <div className="mono mt-2 flex justify-between text-[11px] text-ink-3">
          <span>locked {formatAmountPlain(f.lockedTotal)}</span>
          <span>{exposure > 0n ? '+' : 'nothing open'}</span>
          <span>held {formatAmountPlain(f.held)}</span>
        </div>
      </div>
    </div>
  )
}

function InstanceBlock({ instance }: { instance: RailInstance }) {
  const { data, isLoading, isError, refetch, isFetching } = useHealth(NETWORK, instance)
  const lens = railAddresses(NETWORK)[instance].lens
  return (
    <div className="panel p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-[16px] font-medium tracking-tight">{instance === 'prod' ? 'Prod rail' : 'Demo rail'}</h3>
        {instance === 'demo' && <DemoPill />}
        <span className="ml-auto">
          <ExtLink href={buildAddressUrl(NETWORK, lens)}>
            <span className="mono">RailLens {shortAddress(lens)}</span>
          </ExtLink>
        </span>
      </div>

      {isLoading && (
        <div className="mt-4 grid gap-3" aria-busy="true" aria-label="Loading live figures">
          <Skeleton className="h-[148px]" />
          <Skeleton className="h-[148px]" />
        </div>
      )}

      {isError && (
        <div className="mt-4 rounded-panel border border-danger/30 p-4" role="alert">
          <div className="text-[13.5px] text-ink">Couldn&rsquo;t read RailLens.health() from Arc mainnet.</div>
          <button type="button" className="btn btn-line btn-xs mt-3" onClick={() => void refetch()}>
            <RefreshCw size={13} aria-hidden="true" className={isFetching ? 'animate-spin' : ''} />
            Try again
          </button>
        </div>
      )}

      {data && (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            <Invariant id="I1" ok={data.eurc.i1 && data.usdc.i1} text="Contract balance is at least reserves + held + claimable" />
            <Invariant id="I2" ok={data.eurc.i2 && data.usdc.i2} text="Open exposure equals locked reserve + held funds" />
            <Invariant id="I3" ok={data.eurc.i3 && data.usdc.i3} text="Locked reserve never exceeds total reserve" />
          </div>
          <div className="mt-4 grid gap-3">
            <TokenBlock symbol="EURC" f={data.eurc} />
            <TokenBlock symbol="USDC" f={data.usdc} />
          </div>
        </>
      )}
    </div>
  )
}

export function PromiseSection() {
  const { blockNumber } = useChainNow(NETWORK)
  return (
    <section id="promise" className="mx-auto w-full max-w-app scroll-mt-20 px-4 pt-24 sm:px-8 sm:pt-32" aria-labelledby="promise-title">
      <div className="grid gap-10 lg:grid-cols-[0.9fr_1.3fr] lg:gap-14">
        <Reveal>
          <div className="eyebrow">Why it can&rsquo;t break its promise</div>
          <h2 id="promise-title" className="section-title mt-3">
            Every refundable cent is backed.
          </h2>
          <p className="lede mt-4">
            When a Core debit settles, the merchant is paid at once, as far as their reserve covers it. That part of the reserve is{' '}
            <span className="text-ink">locked</span> for the whole refund window. Whatever the reserve doesn&rsquo;t cover is{' '}
            <span className="text-ink">held</span> by the contract until the window closes.
          </p>
          <p className="lede mt-3">
            So money you can take back is always either locked or held. It is never promised and missing. The contract checks it on
            every path, and the figures on the right are read from it, live.
          </p>
          <ul className="mt-6 space-y-2.5 text-[13.5px] text-ink-2">
            <li className="flex gap-3">
              <span className="mono w-6 flex-none text-ink-3">I1</span>
              <span>Contract balance ≥ reserves + held + claimable.</span>
            </li>
            <li className="flex gap-3">
              <span className="mono w-6 flex-none text-ink-3">I2</span>
              <span>Open exposure = locked reserve + held funds.</span>
            </li>
            <li className="flex gap-3">
              <span className="mono w-6 flex-none text-ink-3">I3</span>
              <span>Locked reserve ≤ total reserve.</span>
            </li>
          </ul>
        </Reveal>

        <Reveal delay={0.08} className="grid gap-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
            <span className="inline-flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
              Live · RailLens.health() · Arc mainnet
            </span>
            {blockNumber !== undefined && <span className="mono">block {blockNumber.toString()}</span>}
          </div>
          {RAIL_INSTANCES.map((i) => (
            <InstanceBlock key={i} instance={i} />
          ))}
        </Reveal>
      </div>
    </section>
  )
}
