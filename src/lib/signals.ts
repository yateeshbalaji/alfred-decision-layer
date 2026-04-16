// Deterministic signal extractor. Runs BEFORE the LLM call.
// Goal: compute objective, cheap, explainable features the model can lean on
// and the safety floor can act on.

import { ACTION_TAXONOMY, checkPolicy } from "./policy";
import type {
  ConversationTurn,
  ProposedAction,
  Signals,
  UserProfile,
} from "./types";

const AFFIRMATION_ONLY = new RegExp(
  "^\\s*(yes|yep|yeah|yup|sure|ok|okay|k|do it|send it|go(\\s+ahead)?|" +
    "confirmed?|approved?|please do|sounds good|lgtm|👍|✅)\\s*[.!?]*\\s*$",
  "i",
);

const HOLD_INSTRUCTION = new RegExp(
  "\\b(hold|hold off|wait|pause|don'?t (send|do|run|forward)|" +
    "not yet|stop|cancel that|nevermind|never mind|scratch that|actually,?\\s)",
  "i",
);

const MONEY_PATTERN =
  /\$\s?\d|(?:\b(usd|cad|eur|gbp)\b)|(\b\d+(?:[\.,]\d{2})?\s?(dollars|bucks))/i;

// Crude PII heuristic for outbound text. Real version would use a proper detector.
const PII_PATTERN = new RegExp(
  // SSN-like, credit-card-like, passport-like, bank-routing
  "\\b(\\d{3}-\\d{2}-\\d{4}|\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4})\\b",
  "i",
);

export function classifyRecipient(
  recipient: string,
  userDomain?: string,
): "self" | "internal" | "external" | "unknown" {
  if (!recipient) return "unknown";
  const r = recipient.toLowerCase().trim();
  if (!r.includes("@")) {
    // phone or name — call it unknown for our purposes
    return "unknown";
  }
  const domain = r.split("@")[1];
  if (!domain) return "unknown";
  if (userDomain && domain === userDomain.toLowerCase()) return "internal";
  return "external";
}

export function extractSignals(
  action: ProposedAction,
  conversation: ConversationTurn[],
  user?: UserProfile,
): Signals {
  const meta =
    ACTION_TAXONOMY[action.type] ?? ACTION_TAXONOMY.unknown;

  // Recipient analysis
  const recipientsRaw = (action.parameters?.recipients ??
    action.parameters?.recipient ??
    action.parameters?.attendees ??
    "") as string | string[];
  const recipientList = Array.isArray(recipientsRaw)
    ? recipientsRaw
    : String(recipientsRaw)
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
  const has_external_recipient =
    meta.has_external_side_effect &&
    recipientList.some(
      (r) => classifyRecipient(r, user?.email_domain) === "external",
    );

  // Money detection — both in description, body, and explicit "amount" param.
  const haystack = [
    action.description,
    String(action.parameters?.body ?? ""),
    String(action.parameters?.subject ?? ""),
  ].join(" \n ");
  const amount = Number(action.parameters?.amount ?? 0);
  const affects_money =
    action.type === "transfer_money" || amount > 0 || MONEY_PATTERN.test(haystack);

  const contains_pii_in_outbound =
    meta.has_external_side_effect && PII_PATTERN.test(haystack);

  // Last user turn analysis
  const lastUser = [...conversation].reverse().find((t) => t.role === "user");
  const is_affirmation_only = !!lastUser && AFFIRMATION_ONLY.test(lastUser.text);
  const seconds_since_user_turn = lastUser?.ago_seconds ?? null;

  // Earlier hold instruction — search any user turn except the latest one for
  // "hold off" / "wait" / "actually …" type pivots.
  const userTurns = conversation.filter((t) => t.role === "user");
  const earlierUserTurns = userTurns.slice(0, -1);
  const has_earlier_hold_instruction = earlierUserTurns.some((t) =>
    HOLD_INSTRUCTION.test(t.text),
  );

  // Required-params check
  const params = action.parameters ?? {};
  const missing_required_params = meta.required_params.filter((p) => {
    const v = params[p];
    if (v === undefined || v === null) return true;
    if (typeof v === "string" && v.trim() === "") return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  });

  // Hard policy
  const policy_block_reason = checkPolicy(action.type, action.parameters, conversation);

  // Promote category for destructive bulk patterns and money flows.
  let action_category = meta.category;
  if (affects_money && action_category !== "financial") {
    // outbound communication that mentions money is materially riskier
    if (meta.has_external_side_effect) action_category = "irreversible_external";
  }
  if (
    action.type === "delete_email" &&
    /\ball\b|\beverything\b|\bbatch\b|\*/i.test(
      String(action.parameters?.email_id_or_match ?? ""),
    )
  ) {
    action_category = "destructive_bulk";
  }

  return {
    action_category,
    reversibility: meta.reversibility,
    has_external_recipient,
    affects_money,
    contains_pii_in_outbound,
    is_affirmation_only,
    missing_required_params,
    policy_block_reason,
    seconds_since_user_turn,
    has_earlier_hold_instruction,
  };
}
