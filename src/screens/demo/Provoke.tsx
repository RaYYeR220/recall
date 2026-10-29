import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Chip, ExtLink } from '@/components/ui'
import { demoApi, DemoApiError, type ProvokeReply } from '@/lib/demoApi'
import { shortHash } from '@/lib/format'

const CASES: { id: string; label: string }[] = [
  { id: 'collect-too-early', label: 'Collect too early' },
  { id: 'over-cap', label: 'Go over the cap' },
  { id: 'refund-after-window', label: 'Refund after the window' },
  { id: 'withdraw-locked-reserve', label: 'Withdraw locked reserve' },
  { id: 'refund-b2b', label: 'Refund a B2B debit' },
  { id: 'prenotify-revoked', label: 'Pre-notify on a revoked mandate' },
]

const SOURCE: Record<ProvokeReply['source'], string> = {
  live: 'simulated now',
  replayed: 'replayed now',
  recorded: 'recorded',
}

function Result({ r }: { r: ProvokeReply }) {
  return (
    <li className="inner p-4" aria-label={`Result: ${r.label}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[13.5px] font-medium tracking-tight">{r.label}</span>
        <Chip tone="quiet" dot={false} mono>
          {SOURCE[r.source]}
        </Chip>
        {r.reproduced && (
          <Chip tone="lime" mono>
            refused as expected
          </Chip>
        )}
      </div>
      {r.refusal ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1" role="alert">
          <span className="mono text-[13px] text-danger">{r.refusal.name}</span>
          {r.refusal.code && <span className="mono rounded-pill px-2 py-[1px] text-[11.5px] text-danger ring-1 ring-danger/30">{r.refusal.code}</span>}
          <span className="text-[12.5px] text-ink-3">{r.refusal.message}</span>
        </div>
      ) : (
        <div className="mt-2.5 text-[12.5px] text-ink-3">
          Expected <span className="mono text-ink-2">{r.expected}</span>. The recorded refusal below is the proof.
        </div>
      )}
      <p className="mt-2 text-[12px] leading-snug text-ink-3">{r.note}</p>
      {r.recorded && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2.5 text-[12px] text-ink-3">
          <span>
            Real mainnet refusal: <span className="mono text-danger">{r.recorded.error}</span>
          </span>
          <ExtLink href={r.recorded.explorerUrl}>
            <span className="mono">{shortHash(r.recorded.txHash)}</span>
          </ExtLink>
        </div>
      )}
    </li>
  )
}

/** Six ways to try to break the rail. Each answer is the contract's own refusal, never a canned message. */
export function Provoke() {
  const [busy, setBusy] = useState<string | null>(null)
  const [results, setResults] = useState<ProvokeReply[]>([])
  const [error, setError] = useState<string | null>(null)

  async function run(id: string) {
    setBusy(id)
    setError(null)
    try {
      const r = await demoApi.provoke(id)
      setResults((prev) => [r, ...prev.filter((x) => x.case !== r.case)])
    } catch (e) {
      setError(e instanceof DemoApiError ? e.message : 'That did not work.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="panel p-5 sm:p-7" aria-labelledby="break-title">
      <h2 id="break-title" className="text-[20px] font-medium tracking-[-0.03em]">
        Try to break it
      </h2>
      <p className="mt-1.5 max-w-xl text-[13.5px] leading-snug text-ink-3">
        Each button asks the contract to do something it must refuse. You get its own error name and ISO code, and a link to the real
        mainnet transaction that reverted for the same reason.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        {CASES.map((c) => (
          <button key={c.id} type="button" className="btn btn-line btn-xs" disabled={busy !== null} onClick={() => void run(c.id)}>
            {busy === c.id && <Loader2 size={13} className="mr-1.5 animate-spin" aria-hidden="true" />}
            {c.label}
          </button>
        ))}
      </div>
      {error && (
        <p className="mt-4 text-[13px] text-danger" role="alert">
          {error}
        </p>
      )}
      {results.length > 0 && (
        <ul className="mt-5 space-y-3" aria-live="polite">
          {results.map((r) => (
            <Result key={r.case} r={r} />
          ))}
        </ul>
      )}
    </section>
  )
}
