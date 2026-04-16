"use client";

import { useMemo, useState } from "react";
import {
  DECISION_LABELS,
  type Decision,
  type DecisionRequest,
  type DecisionResult,
  type Scenario,
} from "@/lib/types";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; result: DecisionResult }
  | { kind: "error"; message: string };

const DECISION_STYLES: Record<Decision, string> = {
  execute_silently: "bg-emerald-50 text-emerald-900 border-emerald-300",
  execute_and_notify: "bg-sky-50 text-sky-900 border-sky-300",
  confirm_before_executing: "bg-amber-50 text-amber-900 border-amber-300",
  ask_clarifying_question: "bg-violet-50 text-violet-900 border-violet-300",
  refuse_or_escalate: "bg-rose-50 text-rose-900 border-rose-300",
};

const CATEGORY_BADGE: Record<Scenario["category"], string> = {
  easy: "bg-emerald-100 text-emerald-800",
  ambiguous: "bg-amber-100 text-amber-800",
  adversarial: "bg-rose-100 text-rose-800",
};

export default function DecisionUI({ scenarios }: { scenarios: Scenario[] }) {
  const [selectedId, setSelectedId] = useState<string>(scenarios[0]?.id ?? "");
  const [forceFailure, setForceFailure] = useState<"" | "timeout" | "malformed">("");
  const [editorJson, setEditorJson] = useState<string>(() =>
    JSON.stringify(scenarios[0]?.request ?? {}, null, 2),
  );
  const [state, setState] = useState<State>({ kind: "idle" });

  const selectedScenario = useMemo(
    () => scenarios.find((s) => s.id === selectedId),
    [selectedId, scenarios],
  );

  function loadScenario(id: string) {
    setSelectedId(id);
    const s = scenarios.find((x) => x.id === id);
    if (s) {
      setEditorJson(JSON.stringify(s.request, null, 2));
      setState({ kind: "idle" });
    }
  }

  async function submit() {
    let parsed: DecisionRequest;
    try {
      parsed = JSON.parse(editorJson);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message: `Invalid JSON in request body: ${msg}` });
      return;
    }
    setState({ kind: "loading" });
    const qs = forceFailure ? `?force_failure=${forceFailure}` : "";
    try {
      const res = await fetch(`/api/decide${qs}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(forceFailure ? { "x-force-failure": forceFailure } : {}),
        },
        body: JSON.stringify(parsed),
      });
      const json = await res.json();
      if (!res.ok) {
        setState({
          kind: "error",
          message: `${json.error ?? "Request failed"}${json.detail ? `: ${json.detail}` : ""}`,
        });
        return;
      }
      setState({ kind: "ok", result: json as DecisionResult });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message: msg });
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          alfred_ — Execution Decision Layer
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-600">
          Given a proposed action and conversation context, decide whether to
          execute silently, execute-and-notify, confirm, ask, or refuse.
          Pre-LLM signals + LLM judgment + safety floor — every step is visible
          below.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* LEFT: scenarios + controls */}
        <aside className="space-y-4">
          <section className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-700">
              Preloaded scenarios
            </h2>
            <ul className="space-y-1.5">
              {scenarios.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => loadScenario(s.id)}
                    className={`w-full rounded-md border px-3 py-2 text-left text-sm transition ${
                      selectedId === s.id
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium leading-snug">{s.title}</span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                          selectedId === s.id
                            ? "bg-white/20 text-white"
                            : CATEGORY_BADGE[s.category]
                        }`}
                      >
                        {s.category}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            {selectedScenario && (
              <p className="mt-3 text-xs leading-relaxed text-zinc-500">
                <strong className="text-zinc-700">Why this scenario:</strong>{" "}
                {selectedScenario.notes}
              </p>
            )}
          </section>

          <section className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-zinc-700">
              Force a failure mode
            </h2>
            <p className="mb-3 text-xs text-zinc-500">
              Demonstrates default-safe behavior when the LLM call goes wrong.
            </p>
            <div className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="force"
                  checked={forceFailure === ""}
                  onChange={() => setForceFailure("")}
                />
                None (normal pipeline)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="force"
                  checked={forceFailure === "timeout"}
                  onChange={() => setForceFailure("timeout")}
                />
                Simulate LLM timeout
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="force"
                  checked={forceFailure === "malformed"}
                  onChange={() => setForceFailure("malformed")}
                />
                Simulate malformed model output
              </label>
            </div>
          </section>

          <button
            onClick={submit}
            disabled={state.kind === "loading"}
            className="w-full rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {state.kind === "loading" ? "Deciding…" : "Run decision"}
          </button>
        </aside>

        {/* RIGHT: editor + result */}
        <main className="space-y-6">
          <section className="rounded-lg border border-zinc-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-700">
                Request body (action + context)
              </h2>
              <span className="text-xs text-zinc-500">Edit freely — JSON</span>
            </div>
            <textarea
              value={editorJson}
              onChange={(e) => setEditorJson(e.target.value)}
              spellCheck={false}
              className="h-64 w-full rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-relaxed text-zinc-800 focus:border-zinc-400 focus:outline-none"
            />
          </section>

          {state.kind === "error" && (
            <div className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">
              <strong>Error:</strong> {state.message}
            </div>
          )}

          {state.kind === "ok" && <ResultPanel result={state.result} />}
        </main>
      </div>

      <footer className="mt-10 border-t border-zinc-200 pt-4 text-xs text-zinc-500">
        Built for the alfred_ application challenge. See README for design notes,
        LLM/code split, and roadmap.
      </footer>
    </div>
  );
}

function ResultPanel({ result }: { result: DecisionResult }) {
  return (
    <div className="space-y-4">
      <div
        className={`rounded-lg border p-5 ${DECISION_STYLES[result.decision]}`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide opacity-70">
              Decision
            </div>
            <div className="mt-1 text-xl font-semibold">
              {DECISION_LABELS[result.decision]}
            </div>
          </div>
          <div className="text-right text-xs">
            <div className="opacity-70">Model confidence</div>
            <div className="text-lg font-mono">
              {result.confidence.toFixed(2)}
            </div>
          </div>
        </div>
        <p className="mt-3 text-sm leading-relaxed">{result.rationale}</p>

        {result.clarification_question && (
          <div className="mt-3 rounded-md bg-white/60 p-3 text-sm">
            <div className="text-xs font-semibold uppercase tracking-wide opacity-70">
              alfred_ would ask
            </div>
            <div className="mt-1 italic">
              &ldquo;{result.clarification_question}&rdquo;
            </div>
          </div>
        )}

        {result.refusal_reason && (
          <div className="mt-3 rounded-md bg-white/60 p-3 text-sm">
            <div className="text-xs font-semibold uppercase tracking-wide opacity-70">
              Refusal reason
            </div>
            <div className="mt-1">{result.refusal_reason}</div>
          </div>
        )}

        {result.risk_factors.length > 0 && (
          <div className="mt-3">
            <div className="text-xs font-semibold uppercase tracking-wide opacity-70">
              Risk factors
            </div>
            <ul className="mt-1 list-disc pl-5 text-sm">
              {result.risk_factors.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}

        {result.failure_mode && (
          <div className="mt-3 rounded-md border border-rose-300 bg-rose-100 p-3 text-sm text-rose-900">
            <strong>Failure mode hit:</strong> {result.failure_mode}. The
            decision above came from the safe-default fallback path, not from
            the model.
          </div>
        )}
      </div>

      <UnderTheHood result={result} />
    </div>
  );
}

function UnderTheHood({ result }: { result: DecisionResult }) {
  const sections: { label: string; defaultOpen?: boolean; body: React.ReactNode }[] = [
    {
      label: "1. Pre-computed signals (deterministic, in code)",
      defaultOpen: true,
      body: <CodeBlock json={result.signals} />,
    },
    {
      label: "2. Exact prompt sent to the model",
      body: (
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs font-semibold text-zinc-500">SYSTEM</div>
            <CodeBlock text={result.prompt.system} />
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold text-zinc-500">USER</div>
            <CodeBlock text={result.prompt.user} />
          </div>
        </div>
      ),
    },
    {
      label: `3. Raw model output${result.model_latency_ms != null ? ` (${result.model_latency_ms}ms)` : " (model not called)"}`,
      body:
        result.raw_model_output == null ? (
          <p className="text-sm italic text-zinc-500">
            Model was not called — pipeline short-circuited (see overrides) or
            failed before/at the call.
          </p>
        ) : (
          <CodeBlock text={result.raw_model_output} />
        ),
    },
    {
      label: "4. Parsed model decision (before safety floor)",
      body:
        result.parsed_model_output == null ? (
          <p className="text-sm italic text-zinc-500">
            No parsed model output — see failure mode or short-circuit reason.
          </p>
        ) : (
          <CodeBlock json={result.parsed_model_output} />
        ),
    },
    {
      label: `5. Safety-floor overrides applied${result.floor_overrides.length === 0 ? " (none)" : ""}`,
      body:
        result.floor_overrides.length === 0 ? (
          <p className="text-sm italic text-zinc-500">
            The safety floor did not change the model&rsquo;s decision.
          </p>
        ) : (
          <ul className="list-disc pl-5 text-sm">
            {result.floor_overrides.map((o, i) => (
              <li key={i} className="font-mono text-xs">
                {o}
              </li>
            ))}
          </ul>
        ),
    },
  ];

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-zinc-700">
        Under the hood — full pipeline
      </h2>
      <div className="space-y-2">
        {sections.map((s, i) => (
          <details
            key={i}
            open={s.defaultOpen}
            className="rounded-md border border-zinc-200 bg-zinc-50 p-3"
          >
            <summary className="cursor-pointer text-sm font-medium text-zinc-700">
              {s.label}
            </summary>
            <div className="mt-3">{s.body}</div>
          </details>
        ))}
      </div>
    </section>
  );
}

function CodeBlock({ json, text }: { json?: unknown; text?: string }) {
  const content = text ?? JSON.stringify(json, null, 2);
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-zinc-200 bg-white p-3 font-mono text-xs leading-relaxed text-zinc-800 whitespace-pre-wrap break-words">
      {content}
    </pre>
  );
}
