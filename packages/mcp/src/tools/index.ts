import type { RecallContext } from "../context.js";
import { merchantTools } from "./merchant.js";
import { payerTools } from "./payer.js";
import type { Tool } from "./define.js";

export { merchantTools, payerTools };
export type { Tool };

export const MERCHANT_TOOL_NAMES = ["list_mandates", "prenotify_collection", "collect_due", "list_returns", "coverage"] as const;
export const PAYER_TOOL_NAMES = ["list_my_debits", "upcoming_debits", "explain_refund_rights", "prepare_refund"] as const;

export function allTools(ctx: RecallContext): Tool[] {
  // The payer tools receive the same object but are typed against ReadContext, which has no operator.
  return [...merchantTools(ctx), ...payerTools(ctx)];
}
