import { Link, Route, Routes } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { ScrollManager } from './components/ScrollManager'
import { Landing } from './pages/Landing'
import { MandateScreen } from './screens/MandateScreen'
import { MerchantScreen } from './screens/MerchantScreen'
import { DemoScreen } from './screens/DemoScreen'
import { DevelopersScreen } from './screens/DevelopersScreen'
import { PayScreen } from './screens/PayScreen'
import { ProofScreen } from './screens/ProofScreen'

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
          <Route path="/merchant" element={<MerchantScreen />} />
          <Route path="/proof" element={<ProofScreen />} />
          <Route path="/demo" element={<DemoScreen />} />
          <Route path="/developers" element={<DevelopersScreen />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  )
}
