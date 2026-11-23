import { describe, expect, it } from "vitest";
import { CartesiaTextToSpeech, verifySignature } from "@/lib/providers";
import { createHmac } from "node:crypto";

describe("Cartesia adapter (request shape; no network)", () => {
  it("sends the documented request: Bearer auth, version header, Sonic 3.6, Indian locale, 16 kHz WAV", () => {
    const r = new CartesiaTextToSpeech("sk_car_test").request({ text: "नमस्ते", voiceId: "voice-1", lang: "hi" });
    expect(r.url).toBe("https://api.cartesia.ai/tts/bytes");
    expect(r.init.headers).toEqual({ Authorization: "Bearer sk_car_test", "Cartesia-Version": "2026-08-14", "Content-Type": "application/json" });
    expect(JSON.parse(r.init.body)).toEqual({ model_id: "sonic-3.6", transcript: "नमस्ते", voice: { id: "voice-1" }, locale: "hi-IN", output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: 16000 } });
  });

  it("accepts WAV, rejects errors and non-audio replies, and needs a voice", async () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    const ok = new CartesiaTextToSpeech("k", undefined, undefined, (async () => new Response(wav, { status: 200 })) as typeof fetch);
    expect((await ok.synthesize({ text: "hi", voiceId: "v", lang: "en" })).audio.length).toBe(8);
    const denied = new CartesiaTextToSpeech("k", undefined, undefined, (async () => new Response("bad key", { status: 401 })) as typeof fetch);
    await expect(denied.synthesize({ text: "hi", voiceId: "v", lang: "en" })).rejects.toThrow(/401/);
    const html = new CartesiaTextToSpeech("k", undefined, undefined, (async () => new Response("<html>", { status: 200 })) as typeof fetch);
    await expect(html.synthesize({ text: "hi", voiceId: "v", lang: "en" })).rejects.toThrow(/WAV/);
    await expect(ok.synthesize({ text: "hi", voiceId: "", lang: "en" })).rejects.toThrow(/voice/);
  });
});

describe("webhook signatures", () => {
  it("accepts only the right HMAC", () => {
    const sig = createHmac("sha256", "s").update("body").digest("hex");
    expect(verifySignature("body", sig, "s")).toBe(true);
    expect(verifySignature("body", `sha256=${sig}`, "s")).toBe(true);
    expect(verifySignature("body!", sig, "s")).toBe(false);
    expect(verifySignature("body", sig, "")).toBe(false);
    expect(verifySignature("body", null, "s")).toBe(false);
  });
});
