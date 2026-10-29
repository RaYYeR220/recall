import { formatAbiItem } from 'viem/utils'
import { debitRailAbi, RETURN_CODE_LABELS, railAddresses, RAIL_INSTANCES, RAIL_NETWORKS, networkInfo, addressUrl } from '@recall/sdk'
import { Chip, DemoPill, ExtLink } from '@/components/ui'
import { Reveal } from '@/components/Reveal'
import { shortAddress } from '@/lib/format'
import { CLIENT, ERRORS, INSTALL, LINK, MCP_TOOLS, PRENOTIFY, REFUND } from './developers/snippets'

function Code({ children, label }: { children: string; label: string }) {
  return (
    <pre
      className="inner mono overflow-x-auto p-4 text-[12.5px] leading-relaxed text-ink-2"
      tabIndex={0}
      aria-label={label}
    >
      <code>{children}</code>
    </pre>
  )
}

function Section({ id, title, lede, children }: { id: string; title: string; lede?: string; children: React.ReactNode }) {
  return (
    <Reveal as="section" className="mt-16 scroll-mt-24">
      <h2 id={id} className="section-title">
        {title}
      </h2>
      {lede && <p className="lede mt-2 max-w-2xl">{lede}</p>}
      <div className="mt-6">{children}</div>
    </Reveal>
  )
}

const WRITE = new Set(['nonpayable', 'payable'])

type AbiFn = Extract<(typeof debitRailAbi)[number], { type: 'function' }>

function AbiList({ items }: { items: readonly AbiFn[] }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((f) => (
        <li key={formatAbiItem(f)} className="py-2.5">
          <code className="mono break-words text-[12.5px] text-ink-2">{formatAbiItem(f).replace(/^function /, '')}</code>
        </li>
      ))}
    </ul>
  )
}

function ContractApi() {
  const fns = debitRailAbi.filter((x) => x.type === 'function')
  const writes = fns.filter((f) => WRITE.has(f.stateMutability))
  const reads = fns.filter((f) => !WRITE.has(f.stateMutability))
  const events = debitRailAbi.filter((x) => x.type === 'event')
  const errors = debitRailAbi.filter((x) => x.type === 'error')
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="panel p-5 sm:p-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[16px] font-medium tracking-tight">Writes</h3>
          <span className="mono text-[11.5px] text-ink-3">{writes.length}</span>
        </div>
        <AbiList items={writes} />
      </div>
      <div className="panel p-5 sm:p-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[16px] font-medium tracking-tight">Reads</h3>
          <span className="mono text-[11.5px] text-ink-3">{reads.length}</span>
        </div>
        <AbiList items={reads} />
        <p className="mono mt-4 text-[11.5px] text-ink-3">
          {events.length} events · {errors.length} custom errors, all decoded by <code>decodeRailError</code>
        </p>
      </div>
    </div>
  )
}

export function DevelopersScreen() {
  return (
    <main className="mx-auto w-full max-w-app px-4 pb-8 pt-10 sm:px-8 sm:pt-16">
      <div className="max-w-2xl">
        <div className="eyebrow">Developers</div>
        <h1 className="section-title mt-3">Bill within a mandate, from code.</h1>
        <p className="lede mt-3">
          The SDK is TypeScript on viem, and nothing else. Everything below runs against the same contracts as this site.
        </p>
        <nav className="mt-5 flex flex-wrap gap-2 text-[13px]" aria-label="On this page">
          {[
            ['quickstart', 'Quick start'],
            ['contract', 'Contract API'],
            ['codes', 'R-codes'],
            ['mcp', 'MCP tools'],
            ['addresses', 'Addresses'],
          ].map(([id, label]) => (
            <a key={id} className="btn btn-line btn-xs" href={`#${id}`}>
              {label}
            </a>
          ))}
        </nav>
      </div>

      <Section id="quickstart" title="Quick start" lede="Create a checkout link, announce a debit, collect it, and give the money back.">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <h3 className="text-[14px] font-medium">1. Install</h3>
            <Code label="Install">{INSTALL}</Code>
            <h3 className="text-[14px] font-medium">2. A client</h3>
            <Code label="Create a client">{CLIENT}</Code>
            <h3 className="text-[14px] font-medium">3. A checkout link</h3>
            <Code label="Create a checkout link">{LINK}</Code>
          </div>
          <div className="space-y-4">
            <h3 className="text-[14px] font-medium">4. Pre-notify and collect</h3>
            <Code label="Pre-notify and collect">{PRENOTIFY}</Code>
            <h3 className="text-[14px] font-medium">5. Refund</h3>
            <Code label="Refund">{REFUND}</Code>
            <h3 className="text-[14px] font-medium">6. Read refusals</h3>
            <Code label="Decode errors">{ERRORS}</Code>
          </div>
        </div>
        <p className="mt-5 max-w-2xl text-[13px] leading-relaxed text-ink-3">
          A checkout link carries a creditor name nobody signed. Always run <code className="mono">verifyCheckoutLink</code> before showing or
          acting on one: it checks the signature, reads the name from the rail and rebuilds the mandate text from the offer&rsquo;s own fields.
        </p>
      </Section>

      <Section id="contract" title="Contract API" lede="Read straight from the compiled ABI of DebitRail. The contract has no owner, no fees and no upgrade path.">
        <ContractApi />
      </Section>

      <Section id="codes" title="R-codes" lede="ISO 20022 reason codes. A payer-side failure never reverts: it returns the collection with one of these.">
        <div className="panel overflow-x-auto p-2 sm:p-3">
          <table className="w-full min-w-[420px] text-left text-[13.5px]">
            <thead>
              <tr className="text-[11.5px] text-ink-3">
                <th className="px-3 py-2 font-normal">Code</th>
                <th className="px-3 py-2 font-normal">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(RETURN_CODE_LABELS).map(([code, label]) => (
                <tr key={code} className="border-t border-line">
                  <td className="px-3 py-2.5">
                    <span className={`mono ${code === 'MD06' ? 'text-accent' : 'text-ink'}`}>{code}</span>
                  </td>
                  <td className="px-3 py-2.5 text-ink-2">{label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="mcp" title="MCP tools" lede="So an agent can bill within a mandate while the person keeps the refund right.">
        <div className="panel p-5 sm:p-6">
          <Chip tone="quiet" mono>
            planned, not shipped yet
          </Chip>
          <ul className="mt-3 divide-y divide-line">
            {MCP_TOOLS.map((t) => (
              <li key={t.name} className="grid gap-1 py-3 sm:grid-cols-[17rem_1fr] sm:gap-6">
                <code className="mono text-[12.5px] text-ink">{t.name}</code>
                <span className="text-[13.5px] text-ink-2">{t.does}</span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section id="addresses" title="Deployed addresses">
        <div className="grid gap-6 lg:grid-cols-2">
          {RAIL_NETWORKS.map((n) => {
            const info = networkInfo(n)
            const a = railAddresses(n)
            return (
              <div key={n} className="panel p-5 sm:p-6">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-[16px] font-medium tracking-tight">{info.chain.name}</h3>
                  <span className="mono text-[11.5px] text-ink-3">chain {info.chainId}</span>
                </div>
                <ul className="mt-3 divide-y divide-line">
                  {RAIL_INSTANCES.flatMap((i) => [
                    { label: `DebitRail · ${i}`, address: a[i].rail, demo: i === 'demo' },
                    { label: `RailLens · ${i}`, address: a[i].lens, demo: false },
                  ]).map((r) => (
                    <li key={r.label} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[13px]">
                      <span className="text-ink-3">{r.label}</span>
                      {r.demo && <DemoPill />}
                      <span className="ml-auto">
                        <ExtLink href={addressUrl(n, r.address)}>
                          <span className="mono sm:hidden">{shortAddress(r.address)}</span>
                          <span className="mono hidden sm:inline">{r.address}</span>
                        </ExtLink>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      </Section>
    </main>
  )
}
