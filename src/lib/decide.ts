// Pipeline orchestrator: signals → LLM → safety floor → failure recovery.
// This is the file that turns a DecisionRequest into a DecisionResult.

import { callDecisionModel } from "./llm";
import { ACTION_TAXONOMY } from "./policy";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt";
import { extractSignals } from "./signals";
import type {
  Decision,
  DecisionRequest,
  DecisionResult,
  FailureMode,
  ModelDecision,
  Signals,
} from "./types";

// Confidence below which we don't let the model auto-execute irreversible actions.
const IRREVERSIBLE_AUTO_EXEC_CONFIDENCE = 0.85;

export type DecideOptions = {
  // Debug knob — used by the UI to demo failure-path defaults without actually
  // breaking the LLM. Not for production use.
  forceFailure?: "timeout" | "malformed";
};

export async function decide(
  req: DecisionRequest,
  options: DecideOptions = {},
): Promise<DecisionResult> {
  // ---- Stage 1: deterministic signals ----
  const signals = extractSignals(req.action, req.conversation, req.user);

  // ---- Pre-LLM short-circuits ----
  // (a) Hard policy block — refuse without spending an LLM call.
  if (signals.policy_block_reason) {
    return shortCircuit({
      decision: "refuse_or_escalate",
      rationale: `Policy block: ${signals.policy_block_reason}`,
      refusal_reason: signals.policy_block_reason,
      risks: ["Hard policy rule triggered."],
      signals,
      prompt: emptyPrompt(req, signals),
      floor_overrides: ["pre_llm:policy_block"],
    });
  }

  // (b) Missing critical context — if there's no conversation at all and the
  //     action is non-read-only, we cannot judge intent. Ask before acting.
  if (
    req.conversation.length === 0 &&
    signals.action_category !== "read_only"
  ) {
    return shortCircuit({
      decision: "ask_clarifying_question",
      rationale:
        "No conversation context provided. For non-read-only actions, alfred_ should not act without context.",
      clarification: "Could you give me a little more context about why you want me to do this right now?",
      risks: ["No conversation history available."],
      signals,
      prompt: emptyPrompt(req, signals),
      floor_overrides: ["pre_llm:missing_context"],
      failure_mode: "missing_critical_context",
    });
  }

  // (c) Missing required parameters — ask which one.
  if (signals.missing_required_params.length > 0) {
    const missing = signals.missing_required_params.join(", ");
    return shortCircuit({
      decision: "ask_clarifying_question",
      rationale: `Missing required parameter(s): ${missing}.`,
      clarification: `Before I do this, I need: ${missing}. Can you fill those in?`,
      risks: [`Action is missing: ${missing}.`],
      signals,
      prompt: emptyPrompt(req, signals),
      floor_overrides: ["pre_llm:missing_required_params"],
    });
  }

  // ---- Stage 2: LLM judgment ----
  const userPrompt = buildUserPrompt(req.action, req.conversation, signals, req.user);
  const llm = await callDecisionModel(SYSTEM_PROMPT, userPrompt, {
    forceFailure: options.forceFailure,
  });

  if (!llm.ok) {
    // ---- Failure recovery ----
    return failureFallback({
      reason: llm.reason,
      raw: llm.raw,
      error_message: llm.error_message,
      latency_ms: llm.latency_ms,
      signals,
      prompt: { system: SYSTEM_PROMPT, user: userPrompt },
    });
  }

  // ---- Stage 3: safety floor ----
  const { final, overrides } = applySafetyFloor(llm.parsed, signals);

  return {
    decision: final.decision,
    rationale: final.rationale,
    confidence: final.confidence,
    clarification_question: final.clarification_question,
    refusal_reason: final.refusal_reason,
    risk_factors: final.risk_factors,
    signals,
    prompt: { system: SYSTEM_PROMPT, user: userPrompt },
    raw_model_output: llm.raw,
    parsed_model_output: llm.parsed,
    floor_overrides: overrides,
    failure_mode: null,
    model_latency_ms: llm.latency_ms,
  };
}

// ---- Safety floor ----
// The floor can DOWNGRADE a model decision toward safety (e.g., execute → confirm),
// but never UPGRADE it (e.g., never confirm → execute). This is the asymmetry that
// gives us trust: model can be optimistic; code is the conservative authority.
function applySafetyFloor(
  modelOut: ModelDecision,
  signals: Signals,
): { final: ModelDecision; overrides: string[] } {
  const overrides: string[] = [];
  let decision: Decision = modelOut.decision;
  let rationale = modelOut.rationale;
  const risks = [...modelOut.risk_factors];
  let confidence = modelOut.confidence;

  // Rule 1: irreversible + external + low confidence → confirm.
  const meta = ACTION_TAXONOMY;
  void meta;
  if (
    (signals.action_category === "irreversible_external" ||
      signals.action_category === "destructive_bulk" ||
      signals.action_category === "financial") &&
    (decision === "execute_silently" || decision === "execute_and_notify") &&
    confidence < IRREVERSIBLE_AUTO_EXEC_CONFIDENCE
  ) {
    overrides.push(
      `floor:low_confidence_irreversible (${confidence.toFixed(2)} < ${IRREVERSIBLE_AUTO_EXEC_CONFIDENCE})`,
    );
    decision = "confirm_before_executing";
    rationale = `${rationale} (Downgraded by safety floor: confidence too low for an irreversible action.)`;
  }

  // Rule 2: hold instruction + affirmation-only latest message → confirm.
  // This is the "Yep, send it" after "hold off until legal" case. Even if the
  // model thought it was fine, we surface the conflict explicitly.
  if (
    signals.has_earlier_hold_instruction &&
    signals.is_affirmation_only &&
    (decision === "execute_silently" || decision === "execute_and_notify")
  ) {
    overrides.push("floor:hold_then_short_affirmation");
    decision = "confirm_before_executing";
    rationale = `${rationale} (Downgraded by safety floor: earlier "hold off" was followed only by a short affirmation — that may not be a deliberate green light.)`;
    risks.push(
      "Latest user message is only an affirmation; an earlier turn told alfred_ to hold off.",
    );
  }

  // Rule 3: financial actions are NEVER silent in this prototype.
  if (
    signals.action_category === "financial" &&
    decision === "execute_silently"
  ) {
    overrides.push("floor:financial_never_silent");
    decision = "confirm_before_executing";
    rationale = `${rationale} (Downgraded by safety floor: financial actions are never executed silently.)`;
  }

  // Rule 4: PII outbound → confirm at minimum.
  if (
    signals.contains_pii_in_outbound &&
    (decision === "execute_silently" || decision === "execute_and_notify")
  ) {
    overrides.push("floor:pii_outbound");
    decision = "confirm_before_executing";
    rationale = `${rationale} (Downgraded by safety floor: outbound message appears to contain PII.)`;
    risks.push("Outbound message contains what looks like PII.");
  }

  return {
    final: { ...modelOut, decision, rationale, confidence, risk_factors: risks },
    overrides,
  };
}

// ---- Failure fallback ----
// Default-safe behavior when the LLM call fails or returns garbage.
function failureFallback(args: {
  reason: "timeout" | "error" | "malformed";
  raw: string | null;
  error_message: string;
  latency_ms: number;
  signals: Signals;
  prompt: { system: string; user: string };
}): DecisionResult {
  const failure_mode: FailureMode =
    args.reason === "timeout"
      ? "llm_timeout"
      : args.reason === "malformed"
        ? "malformed_output"
        : "llm_error";

  // Read-only actions can still proceed — they have no blast radius.
  // Everything else: confirm, never execute silently.
  const safe: Decision =
    args.signals.action_category === "read_only"
      ? "execute_and_notify"
      : "confirm_before_executing";

  const reasonText = {
    llm_timeout: `LLM call timed out after ${args.latency_ms}ms.`,
    llm_error: `LLM call errored: ${args.error_message}.`,
    malformed_output: `LLM returned output that did not match the required JSON schema.`,
    missing_critical_context: "",
  }[failure_mode];

  return {
    decision: safe,
    rationale: `${reasonText} Defaulting to a safe outcome (${safe.replace(/_/g, " ")}) to avoid an irreversible action under uncertainty.`,
    confidence: 0,
    risk_factors: [
      "Decision was made by the failure-fallback path, not by the model.",
    ],
    signals: args.signals,
    prompt: args.prompt,
    raw_model_output: args.raw,
    parsed_model_output: null,
    floor_overrides: [`failure_fallback:${failure_mode}`],
    failure_mode,
    model_latency_ms: args.latency_ms,
  };
}

// ---- Helpers ----
function shortCircuit(args: {
  decision: Decision;
  rationale: string;
  clarification?: string;
  refusal_reason?: string;
  risks: string[];
  signals: Signals;
  prompt: { system: string; user: string };
  floor_overrides: string[];
  failure_mode?: FailureMode;
}): DecisionResult {
  return {
    decision: args.decision,
    rationale: args.rationale,
    confidence: 1, // these are rule-based decisions
    clarification_question: args.clarification,
    refusal_reason: args.refusal_reason,
    risk_factors: args.risks,
    signals: args.signals,
    prompt: args.prompt,
    raw_model_output: null,
    parsed_model_output: null,
    floor_overrides: args.floor_overrides,
    failure_mode: args.failure_mode ?? null,
    model_latency_ms: null,
  };
}

function emptyPrompt(req: DecisionRequest, signals: Signals) {
  // We still build the prompt for transparency, even when we short-circuit before calling the model.
  return {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(req.action, req.conversation, signals, req.user),
  };
}
