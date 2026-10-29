import { RAIL_INSTANCES } from '@recall/sdk'
import { Reveal } from '@/components/Reveal'
import { Ledger } from './proof/Ledger'
import { RailProof } from './proof/RailProof'

/** /proof: public, no wallet. Everything here is read from Arc mainnet or from the recorded ledger. */
export function ProofScreen() {
  return (
    <main className="mx-auto w-full max-w-app px-4 pb-8 pt-10 sm:px-8 sm:pt-16">
      <div className="max-w-2xl">
        <div className="eyebrow">Proof</div>
        <h1 className="section-title mt-3">Don&rsquo;t take our word for it.</h1>
        <p className="lede mt-3">
          Both rails are live on Arc mainnet. The three promises below are read from the contract every 15 seconds, and every claim
          has a transaction you can open.
        </p>
      </div>
      <div className="mt-10 grid gap-6">
        {RAIL_INSTANCES.map((i) => (
          <Reveal key={i}>
            <RailProof instance={i} />
          </Reveal>
        ))}
      </div>
      <section className="mt-16" aria-labelledby="ledger-title">
        <h2 id="ledger-title" className="section-title">
          The ledger
        </h2>
        <p className="lede mt-2 max-w-2xl">Hero transactions recorded on Arc mainnet, including everything the contract said no to.</p>
        <div className="mt-6">
          <Ledger />
        </div>
      </section>
    </main>
  )
}
