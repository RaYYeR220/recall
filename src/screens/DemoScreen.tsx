import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { windowSegments, WindowBar } from '@/components/NoticeCard'
import { Chip, DemoPill, ErrorPanel, ExtLink, Skeleton } from '@/components/ui'
import { DEFAULT_DEMO_ASSET, demoApi, DemoApiError, loadRunAuth, saveRunAuth, type DemoAsset, type DemoEvent, type DemoStatus, type DemoStepName } from '@/lib/demoApi'
import { countdownText, shortAddress } from '@/lib/format'
import { notify } from '@/lib/notify'
import { Provoke } from './demo/Provoke'
import { STEPS, StepCard } from './demo/StepCard'

/** Chain time, ticking: the server's block time plus the seconds since we asked. */
function useChainClock(status: DemoStatus | undefined, fetchedAt: number): number {
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  if (!status) return 0
  return status.chainNow + Math.max(0, Math.floor((tick - fetchedAt) / 1000))
}

export function DemoScreen() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState<DemoStepName | null>(null)
  const [events, setEvents] = useState<Partial<Record<DemoStepName, DemoEvent[]>>>({})
  const [auth, setAuth] = useState(loadRunAuth)
  const [pick, setPick] = useState<DemoAsset>(DEFAULT_DEMO_ASSET)

  const q = useQuery({
    queryKey: ['demo-status'],
    queryFn: async () => ({ status: await demoApi.status(), at: Date.now() }),
    refetchInterval: (query) => (query.state.data?.status.active ? 3_000 : 10_000),
    retry: false,
  })
  const status = q.data?.status
  const now = useChainClock(status, q.data?.at ?? 0)
  const run = status?.run ?? null
  const mine = !!run && !!auth && auth.runId === run.id
  const watching = !!status?.active && !mine

  async function runStep(step: DemoStepName) {
    setBusy(step)
    try {
      const r = await demoApi.step(step, step === 'start' ? undefined : (auth ?? undefined), pick)
      if (r.runId && r.runToken) {
        const a = { runId: r.runId, token: r.runToken }
        saveRunAuth(a)
        setAuth(a)
      }
      setEvents((prev) => ({ ...prev, [step]: r.tx.events }))
      notify.success({ title: STEPS.find((s) => s.step === step)?.title ?? step, detail: r.note, network: status?.network, hash: r.tx.txHash, code: step === 'refund' ? 'MD06' : undefined })
      if (r.outcome === 'not-settled') notify.info({ title: 'The debit did not settle', detail: 'The collection was returned, so there is nothing to refund. Start again.' })
      await qc.invalidateQueries({ queryKey: ['demo-status'] })
    } catch (e) {
      if (e instanceof DemoApiError && e.refusal) {
        notify.refusal({ title: 'The contract refused it', error: { name: e.refusal.name, code: e.refusal.code, message: e.refusal.message } })
      } else if (e instanceof DemoApiError) {
        notify.info({ title: e.code === 'TooEarly' ? 'Not due yet' : 'The demo said no', detail: e.message, duration: 9000 })
      } else {
        notify.info({ title: 'The demo did not answer', detail: 'Try again.' })
      }
      await qc.invalidateQueries({ queryKey: ['demo-status'] })
    } finally {
      setBusy(null)
    }
  }

  if (q.isLoading) {
    return (
      <Shell>
        <Skeleton className="mt-8 h-96" />
      </Shell>
    )
  }
  if (q.isError || !status) {
    const e = q.error
    const none = e instanceof DemoApiError && (e.code === 'NoBackend' || e.code === 'Unreachable')
    return (
      <Shell>
        <div className="mt-8 max-w-xl">
          <ErrorPanel code={none ? 'DemoBackendUnavailable' : 'DemoError'} title={none ? 'The live demo backend isn\u2019t running here.' : 'The demo could not be loaded.'}>
            {none
              ? 'The demo runs as a server function next to the app. Deploy the api/ folder, or run the app through the dev server, to use it. The \u201cTry to break it\u201d buttons below need it too.'
              : (e)?.message}
          </ErrorPanel>
        </div>
      </Shell>
    )
  }

  const next = status.next
  const fin = run?.phase === 'refunded' || run?.phase === 'expired' || run?.phase === 'failed'
  const inactive = !run || fin || !status.active
  const noticeLeft = run?.dueAt !== undefined && run.phase === 'prenotified' ? Math.max(0, run.dueAt - now) : null
  const refundLeft = run?.phase === 'collected' && run.settledAt !== undefined && run.refundWindow !== undefined ? Math.max(0, run.settledAt + run.refundWindow - now) : null
  const stepState = (s: DemoStepName): 'todo' | 'next' | 'done' => {
    // A finished run never locks the page. The visitor who ran it keeps seeing their completed steps (with "Run again"
    // below); everyone else gets a fresh first step.
    if (inactive) {
      if (run && mine && run.txs.start) return run.txs[s] ? 'done' : 'todo'
      return s === 'start' ? 'next' : 'todo'
    }
    if (run && run.txs[s]) return 'done'
    return next === s ? 'next' : 'todo'
  }
  const disabled = (s: DemoStepName): string | undefined => {
    if (!status.configured) return 'Not switched on on this server'
    if (watching) return 'Another visitor is running the demo'
    if (s === 'start') {
      const a = status.assets?.[pick]
      if (a ? !a.ready : !status.ready) return (a?.problems ?? status.problems)[0] ?? 'Not ready'
    }
    if (s === 'collect' && noticeLeft !== null && noticeLeft > 0) return `Due in ${countdownText(noticeLeft)}`
    return undefined
  }

  // The asset on screen: the live run's, or the one about to be started.
  const asset: DemoAsset = status.active && run ? (run.asset ?? 'EURC') : pick

  return (
    <Shell>
      <div className="mt-8 grid gap-6 lg:grid-cols-[1.25fr_1fr] lg:gap-10">
        <div>
          {inactive && (
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="seg" role="group" aria-label="Asset for this run">
                {(['USDC', 'EURC'] as const).map((a) => (
                  <button key={a} type="button" aria-pressed={pick === a} onClick={() => setPick(a)}>
                    {a}
                  </button>
                ))}
              </div>
              <span className="text-[12.5px] text-ink-3">Each run moves 0.02 {pick}. USDC is the default.</span>
            </div>
          )}
          <ol className="space-y-3" aria-label="Demo steps">
            {STEPS.map((m) => (
              <StepCard
                key={m.step}
                meta={m}
                state={stepState(m.step)}
                busy={busy === m.step}
                hash={stepState(m.step) === 'done' ? run?.txs[m.step] : undefined}
                explorerUrl={run?.explorer[m.step]}
                events={events[m.step] ?? []}
                disabledReason={disabled(m.step)}
                onRun={() => void runStep(m.step)}
                extra={
                  m.step === 'collect' && noticeLeft !== null ? (
                    <p className="mono mt-3 text-[12.5px] text-ink-2" role="timer">
                      Notice period: {noticeLeft > 0 ? `${countdownText(noticeLeft)} left` : 'over, due now'}
                    </p>
                  ) : undefined
                }
              />
            ))}
          </ol>
          {fin && (
            <p className="mt-4 text-[13px] text-ink-3" role="status">
              {run?.phase === 'refunded'
                ? 'Done. The money went back to the house payer, so the run only cost gas.'
                : run?.phase === 'expired'
                  ? 'The refund window closed before it was used. The money is the merchant\u2019s now. Start again.'
                  : 'That run ended without a refund. Start again.'}
              {mine && (
                <button
                  type="button"
                  className="btn btn-line btn-xs ml-3"
                  onClick={() => {
                    saveRunAuth(null)
                    setAuth(null)
                    setEvents({})
                  }}
                >
                  Run again
                </button>
              )}
            </p>
          )}
        </div>

        <div className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <section className="panel p-5" aria-label="Clocks">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-medium tracking-tight">Clocks</h2>
              <DemoPill />
            </div>
            <dl className="mt-4 space-y-4">
              <div>
                <dt className="text-[12px] text-ink-3">Notice period (14 days, scaled)</dt>
                <dd className="mono mt-1 text-[15px] text-ink">{noticeLeft === null ? '—' : noticeLeft > 0 ? countdownText(noticeLeft) : 'over'}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-ink-3">Refund window (8 weeks, scaled)</dt>
                <dd className="mono mt-1 text-[15px] text-ink">{refundLeft === null ? '—' : refundLeft > 0 ? countdownText(refundLeft) : 'closed'}</dd>
                {run && refundLeft !== null && run.refundWindow !== undefined && run.settledAt !== undefined && (
                  <div className="mt-2.5">
                    <WindowBar segments={windowSegments(now - run.settledAt, run.refundWindow)} />
                  </div>
                )}
              </div>
            </dl>
          </section>

          <section className="panel p-5" aria-label="About this demo">
            <h2 className="text-[15px] font-medium tracking-tight">What is real here</h2>
            <ul className="mt-3 space-y-2 text-[13px] leading-snug text-ink-3">
              <li>Every step is a real transaction on Arc {status.network === 'arc' ? 'mainnet' : 'testnet'}, on the demo rail.</li>
              <li>A house merchant and a house payer hold the funds. Each debit is 0.02 {asset} and the refund returns it.</li>
              <li>
                {status.runsToday} of {status.runsPerDay} runs used today. One run at a time.
              </li>
            </ul>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
              <ExtLink href={`${status.network === 'arc' ? 'https://explorer.arc.io' : 'https://explorer.testnet.arc.io'}/address/${status.rail}`}>
                <span className="mono">demo rail {shortAddress(status.rail)}</span>
              </ExtLink>
            </div>
            {!status.configured && (
              <p className="mono mt-4 rounded-panel border border-line px-3 py-2.5 text-[12px] leading-snug text-ink-3">
                Not switched on: this server needs {status.missing?.join(', ')}.
              </p>
            )}
            {status.configured && !status.ready && status.problems.length > 0 && (
              <ul className="mt-4 space-y-1.5 text-[12.5px] text-danger" role="alert">
                {status.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <div className="mt-10">
        <Provoke />
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-app px-4 pb-8 pt-10 sm:px-8 sm:pt-16">
      <div className="max-w-2xl">
        <div className="flex flex-wrap items-center gap-2">
          <span className="eyebrow">Live demo</span>
          <DemoPill />
          <Chip tone="quiet" dot={false} mono>
            no wallet needed
          </Chip>
        </div>
        <h1 className="section-title mt-3">Run a real debit, and take it back.</h1>
        <p className="lede mt-3">
          Four clicks on Arc mainnet. On this rail a week lasts a minute, so you can watch the pre-notice run out and the whole refund
          window open and close.
        </p>
      </div>
      {children}
    </main>
  )
}
