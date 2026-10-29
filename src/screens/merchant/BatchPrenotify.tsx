import { useRef, useState } from 'react'
import { decodeRailError, parseBatchCsv, type BatchError, type BatchRow, type RailError } from '@recall/sdk'
import { Chip } from '@/components/ui'
import { TxLink } from '@/components/ui'
import { useRail } from '@/hooks/useWallet'
import { isUserRejection } from '@/lib/actions'
import { fmtDayTime, formatAmountPlain, shortHash } from '@/lib/format'
import { useNetwork } from '@/lib/network'
import { notify } from '@/lib/notify'
import { useMerchantCtx } from './ctx'
import { newE2eId } from './Mandates'

const TEMPLATE = 'mandateId,amount,dueAt,remittance\n0x…,12.00,2026-12-01T09:00:00Z,Monthly membership\n'

type Verdict = { kind: 'ok' } | { kind: 'refused'; error: RailError } | { kind: 'sent'; hash: string } | { kind: 'failed'; error: RailError }

/** Pre-notify many debits from a CSV. A dry run simulates every row against the chain first and says which would be refused. */
export function BatchPrenotify() {
  const { network } = useNetwork()
  const { instance, gate } = useMerchantCtx()
  const rail = useRail(instance)
  const [text, setText] = useState('')
  const [rows, setRows] = useState<BatchRow[]>([])
  const [errors, setErrors] = useState<BatchError[]>([])
  const [verdicts, setVerdicts] = useState<Record<number, Verdict>>({})
  const [busy, setBusy] = useState<'dry' | 'send' | null>(null)
  const e2e = useRef<Record<number, `0x${string}`>>({})

  function load(t: string) {
    setText(t)
    const parsed = parseBatchCsv(t)
    setRows(parsed.rows)
    setErrors(parsed.errors)
    setVerdicts({})
    e2e.current = {}
  }

  const idFor = (line: number) => (e2e.current[line] ??= newE2eId())

  async function dryRun() {
    setBusy('dry')
    const next: Record<number, Verdict> = {}
    for (const r of rows) {
      try {
        await rail.simulatePrenotify(r.mandateId, r.amount, r.dueAt, idFor(r.line), r.remittance)
        next[r.line] = { kind: 'ok' }
      } catch (e) {
        next[r.line] = { kind: 'refused', error: decodeRailError(e) }
      }
      setVerdicts({ ...next })
    }
    setBusy(null)
  }

  async function sendOk() {
    setBusy('send')
    const next = { ...verdicts }
    for (const r of rows) {
      if (next[r.line]?.kind !== 'ok') continue
      try {
        const hash = await rail.prenotify(r.mandateId, r.amount, r.dueAt, idFor(r.line), r.remittance)
        await rail.publicClient.waitForTransactionReceipt({ hash })
        next[r.line] = { kind: 'sent', hash }
      } catch (e) {
        if (isUserRejection(e)) {
          notify.info({ title: 'Stopped', detail: 'You closed the wallet prompt. The rest were not sent.' })
          setVerdicts({ ...next })
          setBusy(null)
          return
        }
        next[r.line] = { kind: 'failed', error: decodeRailError(e) }
      }
      setVerdicts({ ...next })
    }
    setBusy(null)
  }

  const okCount = Object.values(verdicts).filter((v) => v.kind === 'ok').length
  const refusedCount = Object.values(verdicts).filter((v) => v.kind === 'refused').length
  const dry = Object.keys(verdicts).length === rows.length && rows.length > 0

  return (
    <section className="panel p-5 sm:p-6" aria-labelledby="batch-title">
      <h2 id="batch-title" className="text-[20px] font-medium tracking-[-0.03em]">
        Batch pre-notify
      </h2>
      <p className="mt-1.5 max-w-xl text-[13.5px] leading-snug text-ink-3">
        Paste or upload a CSV with <span className="mono">mandateId, amount, dueAt, remittance</span>. The dry run checks every row against the chain and
        shows which would be refused, and why, before anything is sent.
      </p>
      <textarea
        className="field mt-4 !h-32 !rounded-panel py-3"
        value={text}
        onChange={(e) => load(e.target.value)}
        placeholder={TEMPLATE}
        spellCheck={false}
        aria-label="Batch CSV"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="btn btn-line btn-xs cursor-pointer">
          Upload a file
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void f.text().then(load)
            }}
          />
        </label>
        <button type="button" className="btn btn-light btn-xs" disabled={rows.length === 0 || busy !== null || !!gate} title={gate} onClick={() => void dryRun()}>
          {busy === 'dry' ? 'Checking…' : `Dry run ${rows.length || ''}`.trim()}
        </button>
        <button type="button" className="btn btn-line btn-xs" disabled={!dry || okCount === 0 || busy !== null || !!gate} title={gate} onClick={() => void sendOk()}>
          {busy === 'send' ? 'Sending…' : `Send ${okCount} accepted`}
        </button>
        {dry && (
          <span className="mono text-[12px] text-ink-3" role="status">
            {okCount} would pass · <span className={refusedCount ? 'text-danger' : ''}>{refusedCount} refused</span>
          </span>
        )}
      </div>
      {errors.length > 0 && (
        <ul className="mt-4 space-y-1 text-[12.5px] text-danger" role="alert">
          {errors.map((e) => (
            <li key={`${e.line}-${e.message}`}>
              <span className="mono">line {e.line}</span> {e.message}
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {rows.map((r) => {
            const v = verdicts[r.line]
            return (
              <li key={r.line} className="grid gap-1.5 py-2.5 sm:grid-cols-[3rem_1fr_auto] sm:items-center sm:gap-4">
                <span className="mono text-[11.5px] text-ink-3">#{r.line}</span>
                <span className="mono text-[12.5px] text-ink-2">
                  {shortHash(r.mandateId)} · {formatAmountPlain(r.amount)} · due {fmtDayTime(Number(r.dueAt))}
                  {r.remittance ? ` · ${r.remittance}` : ''}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {!v && <Chip tone="quiet" dot={false}>not checked</Chip>}
                  {v?.kind === 'ok' && <Chip tone="lime">would pass</Chip>}
                  {v?.kind === 'refused' && (
                    <span className="flex flex-wrap items-center gap-2" role="alert">
                      <span className="mono text-[12px] text-danger">{v.error.name}</span>
                      {v.error.code && <span className="mono rounded-pill px-2 py-[1px] text-[11px] text-danger ring-1 ring-danger/30">{v.error.code}</span>}
                    </span>
                  )}
                  {v?.kind === 'failed' && <span className="mono text-[12px] text-danger">{v.error.name}</span>}
                  {v?.kind === 'sent' && <TxLink network={network} hash={v.hash} />}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-4 text-[11.5px] leading-snug text-ink-3">
        Each row is checked against the chain as it is now. Rows on the same mandate that add up past its period cap can still be refused when sent.
      </p>
    </section>
  )
}
