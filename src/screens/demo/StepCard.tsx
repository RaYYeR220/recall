import { Check, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, ExtLink } from '@/components/ui'
import type { DemoEvent, DemoStepName } from '@/lib/demoApi'
import { shortHash } from '@/lib/format'

export interface StepMeta {
  step: DemoStepName
  n: number
  title: string
  blurb: string
  cta: string
}

export const STEPS: StepMeta[] = [
  { step: 'start', n: 1, title: 'Sign the mandate', blurb: 'The payer signs once. A relayer submits it, so the payer pays no gas.', cta: 'Sign and activate' },
  { step: 'prenotify', n: 2, title: 'Pre-notify', blurb: 'The merchant announces 0.02 EURC and a due date, after the notice period.', cta: 'Announce the debit' },
  { step: 'collect', n: 3, title: 'Collect', blurb: 'Once it is due, anyone can run the collection. The merchant is paid at once.', cta: 'Collect' },
  { step: 'refund', n: 4, title: 'Take it back', blurb: 'The payer signs a refund inside the window. The money returns in full.', cta: 'Refund' },
]

function EventList({ events }: { events: DemoEvent[] }) {
  if (events.length === 0) return null
  return (
    <ul className="mt-3 space-y-1.5" aria-label="Decoded events">
      {events.map((e, i) => (
        <li key={i} className="mono break-words text-[11.5px] leading-snug text-ink-3">
          <span className="text-accent">{e.name}</span>
          {Object.entries(e.args)
            .slice(0, 5)
            .map(([k, v]) => (
              <span key={k}>
                {' '}
                {k}=<span className="text-ink-2">{v.startsWith('0x') && v.length > 20 ? shortHash(v) : v}</span>
              </span>
            ))}
        </li>
      ))}
    </ul>
  )
}

export function StepCard({
  meta,
  state,
  busy,
  hash,
  explorerUrl,
  events,
  extra,
  disabledReason,
  onRun,
}: {
  meta: StepMeta
  state: 'todo' | 'next' | 'done'
  busy: boolean
  hash?: string
  explorerUrl?: string
  events: DemoEvent[]
  extra?: ReactNode
  disabledReason?: string
  onRun: () => void
}) {
  return (
    <li className={`panel p-5 ${state === 'next' ? 'border-line-2' : ''} ${state === 'todo' ? 'opacity-70' : ''}`} aria-current={state === 'next' ? 'step' : undefined}>
      <div className="flex items-start gap-3.5">
        <span
          className={`mono grid h-7 w-7 flex-none place-items-center rounded-full text-[12px] ${
            state === 'done' ? 'bg-accent text-ground' : state === 'next' ? 'text-accent ring-1 ring-accent' : 'text-ink-3 ring-1 ring-line-2'
          }`}
        >
          {state === 'done' ? <Check size={14} aria-hidden="true" /> : meta.n}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[16px] font-medium tracking-tight">{meta.title}</h3>
          <p className="mt-1 text-[13.5px] leading-snug text-ink-3">{meta.blurb}</p>
          {extra}
          {hash && explorerUrl && (
            <div className="mt-3">
              <ExtLink href={explorerUrl}>
                <span className="mono">{shortHash(hash)}</span>
              </ExtLink>
            </div>
          )}
          <EventList events={events} />
          {state === 'next' && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button variant={meta.step === 'refund' ? 'accent' : 'light'} size="sm" disabled={busy || !!disabledReason} onClick={onRun}>
                {busy ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    Working…
                  </span>
                ) : (
                  meta.cta
                )}
              </Button>
              {disabledReason && <span className="mono text-[12px] text-ink-3">{disabledReason}</span>}
            </div>
          )}
        </div>
      </div>
    </li>
  )
}
