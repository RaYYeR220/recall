import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { tokenBySymbol } from '@recall/sdk'
import { Chip, Skeleton } from '@/components/ui'
import { useCoverage } from '@/hooks/useMerchant'
import { useWalletFigures } from '@/hooks/useBalances'
import { useRail } from '@/hooks/useWallet'
import { runTx } from '@/lib/actions'
import { formatAmountPlain, type TokenSymbol } from '@/lib/format'
import { useNetwork } from '@/lib/network'
import { parseUsdc } from '@/onchain-money'
import { useMerchantCtx } from './ctx'

interface Cov {
  reserveTotal: bigint
  reserveLocked: bigint
  held: bigint
  openExposure: bigint
}

function parse(v: string): bigint | null {
  try {
    const n = parseUsdc(v.trim())
    return n > 0n ? n : null
  } catch {
    return null
  }
}

function Meter({ cov, symbol }: { cov: Cov; symbol: TokenSymbol }) {
  const free = cov.reserveTotal - cov.reserveLocked
  const total = free + cov.reserveLocked + cov.held
  const pct = (n: bigint) => (total === 0n ? 0 : Number((n * 10000n) / total) / 100)
  const f = formatAmountPlain
  return (
    <div>
      <div
        className="flex h-[10px] gap-[3px]"
        role="img"
        aria-label={`${symbol}: ${f(free)} free, ${f(cov.reserveLocked)} locked, ${f(cov.held)} held. Open exposure ${f(cov.openExposure)}.`}
      >
        {total === 0n ? (
          <i className="w-full rounded-seg bg-ink-4/70" />
        ) : (
          <>
            {free > 0n && <i className="rounded-seg bg-white/[.16]" style={{ width: `${pct(free)}%` }} />}
            {cov.reserveLocked > 0n && <i className="rounded-seg bg-accent" style={{ width: `${pct(cov.reserveLocked)}%` }} />}
            {cov.held > 0n && <i className="rounded-seg bg-ink" style={{ width: `${pct(cov.held)}%` }} />}
          </>
        )}
      </div>
      <dl className="mono mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[12px] sm:grid-cols-4">
        <div>
          <dt className="flex items-center gap-1.5 text-ink-3">
            <i className="h-1.5 w-1.5 rounded-full bg-white/30" aria-hidden="true" />
            free
          </dt>
          <dd className="mt-0.5 text-[14px] text-ink">{f(free)}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1.5 text-ink-3">
            <i className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
            locked
          </dt>
          <dd className="mt-0.5 text-[14px] text-ink">{f(cov.reserveLocked)}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1.5 text-ink-3">
            <i className="h-1.5 w-1.5 rounded-full bg-ink" aria-hidden="true" />
            held
          </dt>
          <dd className="mt-0.5 text-[14px] text-ink">{f(cov.held)}</dd>
        </div>
        <div>
          <dt className="text-ink-3">open exposure</dt>
          <dd className="mt-0.5 text-[14px] text-ink">{f(cov.openExposure)}</dd>
        </div>
      </dl>
      <p className="mt-3 text-[12px] leading-snug text-ink-3">
        {cov.openExposure === 0n
          ? 'Nothing is refundable right now, so the whole reserve is yours to withdraw.'
          : `${f(cov.openExposure)} can still be taken back: ${f(cov.reserveLocked)} is locked in your reserve and ${f(cov.held)} is held by the contract.`}
      </p>
    </div>
  )
}

function TokenCard({ symbol, cov }: { symbol: TokenSymbol; cov: Cov }) {
  const { network } = useNetwork()
  const { instance, creditor, wallet, isOwner, gate, readOnly } = useMerchantCtx()
  const rail = useRail(instance)
  const qc = useQueryClient()
  const figures = useWalletFigures(network, wallet)
  const token = tokenBySymbol(network, symbol).address
  const [fund, setFund] = useState('')
  const [take, setTake] = useState('')
  const [busy, setBusy] = useState<'fund' | 'withdraw' | null>(null)
  const free = cov.reserveTotal - cov.reserveLocked
  const fundAmt = parse(fund)
  const takeAmt = parse(take)
  const balance = figures.data ? figures.data[symbol === 'EURC' ? 'eurc' : 'usdc'] : undefined
  const overFree = takeAmt !== null && takeAmt > free

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['coverage'] })
    await qc.invalidateQueries({ queryKey: ['wallet-figures'] })
  }

  async function doFund() {
    if (fundAmt === null) return
    setBusy('fund')
    try {
      const allowance = await rail.allowance(token, wallet)
      if (allowance < fundAmt) {
        const a = await runTx({
          network,
          pendingTitle: `Allow the rail to take ${symbol}`,
          title: 'Allowance set',
          successDetail: 'Now the reserve deposit.',
          send: () => rail.setAllowance(token, fundAmt),
        })
        if (!a.ok) return
      }
      const res = await runTx({
        network,
        pendingTitle: 'Fund reserve',
        title: 'Reserve funded',
        successDetail: `${formatAmountPlain(fundAmt)} ${symbol} added to ${creditor.name}'s reserve.`,
        send: () => rail.fundReserve(creditor.id, token, fundAmt),
      })
      if (res.ok) {
        setFund('')
        await refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  async function doWithdraw() {
    if (takeAmt === null) return
    setBusy('withdraw')
    try {
      // The SDK simulates before it sends: an amount above the free reserve is refused with ReserveLocked and costs nothing.
      const res = await runTx({
        network,
        pendingTitle: 'Withdraw free reserve',
        title: 'Reserve withdrawn',
        successDetail: `${formatAmountPlain(takeAmt)} ${symbol} sent to ${wallet.slice(0, 6)}…${wallet.slice(-4)}.`,
        send: () => rail.withdrawReserve(creditor.id, token, takeAmt, wallet),
      })
      if (res.ok) {
        setTake('')
        await refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="panel p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[17px] font-medium tracking-tight">{symbol} reserve</h3>
        <span className="mono text-[12px] text-ink-3">total {formatAmountPlain(cov.reserveTotal)}</span>
      </div>
      <div className="mt-5">
        <Meter cov={cov} symbol={symbol} />
      </div>

      <div className="mt-6 grid gap-5 border-t border-line pt-5 sm:grid-cols-2">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void doFund()
          }}
        >
          <label className="text-[12.5px] text-ink-3" htmlFor={`fund-${symbol}`}>
            Fund reserve
          </label>
          <div className="mt-1.5 flex gap-2">
            <input id={`fund-${symbol}`} className="field" inputMode="decimal" placeholder="0.00" value={fund} onChange={(e) => setFund(e.target.value)} />
            <button type="submit" className="btn btn-light btn-xs flex-none" disabled={fundAmt === null || busy !== null || !!gate} title={gate}>
              {busy === 'fund' ? 'Working…' : 'Fund'}
            </button>
          </div>
          {!readOnly && <p className="mono mt-1.5 text-[11.5px] text-ink-3">your balance {balance === undefined ? '…' : formatAmountPlain(balance)}</p>}
        </form>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void doWithdraw()
          }}
        >
          <label className="text-[12.5px] text-ink-3" htmlFor={`take-${symbol}`}>
            Withdraw free reserve
          </label>
          <div className="mt-1.5 flex gap-2">
            <input id={`take-${symbol}`} className="field" inputMode="decimal" placeholder="0.00" value={take} onChange={(e) => setTake(e.target.value)} />
            <button type="submit" className="btn btn-line btn-xs flex-none" disabled={takeAmt === null || busy !== null || !!gate || !isOwner} title={!isOwner ? 'Only the owner can withdraw' : gate}>
              {busy === 'withdraw' ? 'Working…' : 'Withdraw'}
            </button>
          </div>
          <button type="button" className="btn-text mt-1.5 text-[11.5px]" onClick={() => setTake(formatAmountPlain(free).replace(/,/g, ''))}>
            max free: <span className="mono">{formatAmountPlain(free)}</span>
          </button>
          {overFree && (
            <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-danger" role="alert">
              <span className="mono">ReserveLocked</span>
              <span className="text-ink-3">Only {formatAmountPlain(free)} is free. The rest backs refundable debits. Sending it will be refused.</span>
            </p>
          )}
          {!isOwner && <p className="mt-1.5 text-[12px] text-ink-3">Operators cannot withdraw.</p>}
        </form>
      </div>
    </div>
  )
}

/** The merchant console leads with this: what is free, what is locked, and what is held against open exposure. */
export function Coverage() {
  const { network } = useNetwork()
  const { instance, creditor } = useMerchantCtx()
  const { data, isLoading, isError, refetch } = useCoverage(network, instance, creditor.id)
  return (
    <section aria-labelledby="coverage-title">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="coverage-title" className="section-title">
          Coverage
        </h2>
        <Chip tone="quiet" dot={false} mono>
          {creditor.name} · #{creditor.id.toString()}
        </Chip>
      </div>
      <p className="lede mt-2 max-w-2xl">Every refundable cent is backed. This is what backs yours.</p>
      {isLoading && (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      )}
      {isError && (
        <div className="mt-5 rounded-panel border border-danger/30 p-4" role="alert">
          <div className="text-[13.5px]">Couldn&rsquo;t read your coverage.</div>
          <button type="button" className="btn btn-line btn-xs mt-3" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      )}
      {data && (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <TokenCard symbol="EURC" cov={data.eurc} />
          <TokenCard symbol="USDC" cov={data.usdc} />
        </div>
      )}
    </section>
  )
}
