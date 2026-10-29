import { TIME_SCALE, type RailInstance } from "./networks.js";
import type { MandateOffer } from "./types.js";

/** The demo rail caps what an offer may ask for, so a public demo cannot move real money. */
export const DEMO_MAX_PER_COLLECTION = 1_000_000n;
export const DEMO_MAX_PER_PERIOD = 2_000_000n;
/** The shortest notice an offer may promise, in legal seconds (the rail scales it by the instance's time scale). */
export const MIN_PRENOTICE_LEGAL_SECONDS = 86_400;

/**
 * Mirrors the rail's own offer checks (the ones that revert with InvalidTerms, WrongTimeScale or
 * SignatureExpired), so a merchant is told what is wrong before signing. Empty means the rail will accept it.
 * Pass `nowSec` (chain time) to also check the expiry.
 */
export function validateOffer(offer: MandateOffer, instance: RailInstance, nowSec?: number): string[] {
  const problems: string[] = [];
  if (offer.timeScale !== TIME_SCALE[instance]) problems.push(`The time scale must be ${TIME_SCALE[instance]} on the ${instance} rail.`);
  if (offer.maxPerCollection <= 0n) problems.push("The cap per debit must be greater than zero.");
  if (offer.maxPerPeriod < offer.maxPerCollection) problems.push("The cap per period cannot be below the cap per debit.");
  if (offer.periodLength === 0) problems.push("The period must be longer than zero.");
  if (offer.prenoticeLength < MIN_PRENOTICE_LEGAL_SECONDS) problems.push("The notice must be at least one day.");
  if (instance === "demo") {
    if (offer.maxPerCollection > DEMO_MAX_PER_COLLECTION) problems.push("On the demo rail a debit is capped at 1.00.");
    if (offer.maxPerPeriod > DEMO_MAX_PER_PERIOD) problems.push("On the demo rail a period is capped at 2.00.");
  }
  if (nowSec !== undefined && offer.validUntil < BigInt(nowSec)) problems.push("The offer must be valid until a time in the future.");
  return problems;
}
