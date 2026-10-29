import { Link } from 'react-router-dom'
import { buildAddressUrl } from '@/lib/links'
import { railAddresses, RAIL_INSTANCES, type NetworkInfo } from '@recall/sdk'
import { useNetwork, NETWORK_LABEL } from '@/lib/network'
import { shortAddress } from '@/lib/format'
import { Brand } from './Brand'
import { ExtLink } from './ui'

function addr(info: NetworkInfo, label: string, address: string) {
  return (
    <li key={label} className="flex items-baseline justify-between gap-4 py-1.5 text-[13px]">
      <span className="text-ink-3">{label}</span>
      <ExtLink href={buildAddressUrl(info.network, address)}>
        <span className="mono sm:hidden">{shortAddress(address)}</span>
        <span className="mono hidden sm:inline">{address}</span>
      </ExtLink>
    </li>
  )
}

export function Footer() {
  const { network, info } = useNetwork()
  const addrs = railAddresses(network)
  const github = import.meta.env.VITE_GITHUB_URL
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto grid max-w-app gap-10 px-4 py-14 sm:px-8 lg:grid-cols-[1fr_1.6fr]">
        <div>
          <div className="[&_.brand]:text-[18px]">
            <Brand />
          </div>
          <p className="mt-4 max-w-xs text-[13.5px] leading-relaxed text-ink-3">
            Direct debit for stablecoins, with the refund right built in. No owner, no upgrades, no fees.
          </p>
          <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[13.5px] text-ink-2">
            <li>
              <Link className="hover:text-ink" to="/developers">
                Docs
              </Link>
            </li>
            <li>
              <Link className="hover:text-ink" to="/proof">
                Proof
              </Link>
            </li>
            {github && (
              <li>
                <a className="hover:text-ink" href={github} target="_blank" rel="noopener noreferrer">
                  GitHub
                </a>
              </li>
            )}
          </ul>
        </div>
        <div>
          <div className="eyebrow">Contracts · {NETWORK_LABEL[network]}</div>
          <ul className="mt-3 divide-y divide-line">
            {RAIL_INSTANCES.flatMap((i) => [
              addr(info, `DebitRail · ${i}`, addrs[i].rail),
              addr(info, `RailLens · ${i}`, addrs[i].lens),
            ])}
            {addr(info, 'EURC', info.eurc.address)}
            {addr(info, 'USDC', info.usdc.address)}
          </ul>
        </div>
      </div>
    </footer>
  )
}
