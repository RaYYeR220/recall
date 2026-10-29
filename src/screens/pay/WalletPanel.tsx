import { useState } from 'react'
import type { Address } from 'viem'
import { networkInfo, RAIL_INSTANCES, type RailInstance } from '@recall/sdk'
import { Chip, DemoPill, Skeleton } from '@/components/ui'
import { useWalletFigures } from '@/hooks/useBalances'
import { usePayerActions } from '@/hooks/usePayerActions'
import { formatInput, formatToken, shortAddress, type TokenSymbol } from '@/lib/format'
import { useNetwork } from '@/lib/network'
import { parseUnitsExact } from '@/onchain-money'

const SYMBOLS: TokenSymbol[] = ['EURC', 'USDC']

function Editor({
  instance,
  symbol,
  current,
  viewAs,
  onClose,
}: {
  instance: RailInstance
  symbol: TokenSymbol
  current: bigint
  viewAs: Address | undefined
  onClose: () => void
}) {
  const actions = usePayerActions(instance, viewAs)
  const [text, setText] = useState('0')
  let value: bigint | null = null
  let problem: string | null = null
  try {
    value = parseUnitsExact(text || '0', 6)
    if (value < 0n) problem = 'Enter zero or more.'
    else if (value >= current) problem = `Must be lower than the current ${formatInput(current)}.`
  } catch {
    problem = 'Enter a plain number with at most 6 decimals.'
  }
  const busy = actions.busyKey === `allowance:${instance}:${symbol}`
  const run = async (path: 'sign' | 'self') => {
    if (value === null || problem) return
    await actions.reduceAllowance(symbol, value, path)
    onClose()
  }
  const inputId = `allowance-${instance}-${symbol}`
  return (
    <div className="inner mt-3 p-4">
      <label htmlFor={inputId} className="text-[12.5px] text-ink-2">
        Lower the {instance} allowance to
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2.5">
        <div className="relative w-40">
          <input
            id={inputId}
            className="field !pr-16"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            aria-invalid={!!problem}
            aria-describedby={problem ? `${inputId}-err` : undefined}
            onChange={(e) => setText(e.target.value)}
          />
          <span className="mono pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[11.5px] text-ink-3">{symbol}</span>
        </div>
        <button type="button" className="btn btn-light btn-xs" disabled={!!problem || busy || !!actions.blocked} title={actions.blocked ?? 'Sign a permit. No gas: a relay submits it.'} onClick={() => void run('sign')}>
          {busy ? 'Working…' : 'Lower (no gas)'}
        </button>
        <button type="button" className="btn-text" disabled={!!problem || busy || !!actions.blocked} onClick={() => void run('self')}>
          Send myself
        </button>
        <button type="button" className="btn-text" onClick={onClose}>
          Cancel
        </button>
      </div>
      {problem ? (
        <p id={`${inputId}-err`} className="mt-2 text-[12px] text-danger">
          {problem}
        </p>
      ) : (
        actions.blocked && <p className="mt-2 text-[12px] text-ink-3">{actions.blocked}</p>
      )}
    </div>
  )
}

/** Balances (ERC-20 view; on Arc this USDC is also the gas token, so it is shown once) and the allowance each rail holds. */
export function WalletPanel({ network, subject, viewAs }: { network: ReturnType<typeof useNetwork>['network']; subject: Address | undefined; viewAs: Address | undefined }) {
  const figures = useWalletFigures(network, subject)
  const info = networkInfo(network)
  const [editing, setEditing] = useState<{ instance: RailInstance; symbol: TokenSymbol } | null>(null)

  if (!subject) return null
  const d = figures.data
  return (
    <section aria-labelledby="wallet-title">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="wallet-title" className="text-[19px] font-medium tracking-[-0.03em]">
          Wallet &amp; allowance
        </h2>
        <span className="mono text-[12px] text-ink-3">{shortAddress(subject)}</span>
      </div>
      <div className="panel p-5 sm:p-6">
        {figures.isLoading && <Skeleton className="h-28" />}
        {figures.isError && (
          <p className="text-[13.5px] text-ink-2" role="alert">
            Couldn&rsquo;t read balances from {info.chain.name}.{' '}
            <button type="button" className="btn-text" onClick={() => void figures.refetch()}>
              Try again
            </button>
          </p>
        )}
        {d && (
          <>
            <dl className="grid grid-cols-2 gap-3">
              {SYMBOLS.map((s) => (
                <div key={s} className="inner px-4 py-3.5">
                  <dt className="text-[12px] text-ink-3">{s} balance</dt>
                  <dd className="mono mt-1.5 text-[18px] tracking-tight">{formatToken(s === 'EURC' ? d.eurc : d.usdc, s)}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-3">
              On Arc, USDC is also the gas token. It is one balance, shown once.
            </p>

            <div className="mt-6 text-[13px] font-medium tracking-tight">What each rail may pull</div>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
              An allowance is the most a rail can ever take, whatever a mandate says. Lowering it is a permit you sign, relayed for you.
            </p>
            <div className="mt-3 divide-y divide-line">
              {RAIL_INSTANCES.map((instance) => (
                <div key={instance} className="py-3">
                  <div className="flex items-center gap-2 text-[13px]">
                    <span className="font-medium">{instance === 'prod' ? 'Prod rail' : 'Demo rail'}</span>
                    {instance === 'demo' && <DemoPill />}
                  </div>
                  <ul className="mt-2 space-y-2">
                    {SYMBOLS.map((s) => {
                      const cur = d.allowance[instance][s === 'EURC' ? 'eurc' : 'usdc']
                      const open = editing?.instance === instance && editing.symbol === s
                      return (
                        <li key={s}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="mono text-[13px]">
                              {formatToken(cur, s)} <span className="text-[11px] text-ink-3">{s}</span>
                            </span>
                            {cur === 0n ? (
                              <Chip tone="quiet">None</Chip>
                            ) : (
                              !open && (
                                <button type="button" className="btn btn-line btn-xs" onClick={() => setEditing({ instance, symbol: s })}>
                                  Reduce allowance
                                </button>
                              )
                            )}
                          </div>
                          {open && <Editor instance={instance} symbol={s} current={cur} viewAs={viewAs} onClose={() => setEditing(null)} />}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
