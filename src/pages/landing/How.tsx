import type { ReactNode } from 'react'
import { Reveal } from '@/components/Reveal'
import { windowSegments, WindowBar } from '@/components/NoticeCard'

function Step({ n, title, children, illustration }: { n: string; title: string; children: ReactNode; illustration: ReactNode }) {
  return (
    <Reveal as="li" className="panel flex flex-col p-5 sm:p-6" delay={Number(n) * 0.08 - 0.08}>
      <div className="flex items-center gap-3">
        <span className="mono text-[12px] text-ink-3">{n}</span>
        <span className="h-px flex-1 bg-line" aria-hidden="true" />
      </div>
      <h3 className="mt-4 text-[22px] font-medium leading-tight tracking-[-0.03em]">{title}</h3>
      <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2 text-pretty">{children}</p>
      <div className="mt-6 flex-1" aria-hidden="true">
        {illustration}
      </div>
    </Reveal>
  )
}

function Avatar({ children }: { children: string }) {
  return <span className="avatar !h-8 !w-8 !text-[13px]">{children}</span>
}

function MandateSheet() {
  const rows: [string, string][] = [
    ['Per debit', 'up to €25.00'],
    ['Per 30 days', 'up to €100.00'],
    ['Notice', '14 days ahead'],
    ['Refund right', '8 weeks'],
  ]
  return (
    <div className="inner p-4">
      <div className="flex items-center justify-between text-[11.5px] text-ink-3">
        <span>Mandate</span>
        <span className="mono">0042</span>
      </div>
      <div className="mt-3 flex items-center gap-2.5">
        <Avatar>N</Avatar>
        <div>
          <div className="text-[13.5px] font-medium tracking-tight">Northwind Gym</div>
          <div className="text-[11.5px] text-ink-3">Core · refund right</div>
        </div>
      </div>
      <dl className="mt-3 divide-y divide-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between py-1.5 text-[12px]">
            <dt className="text-ink-3">{k}</dt>
            <dd className="mono text-ink-2">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex items-center gap-2.5">
        <span className="inline-flex h-8 items-center rounded-pill bg-ink px-3.5 text-[12.5px] font-medium text-ground">Sign mandate</span>
        <span className="chip chip-quiet">No gas</span>
      </div>
    </div>
  )
}

function AnnouncedNotice() {
  return (
    <div className="inner p-4">
      <div className="flex items-center justify-between">
        <span className="chip">
          <i />
          Announced
        </span>
        <span className="mono text-[11.5px] text-ink-3">in 13d 04h</span>
      </div>
      <div className="mt-4 flex items-baseline gap-2">
        <b className="text-[34px] font-medium leading-none tracking-[-0.05em]">€12.00</b>
        <span className="mono text-[12px] text-ink-2">EURC</span>
      </div>
      <div className="mono mt-2 text-[11.5px] text-ink-3">Northwind Gym · due 03 Sep</div>
      <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
        <span className="text-[12px] text-ink-3">Not right? Say so before it runs.</span>
        <span className="inline-flex h-7 items-center rounded-pill px-3 text-[12px] text-ink ring-1 ring-line-2">Refuse</span>
      </div>
    </div>
  )
}

function TakeBack() {
  return (
    <div className="inner p-4">
      <div className="flex items-center justify-between">
        <span className="chip chip-limetext">
          <i />
          Refunded · MD06
        </span>
        <span className="mono text-[11.5px] text-ink-3">1 block</span>
      </div>
      <div className="mt-4 text-[13px] text-ink-2">Paid back at once from the merchant's reserve.</div>
      <div className="mt-4">
        <WindowBar segments={windowSegments(6.86 * 7, 56)} dim />
        <div className="mono mt-2 flex justify-between text-[11px] text-ink-3">
          <span>03 Sep</span>
          <span>8 weeks</span>
          <span>29 Oct</span>
        </div>
      </div>
      <div className="mt-4 inline-flex h-8 items-center rounded-pill bg-accent px-3.5 text-[12.5px] font-medium text-ground">Take it back</div>
    </div>
  )
}

export function How() {
  return (
    <section id="how" className="mx-auto w-full max-w-app scroll-mt-20 px-4 pt-24 sm:px-8 sm:pt-32" aria-labelledby="how-title">
      <Reveal>
        <div className="eyebrow">How it works</div>
        <h2 id="how-title" className="section-title mt-3 max-w-2xl">
          Three steps. The last one is yours.
        </h2>
      </Reveal>
      <ol className="mt-10 grid gap-4 lg:grid-cols-3">
        <Step n="01" title="Sign once" illustration={<MandateSheet />}>
          You read the mandate in plain language and sign it. Limits per debit and per period are in what you sign. Anyone can submit
          the signature, so you never pay gas.
        </Step>
        <Step n="02" title="Get notified" illustration={<AnnouncedNotice />}>
          Before every debit the merchant announces the amount and the date, at least a day ahead. You can refuse it until it runs.
        </Step>
        <Step n="03" title="Take it back" illustration={<TakeBack />}>
          For eight weeks after any Core debit you can refund it in full, no questions asked. It comes back at once, from the
          merchant's reserve.
        </Step>
      </ol>
    </section>
  )
}
