// Anthropic client wrapper with timeout + structured-output parsing.

import Anthropic from "@anthropic-ai/sdk";
import type { ModelDecision } from "./types";

const MODEL_ID = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 8000);

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

export type LLMCallResult =
  | { ok: true; raw: string; parsed: ModelDecision; latency_ms: number }
  | {
      ok: false;
      reason: "timeout" | "error" | "malformed";
      raw: string | null;
      error_message: string;
      latency_ms: number;
    };

export type CallOptions = {
  // Debug-only: pretend the LLM call failed, without actually calling it.
  // - "timeout": return a synthetic timeout result
  // - "malformed": call the LLM but pretend the response is unparseable
  forceFailure?: "timeout" | "malformed";
};

export async function callDecisionModel(
  systemPrompt: string,
  userPrompt: string,
  options: CallOptions = {},
): Promise<LLMCallResult> {
  const start = Date.now();

  if (options.forceFailure === "timeout") {
    // Don't actually wait — just synthesize the same shape the real timeout produces.
    return {
      ok: false,
      reason: "timeout",
      raw: null,
      error_message: `Synthetic timeout (forced via debug control). Real timeout threshold is ${TIMEOUT_MS}ms.`,
      latency_ms: TIMEOUT_MS,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await client().messages.create(
      {
        model: MODEL_ID,
        max_tokens: 600,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      },
      { signal: controller.signal },
    );
    clearTimeout(timer);

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");

    if (options.forceFailure === "malformed") {
      return {
        ok: false,
        reason: "malformed",
        raw: text + "\n\n<<<INJECTED GARBAGE: this is not JSON>>>",
        error_message:
          "Synthetic malformed output (forced via debug control). Real model returned valid text but was treated as unparseable.",
        latency_ms: Date.now() - start,
      };
    }

    const parsed = tryParseJson(text);
    if (!parsed) {
      return {
        ok: false,
        reason: "malformed",
        raw: text,
        error_message: "Model output was not valid JSON matching the schema.",
        latency_ms: Date.now() - start,
      };
    }
    return {
      ok: true,
      raw: text,
      parsed,
      latency_ms: Date.now() - start,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAbort =
      (err as { name?: string })?.name === "AbortError" ||
      controller.signal.aborted;
    return {
      ok: false,
      reason: isAbort ? "timeout" : "error",
      raw: null,
      error_message: errorMessage(err),
      latency_ms: Date.now() - start,
    };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const VALID_DECISIONS = new Set([
  "execute_silently",
  "execute_and_notify",
  "confirm_before_executing",
  "ask_clarifying_question",
  "refuse_or_escalate",
]);

function tryParseJson(text: string): ModelDecision | null {
  // Models occasionally wrap JSON in code fences despite instructions; strip them.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Also handle a leading sentence + JSON; pull out the first {...} block.
  const candidate = extractFirstJsonObject(cleaned) ?? cleaned;

  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  if (typeof o.decision !== "string" || !VALID_DECISIONS.has(o.decision)) return null;
  if (typeof o.rationale !== "string") return null;
  const conf = typeof o.confidence === "number" ? o.confidence : NaN;
  if (Number.isNaN(conf) || conf < 0 || conf > 1) return null;
  const risks = Array.isArray(o.risk_factors)
    ? o.risk_factors.filter((r): r is string => typeof r === "string")
    : [];

  return {
    decision: o.decision as ModelDecision["decision"],
    confidence: conf,
    rationale: o.rationale,
    clarification_question:
      typeof o.clarification_question === "string"
        ? o.clarification_question
        : undefined,
    refusal_reason:
      typeof o.refusal_reason === "string" ? o.refusal_reason : undefined,
    risk_factors: risks,
  };
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
