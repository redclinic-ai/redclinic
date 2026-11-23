// Plays one of NEPA's transcript lines in the agent's voice (Cartesia), for test-call review.
// Only when the voice provider is connected and verified; staff need transcript permission.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth/session-cookie";
import { contextOf } from "@/lib/auth/service";
import { withContext } from "@/lib/db";
import { can } from "@/lib/authz";
import { getConfig, type AgentConfig } from "@/lib/nepa/config";
import { getTextToSpeech } from "@/lib/providers";
import { reportError } from "@/lib/monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ segmentId: string }> }) {
  const tts = getTextToSpeech();
  if (tts.info.simulated) return new NextResponse("Voice is not connected yet.", { status: 404 });
  const user = await currentUser();
  if (!user) return new NextResponse("Sign in first.", { status: 401 });
  const { segmentId } = await params;
  if (!z.string().uuid().safeParse(segmentId).success) return new NextResponse("Not found", { status: 404 });
  const seg = await withContext(contextOf(user), async (c) => {
    if (!(await can(c, "view_call_transcripts"))) return null;
    const s = (await c.query(
      "SELECT t.text_original, t.language, t.speaker, c.agent_id, a.kind FROM call_transcripts t JOIN calls c ON c.id = t.call_id LEFT JOIN nepa_agents a ON a.id = c.agent_id WHERE t.id = $1",
      [segmentId])).rows[0];
    if (!s || s.speaker !== "nepa") return null;
    const cfg = s.agent_id ? ((await getConfig(c, s.agent_id, s.kind)).effective as AgentConfig) : null;
    return { text: s.text_original as string, lang: (s.language ?? "en") as string, voiceId: cfg?.voice.voiceId ?? "" };
  });
  if (!seg) return new NextResponse("Not found", { status: 404 });
  try {
    const r = await tts.synthesize({ text: seg.text, voiceId: seg.voiceId, lang: seg.lang });
    return new NextResponse(new Uint8Array(r.audio), { headers: { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=3600" } });
  } catch (e) {
    reportError(e, { route: "tts" });
    return new NextResponse((e as Error).message.includes("voice ID") ? "Set a voice for this agent in AI receptionist → Agents." : "Voice could not be generated.", { status: 502 });
  }
}
