import { NextResponse } from "next/server";
import { SCENARIOS } from "@/lib/scenarios";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ scenarios: SCENARIOS });
}
