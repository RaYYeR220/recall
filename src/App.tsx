import { Link, Route, Routes } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { ScrollManager } from './components/ScrollManager'
import { ComingSoon } from './pages/ComingSoon'
import { Landing } from './pages/Landing'
import { MandateScreen } from './screens/MandateScreen'
import { PayScreen } from './screens/PayScreen'

function NotFound() {
  return (
    <main className="mx-auto w-full max-w-app px-4 pt-24 sm:px-8">
      <div className="panel mx-auto max-w-xl p-8">
        <span className="chip chip-danger chip-mono">
          <i />
          404
        </span>
        <h1 className="section-title mt-4">There is nothing at this address.</h1>
        <p className="lede mt-2">Check the link, or start from the home page.</p>
        <Link className="btn btn-light btn-sm mt-6" to="/">
          Back home
        </Link>
      </div>
    </main>
  )
}

export default function App() {
  return (
    <>
      <ScrollManager />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route element={<AppLayout />}>
          <Route path="/pay" element={<PayScreen />} />
          <Route path="/m/:link" element={<MandateScreen />} />
          <Route
            path="/merchant"
            element={<ComingSoon title="Merchant console" blurb="Register, fund your reserve, sign mandate offers and watch your coverage. Arriving next." />}
          />
          <Route
            path="/proof"
            element={<ComingSoon title="Live proof" blurb="Every claim, every transaction and the live invariants, straight from the chain. Arriving next." />}
          />
          <Route
            path="/demo"
            element={<ComingSoon title="Run a live debit" blurb="One click runs a real debit, refund window and all, on the demo rail where a week lasts a minute. Arriving next." />}
          />
          <Route
            path="/developers"
            element={<ComingSoon title="Developers" blurb="The SDK, the relay protocol and the contract reference. Arriving next." />}
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  )
}
