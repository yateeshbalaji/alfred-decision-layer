// Core type definitions for the alfred_ Execution Decision Layer.

export type Decision =
  | "execute_silently"
  | "execute_and_notify"
  | "confirm_before_executing"
  | "ask_clarifying_question"
  | "refuse_or_escalate";

export const DECISION_LABELS: Record<Decision, string> = {
  execute_silently: "Execute silently",
  execute_and_notify: "Execute and notify user after",
  confirm_before_executing: "Confirm before executing",
  ask_clarifying_question: "Ask a clarifying question",
  refuse_or_escalate: "Refuse / escalate",
};

// A taxonomy of action types alfred_ can take. Kept small but representative.
export type ActionType =
  | "read_calendar"
  | "read_email"
  | "search_email"
  | "draft_email"
  | "send_email"
  | "send_sms"
  | "create_reminder"
  | "delete_reminder"
  | "schedule_meeting"
  | "reschedule_meeting"
  | "cancel_meeting"
  | "delete_email"
  | "archive_email"
  | "transfer_money"
  | "share_file"
  | "forward_email"
  | "subscribe_newsletter"
  | "unsubscribe_newsletter"
  | "unknown";

export type Recipient = {
  // "internal" if same domain as user, "external" otherwise. "self" if user themself.
  kind: "self" | "internal" | "external" | "unknown";
  display: string; // email, phone, name
};

export type ProposedAction = {
  type: ActionType;
  description: string; // 1-line human summary of the action
  parameters?: Record<string, unknown>; // recipients, subject, body, amount, time, ...
};

export type ConversationTurn = {
  role: "user" | "assistant" | "system";
  text: string;
  // Seconds before "now" — keeps scenarios deterministic without real timestamps.
  ago_seconds?: number;
};

export type UserProfile = {
  display_name?: string;
  email_domain?: string; // e.g., "acme.com"
  notes?: string; // free-form, e.g., "prefers brief replies; senior counsel reviews legal copy"
};

export type DecisionRequest = {
  action: ProposedAction;
  conversation: ConversationTurn[];
  user?: UserProfile;
};

// Signals computed deterministically in code BEFORE the LLM is called.
export type Signals = {
  action_category:
    | "read_only"
    | "low_stakes_write"
    | "high_stakes_write"
    | "irreversible_external"
    | "financial"
    | "destructive_bulk";
  reversibility: number; // 0 (irreversible) .. 1 (fully reversible)
  has_external_recipient: boolean;
  affects_money: boolean;
  contains_pii_in_outbound: boolean;
  // "Yep", "send it", "do it" — affirmation with no new content.
  is_affirmation_only: boolean;
  // Required params we can detect as missing. Empty list = all required present.
  missing_required_params: string[];
  policy_block_reason: string | null;
  // Heuristic: time since user's most recent turn.
  seconds_since_user_turn: number | null;
  // Whether earlier in the conversation alfred_ was told to "wait", "hold off",
  // "don't send yet" etc. — flag worth reasoning about.
  has_earlier_hold_instruction: boolean;
};

// Final structured decision returned to the UI.
export type DecisionResult = {
  decision: Decision;
  rationale: string; // concise, user-facing
  confidence: number; // 0..1, model's self-reported (post-floor adjusted)
  // If decision is ask_clarifying_question, this is what to ask.
  clarification_question?: string;
  // If decision is refuse_or_escalate, this is why.
  refusal_reason?: string;
  // Risk factors the model surfaced.
  risk_factors: string[];

  // --- Pipeline transparency ("under the hood") ---
  signals: Signals;
  prompt: { system: string; user: string };
  raw_model_output: string | null;
  parsed_model_output: ModelDecision | null;
  // What the safety floor changed, if anything.
  floor_overrides: string[];
  // Failure mode hit, if any.
  failure_mode: FailureMode | null;
  // How long the LLM call took (ms). null if it didn't run.
  model_latency_ms: number | null;
};

// What the LLM is asked to return as JSON.
export type ModelDecision = {
  decision: Decision;
  confidence: number;
  rationale: string;
  clarification_question?: string;
  refusal_reason?: string;
  risk_factors: string[];
};

export type FailureMode =
  | "llm_timeout"
  | "llm_error"
  | "malformed_output"
  | "missing_critical_context";

export type Scenario = {
  id: string;
  title: string;
  category: "easy" | "ambiguous" | "adversarial";
  notes: string; // why this scenario is interesting
  request: DecisionRequest;
};
