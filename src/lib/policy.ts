// Action taxonomy + policy rules.
// This is the "deterministic" knowledge about what actions are risky vs safe.
// Kept as a small in-memory table; in production this would be a config file or DB
// owned by a trust-and-safety team.

import type { ActionType } from "./types";

type ActionMeta = {
  reversibility: number; // 0..1
  category:
    | "read_only"
    | "low_stakes_write"
    | "high_stakes_write"
    | "irreversible_external"
    | "financial"
    | "destructive_bulk";
  // Required parameters that must be present for the action to be executable.
  required_params: string[];
  // If true, the action sends something to a third party (email recipient, payee).
  has_external_side_effect: boolean;
};

export const ACTION_TAXONOMY: Record<ActionType, ActionMeta> = {
  read_calendar: {
    reversibility: 1,
    category: "read_only",
    required_params: [],
    has_external_side_effect: false,
  },
  read_email: {
    reversibility: 1,
    category: "read_only",
    required_params: [],
    has_external_side_effect: false,
  },
  search_email: {
    reversibility: 1,
    category: "read_only",
    required_params: ["query"],
    has_external_side_effect: false,
  },
  draft_email: {
    reversibility: 1,
    category: "low_stakes_write",
    required_params: ["recipients", "body"],
    has_external_side_effect: false,
  },
  send_email: {
    reversibility: 0.1, // can technically retract within seconds with some providers
    category: "irreversible_external",
    required_params: ["recipients", "body"],
    has_external_side_effect: true,
  },
  send_sms: {
    reversibility: 0,
    category: "irreversible_external",
    required_params: ["recipient", "body"],
    has_external_side_effect: true,
  },
  create_reminder: {
    reversibility: 1,
    category: "low_stakes_write",
    required_params: ["when", "text"],
    has_external_side_effect: false,
  },
  delete_reminder: {
    reversibility: 0.7,
    category: "low_stakes_write",
    required_params: ["reminder_id_or_match"],
    has_external_side_effect: false,
  },
  schedule_meeting: {
    reversibility: 0.4, // invites go out — can be cancelled but recipients see it
    category: "high_stakes_write",
    required_params: ["attendees", "when"],
    has_external_side_effect: true,
  },
  reschedule_meeting: {
    reversibility: 0.4,
    category: "high_stakes_write",
    required_params: ["meeting_id_or_match", "new_when"],
    has_external_side_effect: true,
  },
  cancel_meeting: {
    reversibility: 0.3,
    category: "high_stakes_write",
    required_params: ["meeting_id_or_match"],
    has_external_side_effect: true,
  },
  delete_email: {
    reversibility: 0.6, // recoverable from trash for a while
    category: "low_stakes_write",
    required_params: ["email_id_or_match"],
    has_external_side_effect: false,
  },
  archive_email: {
    reversibility: 0.95,
    category: "low_stakes_write",
    required_params: ["email_id_or_match"],
    has_external_side_effect: false,
  },
  transfer_money: {
    reversibility: 0,
    category: "financial",
    required_params: ["recipient", "amount"],
    has_external_side_effect: true,
  },
  share_file: {
    reversibility: 0.5,
    category: "irreversible_external",
    required_params: ["file_id_or_name", "recipient"],
    has_external_side_effect: true,
  },
  forward_email: {
    reversibility: 0,
    category: "irreversible_external",
    required_params: ["email_id_or_match", "recipient"],
    has_external_side_effect: true,
  },
  subscribe_newsletter: {
    reversibility: 0.9,
    category: "low_stakes_write",
    required_params: ["newsletter"],
    has_external_side_effect: false,
  },
  unsubscribe_newsletter: {
    reversibility: 0.9,
    category: "low_stakes_write",
    required_params: ["newsletter"],
    has_external_side_effect: false,
  },
  unknown: {
    reversibility: 0,
    category: "high_stakes_write",
    required_params: [],
    has_external_side_effect: true,
  },
};

// Hard policy rules. If any return a string, the action must be refused/escalated.
// This intentionally lives in code, not in the prompt, because hard rules should
// not be argued out of by a model.
export function checkPolicy(
  type: ActionType,
  params: Record<string, unknown> | undefined,
  conversation: { role: string; text: string }[],
): string | null {
  // 1. Out-of-channel instructions: if the *most recent* alfred_-bound instruction
  //    came from the body of an email/message rather than the user, treat as
  //    untrusted (classic prompt-injection vector).
  const lastUser = [...conversation].reverse().find((t) => t.role === "user");
  if (lastUser) {
    const text = lastUser.text.toLowerCase();
    // Heuristic: user explicitly relays an instruction that originated in an
    // email/message body. We look for two co-occurring signals in the same
    // turn: a phrase indicating an email source AND a phrase indicating a
    // relayed instruction. Production would use a proper classifier here.
    const mentionsRelayedSource =
      /(in|from)\s+(the|this|that|an?)\s+(email|message|inbox|note)/.test(text) ||
      /\b(forwarded|forwarded\s+email|email\s+from)\b/.test(text);
    const mentionsRelayedInstruction =
      /\b(it|they)\s+(say|says|said|asks?|asked)\b/.test(text) ||
      /\b(per|according to)\s+(the|this|that|an?)\s+(email|message)\b/.test(text);
    const looksRelayed = mentionsRelayedSource && mentionsRelayedInstruction;
    if (looksRelayed && (type === "forward_email" || type === "transfer_money")) {
      return "Action would execute an instruction relayed from external content (possible prompt injection).";
    }
  }

  // 2. Mass destructive operations on email — we don't auto-execute under any conditions.
  if (type === "delete_email" && params) {
    const match = String(params.email_id_or_match ?? "").toLowerCase();
    if (
      match.includes("all") ||
      match.includes("everything") ||
      match.includes("*")
    ) {
      // Not a refusal — we let the LLM see this and the safety floor will require confirm.
      return null;
    }
  }

  // 3. Money transfers above an unrealistic threshold without prior context: refuse.
  if (type === "transfer_money" && params) {
    const amt = Number(params.amount ?? 0);
    if (amt >= 10000) {
      return `Money transfer of $${amt} exceeds auto-execution policy ceiling.`;
    }
  }

  return null;
}
