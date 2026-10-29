import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ActBlock, Cover, DoneBlock, NoticeCard, WindowBlock, CountdownText, windowSegments } from '@/components/NoticeCard'
import { Nav } from '@/components/Nav'

// The approved hero: a debit notice with a live countdown. Like the reference it is a worked example
// (Northwind Gym, EUR 12.00); the real, chain-backed version of this object lives on /pay.
const WINDOW = 56 * 86400
const START_LEFT = 7 * 86400 + 23 * 3600 + 41 * 60 + 7

function useReducedMotion(): boolean {
  const [reduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  return reduced
}

export function Hero() {
  const [left, setLeft] = useState(START_LEFT)
  const [refunded, setRefunded] = useState(false)
  const reduced = useReducedMotion()

  useEffect(() => {
    if (reduced) return
    const id = window.setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000)
    return () => window.clearInterval(id)
  }, [reduced])

  const segments = windowSegments(WINDOW - left, WINDOW)

  return (
    <div className="stage">
      <Nav variant="landing" />

      <main className="hero">
        <h1 className="display in" style={{ ['--d' as string]: '.05s' }}>
          Direct debit for stablecoins, with the refund right built in.
        </h1>
        <p className="sub in" style={{ ['--d' as string]: '.15s' }}>
          Sign once. Every debit is announced before it runs. For eight weeks after any debit, take it back in one click — paid
          instantly from the merchant's reserve.
        </p>
        <div className="cta in" style={{ ['--d' as string]: '.24s' }}>
          <Link className="btn btn-light" to="/demo">
            Run a live debit
          </Link>
          <Link className="btn btn-line" to={{ pathname: '/', hash: '#how' }}>
            How it works
          </Link>
        </div>
        <p className="proof in" style={{ ['--d' as string]: '.3s' }}>
          <span className="live" aria-hidden="true" />
          Live on Arc mainnet <span className="sep">·</span> EURC &amp; USDC <span className="sep s2">·</span>
          <br className="m-br" /> No owner, no upgrades
        </p>

        <div className="stack in" style={{ ['--d' as string]: '.36s' }} aria-label="Example debit notice">
          <div className="ghost" aria-hidden="true">
            <div className="ghost-row">
              <b>Next debit</b> due 03 Nov<span className="g-amt"> · €12.00 EURC</span>{' '}
              <span className="chip">
                <i />
                Announced
              </span>
            </div>
          </div>
          <NoticeCard
            refunded={refunded}
            label="Example debit notice"
            metaLabel="Debit taken"
            metaWhen="03 Sep, 09:00"
            creditorName="Northwind Gym"
            subtitle="Monthly membership"
            amountText="€12.00"
            tokenSymbol="EURC"
            datesLine="Mandate 0042 · announced 20 Aug"
            chip={
              refunded ? (
                <span className="chip chip-limetext">
                  <i />
                  Refunded · MD06
                </span>
              ) : (
                <span className="chip">
                  <i />
                  Paid
                </span>
              )
            }
            right={
              <>
                <WindowBlock
                  dim={refunded}
                  label="Refundable"
                  value={<CountdownText seconds={left} />}
                  segments={segments}
                  foot={['03 Sep', '8 weeks', '29 Oct']}
                  cover={<Cover>Northwind reserve · €12.00 locked</Cover>}
                />
                {refunded ? (
                  <DoneBlock
                    title="€12.00 back in your wallet"
                    sub="Paid from Northwind's reserve · 1 block"
                    trailing={
                      <button type="button" onClick={() => setRefunded(false)}>
                        Reset
                      </button>
                    }
                  />
                ) : (
                  <ActBlock
                    note={
                      <>
                        Paid back at once from the
                        <br />
                        merchant's reserve.
                      </>
                    }
                  >
                    <button className="take" type="button" onClick={() => setRefunded(true)}>
                      Take it back
                    </button>
                  </ActBlock>
                )}
              </>
            }
          />
        </div>
      </main>
    </div>
  )
}
