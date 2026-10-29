import { Link } from 'react-router-dom'
import { Hourglass } from 'lucide-react'

export function ComingSoon({ title, blurb }: { title: string; blurb: string }) {
  return (
    <main className="mx-auto w-full max-w-app px-4 pt-16 sm:px-8 sm:pt-24">
      <div className="panel mx-auto flex max-w-xl flex-col items-start gap-4 p-7 sm:p-9">
        <span className="chip chip-quiet chip-mono">
          <Hourglass size={12} aria-hidden="true" />
          Coming soon
        </span>
        <h1 className="section-title">{title}</h1>
        <p className="lede max-w-md">{blurb}</p>
        <div className="mt-2 flex flex-wrap gap-3">
          <Link className="btn btn-light btn-sm" to="/pay">
            Open Pay
          </Link>
          <Link className="btn btn-line btn-sm" to="/">
            Back home
          </Link>
        </div>
      </div>
    </main>
  )
}
