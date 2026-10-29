import { Footer } from '@/components/Footer'
import { Hero } from './landing/Hero'
import { How } from './landing/How'
import { PromiseSection } from './landing/Promise'
import { Sepa } from './landing/Sepa'

export function Landing() {
  return (
    <>
      <Hero />
      <How />
      <Sepa />
      <PromiseSection />
      <Footer />
    </>
  )
}
