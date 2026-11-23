// Checks the Cartesia key: synthesises one short line in English, Hindi and Kannada with the given voice.
//   CARTESIA_API_KEY=sk_car_... CARTESIA_VOICE_ID=<voice id from play.cartesia.ai> npm run check-cartesia
// If all three pass, set CARTESIA_VERIFIED=1 in the server's secrets to switch the voice on.
import { writeFileSync } from "node:fs";
import { CartesiaTextToSpeech } from "../src/lib/providers/index.ts";

const key = process.env.CARTESIA_API_KEY, voice = process.env.CARTESIA_VOICE_ID;
if (!key || !voice) { console.error("Set CARTESIA_API_KEY and CARTESIA_VOICE_ID."); process.exit(1); }
const tts = new CartesiaTextToSpeech(key);
const lines = { en: "Hello, this is the clinic's AI receptionist.", hi: "नमस्ते, मैं क्लिनिक की एआई रिसेप्शनिस्ट हूँ।", kn: "ನಮಸ್ಕಾರ, ನಾನು ಕ್ಲಿನಿಕ್‌ನ ಎಐ ರಿಸೆಪ್ಷನಿಸ್ಟ್." };
let ok = 0;
for (const [lang, text] of Object.entries(lines)) {
  const t = Date.now();
  try {
    const r = await tts.synthesize({ text, voiceId: voice, lang });
    writeFileSync(`cartesia-check-${lang}.wav`, r.audio);
    console.log(`PASS ${lang}: ${r.audio.length} bytes in ${Date.now() - t} ms → cartesia-check-${lang}.wav`);
    ok++;
  } catch (e) { console.log(`FAIL ${lang}: ${(e as Error).message}`); }
}
console.log(ok === 3 ? "\nConnection verified. Listen to the three files, then set CARTESIA_VERIFIED=1." : "\nNot verified.");
process.exit(ok === 3 ? 0 : 1);
