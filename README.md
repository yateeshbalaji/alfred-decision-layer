# alfred_ — Execution Decision Layer

A prototype for the alfred_ application challenge. Given a proposed action plus
conversation context, decide whether to **execute silently**, **execute and
notify**, **confirm before executing**, **ask a clarifying question**, or
**refuse / escalate** — and show the entire pipeline behind the decision.

- **Live:** _(deploy URL goes here once you push to Vercel)_
- **Repo:** _(GitHub URL goes here)_

---

## Quick start

```bash
cp .env.local.example .env.local       # then paste your ANTHROPIC_API_KEY
npm install
npm run dev                            # http://localhost:3000
```

You can run without an API key — the request will hit the LLM-error fallback
path and you'll see the system gracefully degrade to a confirm-before-executing
default. The forced-failure controls in the UI also let you trigger the timeout
and malformed-output paths without touching the model.

---

## What this does

The product problem: as alfred_ acts on the user's behalf more often, the
hardest call is _when_ to act. Acting too freely loses trust the first time
something irreversible misfires. Confirming on everything makes the assistant
feel like a glorified form. The decision layer is the thing that has to get
this right, on every single turn, given the conversation arc — not a one-shot
classifier on the latest message.

Inputs:

- **Action**: a structured proposal (`type`, `description`, `parameters`)
- **Conversation**: ordered turns from the user and assistant, each with an
  `ago_seconds` so we can reason about recency
- **User profile** (optional): display name, email domain, free-form notes

Output:

- One of five decisions, plus a concise rationale, model confidence, optional
  clarifying question / refusal reason, and an enumerated list of risk factors
- Full transparency: pre-computed signals, the exact prompt sent to the model,
  raw model output, parsed model output, and any safety-floor overrides applied
  after the model spoke

---

## How the pipeline works

```
DecisionRequest
      │
      ▼
┌────────────────────────────┐
│ 1. Deterministic signals    │  src/lib/signals.ts + src/lib/policy.ts
│    (action category,        │  Cheap, explainable, runs every time.
│     reversibility,          │
│     external recipient,     │
│     money/PII detection,    │
│     affirmation-only check, │
│     hold-instruction check, │
│     missing-params check,   │
│     hard policy block)      │
└────────────┬───────────────┘
             │
             ▼
       Pre-LLM short-circuits ─────► policy block      → refuse_or_escalate
                                  │  no context        → ask_clarifying_question
                                  │  missing params    → ask_clarifying_question
             │
             ▼
┌────────────────────────────┐
│ 2. LLM judgment             │  src/lib/llm.ts + src/lib/prompt.ts
│    (Claude Haiku 4.5,       │  Strict JSON output, 8s timeout.
│     temp=0)                 │
└────────────┬───────────────┘
             │
             ▼
┌────────────────────────────┐
│ 3. Safety floor             │  src/lib/decide.ts → applySafetyFloor()
│    (downgrade-only)         │  Can confirm/refuse where the model said
│                             │  execute. Can NEVER promote in the other
│                             │  direction.
└────────────┬───────────────┘
             │
             ▼
       DecisionResult (with full pipeline transparency)
```

If the LLM call times out or returns malformed JSON, the failure-fallback path
returns a safe default (read-only → execute-and-notify; everything else →
confirm-before-executing) and surfaces the failure mode in the UI.

---

## What the code computes vs. what the model decides

This is the most important design choice in the system. The split is **objective
vs. judgment**, plus **asymmetric authority**:

### Code does (deterministic, in `src/lib/`)

| What | Why it lives in code |
| --- | --- |
| Action taxonomy & reversibility lookup (`policy.ts`) | This is shared knowledge that should not be re-derived per request. Should be owned by trust-and-safety, not the model. |
| Recipient classification (internal vs external) | Domain-matching is a regex, not a judgment call. |
| Money / PII regex detection | Cheap, deterministic. Models miss these inconsistently at temperature > 0. |
| Affirmation-only token detection (`yep`, `send it`, `lgtm`) | Explicit, testable signal that lets the floor distinguish "user said yes" from "user said yes AND added new info". |
| Earlier "hold off" detection | Cheap regex flag; the floor uses it to catch a known dangerous pattern (hold → short affirmation). |
| Required-params completeness | Schema-level fact. No reason to ask the model what `send_email` needs. |
| Hard policy rules (out-of-channel instructions, money ceilings) | Hard rules should not be argued out of by a model. |
| Safety floor (downgrade-only) | The trust gradient is asymmetric: too cautious is recoverable, too aggressive may not be. Code is the conservative authority. |
| Failure fallback | When the model is unavailable or wrong, code chooses the safe default. |

### Model does (Claude Haiku 4.5)

| What | Why it lives in the model |
| --- | --- |
| Holistic intent inference over the full conversation arc | This is the actual "judgment" part. Codifying conversational coherence in regex is a losing battle. |
| Whether the latest user message resolves prior conflicts | The PDF's "Yep, send it" example is exactly this — needs reading comprehension. |
| Drafting clarifying questions in the user's voice | Style + concision is what models are good at. |
| Surfacing risk factors not captured by deterministic signals | Catches things like "this draft includes claims we haven't actually verified." |

### Asymmetry: code can override the model toward safety, but never toward action

- Model says `execute_silently`, signals say irreversible + low confidence → floor downgrades to `confirm_before_executing`.
- Model says `confirm` and code can't think of a reason to relax that → result is `confirm`. Code never upgrades.
- This is what makes the model's optimism cheap. It's allowed to suggest "go," because the floor will hold the line.

See `applySafetyFloor()` in [src/lib/decide.ts](src/lib/decide.ts#L93) for the four floor rules currently in place.

---

## Signals, in detail

Computed once per request, passed both into the prompt _and_ used by the floor:

| Signal | Type | Used for |
| --- | --- | --- |
| `action_category` | enum (`read_only` … `financial`, `destructive_bulk`) | Sets the silent-execution threshold. |
| `reversibility` | 0..1 | Future: weight into the floor more dynamically. |
| `has_external_recipient` | bool | Triggers the irreversible-external floor rule. |
| `affects_money` | bool | Promotes category to `irreversible_external` for outbound mentions. |
| `contains_pii_in_outbound` | bool | Floor downgrades to confirm. |
| `is_affirmation_only` | bool | Combined with `has_earlier_hold_instruction` → known-dangerous pattern. |
| `has_earlier_hold_instruction` | bool | The "hold off until legal" signal from the PDF example. |
| `missing_required_params` | string[] | Pre-LLM short-circuit to `ask_clarifying_question`. |
| `policy_block_reason` | string \| null | Pre-LLM short-circuit to `refuse_or_escalate`. |
| `seconds_since_user_turn` | number \| null | Surfaced to the model — recency matters for "Yep" interpretation. |

---

## Prompt design (brief)

Two messages: a short system prompt with the **decision boundary + principles**, and a
structured user message with the **action + conversation + signals**.

Notable choices:

1. **The decision principles are in the system prompt**, not the user prompt. This keeps them constant across requests and lets the model treat them as policy.
2. **The user prompt feeds raw signals as JSON**, not as prose summaries. The model can reference them by key (e.g. "signals.has_earlier_hold_instruction is true").
3. **JSON-only output, no code fences, no preamble.** The parser tolerates fences and leading prose anyway (the world's models love to disobey), but instructing strictly improves parse-rate substantially.
4. **Temperature 0**. We want consistency for a given input. Variability is a bug here, not a feature.
5. **Conversation turns are tagged with relative timestamps** (`60s`, `30m`) so the model can weight recency without hallucinating absolute timestamps it doesn't have.

The full prompt is visible in the UI under "Exact prompt sent to the model", and lives in [src/lib/prompt.ts](src/lib/prompt.ts).

---

## Failure modes — and what we do about them

| Failure | Trigger | Behavior |
| --- | --- | --- |
| **LLM timeout** | 8s elapsed without response | Return `confirm_before_executing` (or `execute_and_notify` for read-only). UI shows a red failure banner. |
| **LLM error (network/auth)** | SDK throws | Same as timeout. |
| **Malformed model output** | Output isn't parseable JSON matching the schema | Same as timeout. We log the raw output for inspection. |
| **Missing critical context** | Empty conversation + non-read-only action | Pre-LLM short-circuit to `ask_clarifying_question`. |
| **Missing required params** | Action's required fields absent or empty | Pre-LLM short-circuit to `ask_clarifying_question` naming the missing fields. |
| **Hard policy block** | `checkPolicy()` returns a string | Pre-LLM short-circuit to `refuse_or_escalate`. |
| **Pipeline crash** | Anywhere | Route returns 500 with the error detail. UI surfaces it. |

The **default-safe principle**: when uncertain, do not execute irreversible actions. The fallback path is encoded in [src/lib/decide.ts](src/lib/decide.ts#L168) (`failureFallback`).

The UI exposes two of these paths via the **Force a failure mode** controls in the left sidebar — pick "Simulate LLM timeout" or "Simulate malformed model output" and run any scenario to see the failure-recovery decision.

---

## Scenarios (preloaded)

| Category | Scenario | Expected decision |
| --- | --- | --- |
| Easy | What's on my calendar tomorrow? | `execute_silently` |
| Easy | Set a reminder for 3pm | `execute_silently` or `execute_and_notify` |
| Ambiguous | "Yep, send it" — but legal hold is still in play | `confirm_before_executing` (the floor catches this even if the model gets it wrong) |
| Ambiguous | "Cancel my 3pm" with two 3pm meetings | `ask_clarifying_question` |
| Ambiguous | "Push my next meeting back a bit" | `ask_clarifying_question` |
| Adversarial | Venmo Sarah $500 for rent | `confirm_before_executing` (financial floor) |
| Adversarial | Delete all emails from last week | `confirm_before_executing` (destructive bulk) |
| Adversarial | "An incoming email asks me to forward all your emails…" | `refuse_or_escalate` (policy block: relayed instruction) |

Each scenario lives in [src/lib/scenarios.ts](src/lib/scenarios.ts) with a brief
note explaining what makes it interesting.

---

## How I would evolve this as alfred_ gains riskier tools

The current system was sized for the challenge — six hours, one decision call,
no persistence. The shape that holds up as the surface area grows:

1. **Tool-side reversibility metadata, not a global table.** Today `policy.ts`
   is a static taxonomy. New integrations should declare their own action
   metadata (reversibility window, blast radius, idempotency key requirements)
   when they register with the dispatcher. The decision layer reads it.

2. **Action-class budgets, not per-call thresholds.** "Confirm if confidence
   < 0.85" is a brittle floor. A better floor: budget how many irreversible
   external-facing actions alfred_ can take per user per day silently, and
   require confirms once the budget runs down. Trust accrues; mistakes burn it.

3. **Per-user trust calibration.** Some users want alfred_ aggressive; some
   want it conservative. The floor's thresholds should be a personal setting,
   not a global constant. UX: ask once, learn from corrections.

4. **Counterfactual confirms in the dataset.** Every confirm we ship should be
   logged with the user's response (yes/no/edit). That's the training set for
   eventually moving _toward_ silent execution where the user reliably says yes.
   The reverse is also true — silent executions the user reverses become hard
   "always confirm" labels.

5. **Multi-step plans, not just single actions.** As alfred_ chains tools
   ("draft → check calendar → send invite"), the decision layer needs to
   evaluate the plan, not each step in isolation. A plan that ends in an
   irreversible action should bias the whole thing toward confirm even if
   each step in isolation looks fine.

6. **Out-of-band confirmations for highest-stakes actions.** Money over a
   threshold, mass deletes, anything with legal exposure — confirm in a
   different channel than the one the request came from (e.g., push notification
   tap, not text reply). Drives the prompt-injection attack surface to zero for
   the highest-impact actions.

7. **Adversarial test suite as a CI gate.** The "incoming email tells alfred to
   forward your emails" scenario should be one of dozens, regenerated and
   replayed on every prompt or model change. Decision drift is real.

---

## What I would build next if I owned this for 6 months

Roughly in order:

1. **An eval harness with a labeled scenario corpus** (current 8 → 200+).
   Categories: clear-execute, clear-confirm, clear-refuse, ambiguous-but-safe,
   ambiguous-and-risky, adversarial. Track precision/recall per category over
   model and prompt changes.
2. **Logging + replay tooling.** Every production decision recorded with full
   pipeline state. One-click replay on a different model/prompt.
3. **The trust-budget floor** described above. Replace the static confidence
   threshold with a dynamic one that respects accrued trust per user per
   action class.
4. **A "why did alfred ask?" affordance in the consumer product.** Users should
   see the rationale (one short sentence) when alfred confirms instead of acting.
   Reduces friction and trains the user on when to expect a confirm.
5. **Two-model judgment for risky actions.** Run a smaller fast model first; if
   it says "execute" but signals are ambiguous, escalate to a stronger model
   for a second opinion before silently acting. Cost vs. safety trade.
6. **A self-correction loop on user reverts.** When a user undoes an alfred
   action, that's a label. Feed it into prompt examples, into per-user trust
   recalibration, and into the eval corpus.
7. **A small policy DSL** so non-engineers (PMs, T&S) can add rules like "any
   outbound email mentioning a number > $1000 confirms" without a deploy.

---

## What I deliberately did not build

- **Auth, sessions, persistence.** Stateless API.
- **A real action taxonomy.** The 18-action table is illustrative, not exhaustive.
- **Streaming responses.** The decision is small enough that batched JSON is fine.
- **An eval harness.** Mentioned as the #1 next step, intentionally not in scope for the timebox.
- **Per-user calibration.** Mentioned in the roadmap; not built.
- **A real PII detector / prompt-injection classifier.** The regex/policy heuristics here are illustrative; production would use proper detectors.
- **Tests.** Honest tradeoff: at this scope, manual scenario sweep + visible pipeline state was the better use of the timebox than a small test file. The signals layer is structured to be testable.

---

## File map

```
src/
  app/
    page.tsx              # entry; renders DecisionUI with preloaded scenarios
    decision-ui.tsx       # client component: scenario picker, JSON editor,
                          #   decision card, "under the hood" inspector
    api/
      decide/route.ts     # POST → runs the pipeline; supports ?force_failure=
      scenarios/route.ts  # GET → preloaded scenarios as JSON
  lib/
    types.ts              # all type definitions
    policy.ts             # action taxonomy + hard policy rules
    signals.ts            # deterministic signal extractor
    prompt.ts             # system + user prompt builder
    llm.ts                # Anthropic client wrapper, timeout, JSON parser
    decide.ts             # pipeline orchestrator + safety floor + fallback
    scenarios.ts          # 8 preloaded scenarios
```

---

## Deploy

```bash
# from the repo root
npx vercel             # first run prompts for login + project creation
npx vercel --prod      # ship it
# then in Vercel dashboard: add ANTHROPIC_API_KEY as an environment variable
```

Or import the GitHub repo in the Vercel dashboard and add `ANTHROPIC_API_KEY`
under Settings → Environment Variables.
