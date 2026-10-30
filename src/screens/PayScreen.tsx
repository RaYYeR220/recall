import { RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getAddress, isAddress, type Hex } from 'viem'
import { MandateStatus, RAIL_INSTANCES, type RailInstance } from '@recall/sdk'
import { DemoPill, ErrorPanel, Skeleton, Button, EmptyState } from '@/components/ui'
import { NotDeployed } from '@/components/NotDeployed'
import { useDeployed } from '@/hooks/useDeployed'
import { useDebtorMandates, useCreditorNames, useFullHistories, useLapsed, useWindows } from '@/hooks/useDebtor'
import { usePayerActions } from '@/hooks/usePayerActions'
import { readRail, useWallet } from '@/hooks/useWallet'
import { useChainNow } from '@/lib/clock'
import { shortAddress } from '@/lib/format'
import { NETWORK_LABEL, useNetwork } from '@/lib/network'
import { bucketOf, momentOf, refundDeadlineOf, symbolOf, type DebitItem, type Windows } from '@/lib/model'
import { ConnectState } from './pay/ConnectState'
import { HistoryList, RefundableList, SectionHead, UpcomingList } from './pay/DebitList'
import { FeatureCard } from './pay/FeatureCard'
import { MandateList, type MandateRowModel } from './pay/MandateList'
import { WalletPanel } from './pay/WalletPanel'

const DEFAULT_LABEL: Record<RailInstance, string> = { prod: 'Prod rail', demo: 'Demo rail' }

/** /pay — the payer's page. Leads with the next refundable debit, everything else is read from RailLens. */
export function PayScreen() {
  const { network, setNetwork } = useNetwork()
  const wallet = useWallet()
  const [params, setParams] = useSearchParams()
  // Deep links: ?watch=<address>&rail=prod|demo opens a read-only view. The older ?as= and ?i= still work.
  const instance: RailInstance = (params.get('rail') ?? params.get('i')) === 'demo' ? 'demo' : 'prod'
  const asRaw = params.get('watch') ?? params.get('as')
  const focusRaw = params.get('refund')
  const focusId = focusRaw && /^0x[0-9a-fA-F]{64}$/.test(focusRaw) ? focusRaw.toLowerCase() : undefined
  const linkNetwork = params.get('network')
  const viewAs = asRaw && isAddress(asRaw, { strict: false }) ? getAddress(asRaw) : undefined
  const subject = viewAs ?? wallet.address
  const watching = !!viewAs && viewAs.toLowerCase() !== wallet.address?.toLowerCase()

  const { now, ready } = useChainNow(network)
  const deployed = useDeployed(network, instance)
  const windows = useWindows(network, instance)
  const live = deployed.data !== false
  const mandates = useDebtorMandates(network, instance, live ? subject : undefined)
  const actions = usePayerActions(instance, viewAs)
  const [expanded, setExpanded] = useState<Hex[]>([])

  const reader = useMemo(() => readRail(network, instance), [network, instance])
  const views = useMemo(() => mandates.data?.pages.flatMap((p) => p.views) ?? [], [mandates.data])
  const total = mandates.data?.pages[0] ? Number(mandates.data.pages[0].total) : 0
  const names = useCreditorNames(network, instance, views.map((v) => v.mandate.creditorId))
  const full = useFullHistories(network, instance, expanded)
  const activeIds = views.filter((v) => v.mandate.status === MandateStatus.ACTIVE).map((v) => v.id)
  const lapsedQ = useLapsed(network, instance, activeIds)

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (key === 'rail') next.delete('i')
    if (key === 'watch') next.delete('as')
    if (value === null) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }

  // A link made for the other network (for example from an assistant) switches to it once.
  useEffect(() => {
    if (linkNetwork !== 'arc' && linkNetwork !== 'arc-testnet') return
    if (linkNetwork !== network) setNetwork(linkNetwork)
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        next.delete('network')
        return next
      },
      { replace: true },
    )
  }, [linkNetwork, network, setNetwork, setParams])

  const w: Windows | undefined = windows.data
  const loading = !!subject && (mandates.isLoading || windows.isLoading || !ready || names.isLoading)
  const failed = mandates.isError || windows.isError
  const notDeployed = deployed.data === false

  // Build every debit once, from the lens views (or the full history for mandates the payer expanded).
  const items: DebitItem[] = views.flatMap((v) => {
    const idx = expanded.indexOf(v.id)
    const fullPage = idx >= 0 ? full[idx]?.data?.page : undefined
    const cols = fullPage ?? v.collections
    const creditorName = names.data?.[v.mandate.creditorId.toString()] ?? `Creditor #${v.mandate.creditorId}`
    return cols.map(
      (c): DebitItem => ({
        key: `${instance}:${v.id}:${c.e2eId}`,
        instance,
        collectionId: reader.collectionId(v.id, c.e2eId),
        mandateId: v.id,
        mandate: v.mandate,
        collection: c,
        creditorName,
        symbol: symbolOf(network, v.mandate.token),
      }),
    )
  })

  const upcoming: DebitItem[] = []
  const refundable: DebitItem[] = []
  const history: DebitItem[] = []
  if (w) {
    for (const it of items) {
      const b = bucketOf(it, now, w)
      ;(b === 'upcoming' ? upcoming : b === 'refundable' ? refundable : history).push(it)
    }
    upcoming.sort((a, b) => Number(a.collection.dueAt - b.collection.dueAt))
    refundable.sort((a, b) => refundDeadlineOf(a, w) - refundDeadlineOf(b, w))
    history.sort((a, b) => momentOf(b) - momentOf(a))
  }
  const focused = focusId ? items.find((it) => it.collectionId.toLowerCase() === focusId) : undefined
  const feature = focused ?? refundable[0] ?? upcoming[0] ?? history[0]

  const mandateRows: MandateRowModel[] = views.map((v) => {
    const li = activeIds.indexOf(v.id)
    const idx = expanded.indexOf(v.id)
    const shown = (idx >= 0 ? full[idx]?.data?.page.length : undefined) ?? v.collections.length
    return {
      id: v.id,
      mandate: v.mandate,
      creditorName: names.data?.[v.mandate.creditorId.toString()] ?? `Creditor #${v.mandate.creditorId}`,
      symbol: symbolOf(network, v.mandate.token),
      lapsed: li >= 0 ? lapsedQ[li]?.data === true : false,
      collectionCount: Number(v.collectionCount),
      shown,
    }
  })

  const demo = instance === 'demo'

  return (
    <main className="mx-auto w-full max-w-app px-4 pb-8 pt-10 sm:px-8 sm:pt-14">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div>
          <div className="eyebrow">Pay · {NETWORK_LABEL[network]}</div>
          <h1 className="mt-2 text-[clamp(30px,4vw,44px)] font-medium leading-[1.04] tracking-[-0.045em]">Your debits</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {demo && <DemoPill />}
          <div className="seg" role="group" aria-label="Rail">
            {RAIL_INSTANCES.map((i) => (
              <button key={i} type="button" aria-pressed={i === instance} onClick={() => setParam('rail', i === 'prod' ? null : i)}>
                {DEFAULT_LABEL[i]}
              </button>
            ))}
          </div>
        </div>
      </header>

      {watching && viewAs && (
        <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2" role="status">
          <span>
            Watching <span className="mono text-ink">{shortAddress(viewAs)}</span>, read-only.
          </span>
          <button type="button" className="btn-text" onClick={() => setParam('watch', null)}>
            Stop watching
          </button>
        </div>
      )}

      {focusId && (
        <div className="mt-5 rounded-panel border border-line-2 px-4 py-3 text-[13px] leading-snug text-ink-2" role="status">
          {focused
            ? 'An assistant prepared a refund for the debit below. Nothing has been signed: connect your wallet and press Take it back if you want it.'
            : subject
              ? 'The debit your assistant prepared a refund for is not in this view. Check the rail and the wallet.'
              : 'An assistant prepared a refund for you. Connect your wallet to see the debit and sign it yourself.'}
        </div>
      )}

      {wallet.wrongChain && (
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-panel border border-line-2 px-4 py-3 text-[13px] text-ink-2" role="status">
          Your wallet is on another network. Reading works; to act, switch to {NETWORK_LABEL[network]}.
          <Button variant="line" size="xs" disabled={wallet.switching} onClick={() => void wallet.ensureChain()}>
            Switch network
          </Button>
        </div>
      )}

      {/* the one important object */}
      <section className="pool mt-10" aria-label="Next refundable debit">
        {notDeployed ? (
          <NotDeployed network={network} instance={instance} />
        ) : !subject ? (
          <ConnectState onWatch={(a) => setParam('watch', getAddress(a))} />
        ) : failed ? (
          <div className="mx-auto max-w-xl">
            <ErrorPanel
              code="RpcError"
              title="Couldn't read your debits from Arc."
              action={
                <Button
                  variant="line"
                  size="sm"
                  onClick={() => {
                    void mandates.refetch()
                    void windows.refetch()
                  }}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Try again
                </Button>
              }
            >
              The network did not answer. Nothing on your side changed.
            </ErrorPanel>
          </div>
        ) : loading || !w ? (
          <div className="mx-auto w-full max-w-[760px]" aria-busy="true" aria-label="Loading your debits">
            <Skeleton className="h-[330px] !rounded-card" />
          </div>
        ) : feature ? (
          <div className="mx-auto w-full max-w-[760px]">
            <FeatureCard item={feature} now={now} w={w} actions={actions} />
            <p className="mono mt-3 text-center text-[11.5px] text-ink-3">
              {refundable.length > 0
                ? 'Next refundable debit'
                : upcoming.length > 0
                  ? 'Next announced debit'
                  : 'Latest debit'}{' '}
              · read from RailLens on {NETWORK_LABEL[network]}
            </p>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[760px]">
            <EmptyState
              title={total === 0 ? `No mandates for this wallet on the ${instance} rail.` : 'Your mandates are active. No debit has been announced.'}
              action={
                <div className="mt-2 flex flex-wrap justify-center gap-3">
                  <Link className="btn btn-light btn-sm" to="/demo">
                    Run a live debit
                  </Link>
                  <button type="button" className="btn btn-line btn-sm" onClick={() => setParam('rail', demo ? null : 'demo')}>
                    Look on the {demo ? 'prod' : 'demo'} rail
                  </button>
                </div>
              }
            >
              {total === 0
                ? 'Sign a merchant’s mandate link and it appears here, with every debit announced before it runs.'
                : `When a merchant announces a debit it appears here at least ${w ? Math.round(Number(w.minPrenotice) / (demo ? 1 : 86400)) : ''} ${demo ? 'seconds' : 'day'} ahead, with a Refuse button.`}
            </EmptyState>
          </div>
        )}
      </section>

      {live && subject && w && !failed && !loading && (
        <div className="mt-16 space-y-14">
          <section aria-labelledby="up-title">
            <SectionHead title="Upcoming" count={upcoming.length} hint="Announced. Refuse any of them before it runs." />
            <h2 id="up-title" className="sr-only">
              Upcoming
            </h2>
            <UpcomingList items={upcoming} now={now} w={w} actions={actions} />
          </section>

          <section>
            <SectionHead title="Refundable" count={refundable.length} hint="Inside the refund window." />
            <RefundableList items={refundable} now={now} w={w} actions={actions} />
          </section>

          <section>
            <SectionHead title="History" count={history.length} />
            <HistoryList items={history} now={now} w={w} />
          </section>

          <section>
            <SectionHead title="Mandates" count={total} />
            <MandateList
              rows={mandateRows}
              demo={demo}
              busyKey={actions.busyKey}
              blocked={actions.blocked}
              onRevoke={(id, p) => void actions.revoke(id, p)}
              onShowAll={(id) => setExpanded((e) => (e.includes(id) ? e : [...e, id]))}
              showingAll={(id) => expanded.includes(id)}
            />
            {mandates.hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button variant="line" size="sm" disabled={mandates.isFetchingNextPage} onClick={() => void mandates.fetchNextPage()}>
                  {mandates.isFetchingNextPage ? 'Loading…' : `Load more mandates (${views.length} of ${total})`}
                </Button>
              </div>
            )}
          </section>

          <WalletPanel network={network} subject={subject} viewAs={viewAs} />
        </div>
      )}
    </main>
  )
}
