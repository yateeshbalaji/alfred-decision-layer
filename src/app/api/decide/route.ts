// POST /api/decide
// Body: DecisionRequest (see lib/types.ts)
// Returns: DecisionResult
//
// Optional debug controls (UI uses these to demo failure paths):
//   ?force_failure=timeout      → skip the LLM, return the timeout fallback
//   ?force_failure=malformed    → call the LLM but throw away its output

import { NextResponse } from "next/server";
import { decide } from "@/lib/decide";
import type { DecisionRequest } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: DecisionRequest;
  try {
    body = (await req.json()) as DecisionRequest;
  } catch {
    return NextResponse.json(
      { error: "Body must be valid JSON." },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object" || !body.action) {
    return NextResponse.json(
      { error: "Request must include `action` and `conversation` fields." },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.conversation)) {
    body.conversation = [];
  }

  const url = new URL(req.url);
  const forceFailure = url.searchParams.get("force_failure") as
    | "timeout"
    | "malformed"
    | null;

  try {
    const result = await decide(body, { forceFailure: forceFailure ?? undefined });
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Decision pipeline crashed.", detail: message },
      { status: 500 },
    );
  }
}
