import { useState, type FormEvent } from 'react'
import { isAddress } from 'viem'
import { ConnectButton } from '@/components/ConnectButton'
import { Mark } from '@/components/Brand'

/** The /pay hero when there is nobody to look up yet: connect, or watch any address read-only. */
export function ConnectState({ onWatch }: { onWatch: (address: string) => void }) {
  const [text, setText] = useState('')
  const trimmed = text.trim()
  const invalid = trimmed.length > 0 && !isAddress(trimmed, { strict: false })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (trimmed && !invalid) onWatch(trimmed)
  }

  return (
    <div className="mx-auto w-full max-w-[760px]">
      <div className="notice !border-dashed !bg-none" style={{ background: 'transparent' }}>
        <div className="meta">
          <Mark muted />
          Recall <span style={{ color: 'var(--ink-4)' }}>·</span> Your next refundable debit
        </div>
        <div className="c-left">
          <div className="who">
            <span className="avatar" aria-hidden="true">
              ·
            </span>
            <div>
              <div className="who-name">Nothing to show yet</div>
              <div className="who-sub">Connect a wallet to see its debits</div>
            </div>
          </div>
          <div className="amount" aria-hidden="true">
            <b className="text-ink-4">€0.00</b>
            <span>EURC</span>
          </div>
          <div className="dates">Mandate · announced · due</div>
        </div>
        <div className="c-right">
          <div className="window">
            <div className="w-head">
              <span>Refundable</span>
              <span className="left text-ink-4">0d 0h 00m 00s</span>
            </div>
            <div className="bar dim" aria-hidden="true">
              {Array.from({ length: 8 }, (_, i) => (
                <i key={i} />
              ))}
            </div>
          </div>
          <div className="mt-5 flex flex-col gap-4">
            <ConnectButton className="btn btn-light w-full sm:w-auto" label="Connect wallet" />
            <form onSubmit={submit} className="flex flex-col gap-2" aria-label="Watch an address">
              <label htmlFor="watch" className="text-[12.5px] text-ink-3">
                Or watch any address, read-only
              </label>
              <div className="flex gap-2">
                <input
                  id="watch"
                  className="field flex-1"
                  placeholder="0x…"
                  autoComplete="off"
                  spellCheck={false}
                  value={text}
                  aria-invalid={invalid}
                  onChange={(e) => setText(e.target.value)}
                />
                <button type="submit" className="btn btn-line btn-sm" disabled={!trimmed || invalid}>
                  Watch
                </button>
              </div>
              {invalid && <span className="text-[12px] text-danger">That is not an address.</span>}
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
