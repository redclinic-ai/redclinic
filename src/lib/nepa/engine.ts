// NEPA conversation engine.
// `ConversationModel` is the seam where a real LLM goes once one is selected (DECISIONS D2). Until then the
// RuleBasedModel below runs every call: it is deterministic, follows the resolved instructions, and is always
// labelled "simulated" in records. Safety rules (emergency, medical advice, AI objection) are checked in code at
// the start of each turn. An LLM adapter must keep that order: run the same checks first, use the model only after.
import type { Resolved } from "./resolver";
import { answerFaq, findCaller, freeSlots, handToStaff, requestBooking, requestReschedule, requestStatusChange, type ActionOutcome, type ToolContext } from "./tools";

export type Lang = "en" | "hi" | "kn";

export interface Turn { speaker: "nepa" | "caller"; text: string; lang: Lang; atMs: number }
export interface ConversationState {
  lang: Lang;
  turns: Turn[];
  callerPhone: string | null;
  patient: { patientId: string; name: string; consent: string; nextAppointmentId: string | null; nextAt: Date | null } | null;
  intent: string | null;
  outcome: string | null;
  handedOff: boolean;
  ended: boolean;
  awaiting: null | { kind: "book_time" | "book_confirm" | "name"; slot?: { doctorId: string; doctorName: string; start: string }; reason?: string };
  actions: { tool: string; outcome: ActionOutcome | { status: string } }[];
  unknownCount: number;
}

export function newConversation(callerPhone: string | null, lang: Lang = "en"): ConversationState {
  return { lang, turns: [], callerPhone, patient: null, intent: null, outcome: null, handedOff: false, ended: false, awaiting: null, actions: [], unknownCount: 0 };
}

export function detectLang(text: string, fallback: Lang): Lang {
  if (/[ಀ-೿]/.test(text)) return "kn";
  if (/[ऀ-ॿ]/.test(text)) return "hi";
  if (/\b(namaste|namaskar|haan|nahi|kya|mujhe|aap|chahiye|kal|aaj|dard|daant)\b/i.test(text)) return "hi";
  if (/\b(namaskara|beku|illa|houdu|naale|ivattu|hallu)\b/i.test(text)) return "kn";
  return /[a-z]{3,}/i.test(text) ? "en" : fallback;
}

// ---------- intents (checked in this order: safety first) ----------
const RX = {
  emergency: /\b(can'?t breathe|cannot breathe|difficulty breathing|chest pain|heart attack|unconscious|fainted|not breathing|severe bleeding|bleeding (a lot|won'?t stop|heavily)|lot of bleeding|won'?t stop bleeding|accident|broken jaw|seizure|fits|stroke|suicid\w*|poison\w*|overdose)\b|सांस नहीं|सीने में दर्द|बेहोश|बहुत खून|ಉಸಿರಾಡಲು|ಎದೆ ನೋವು|ಪ್ರಜ್ಞೆ/i,
  objection: /\b(robot|bot|machine|not a (real )?person|real person|human|talk to (a )?(person|someone|staff|doctor|receptionist)|speak to (a )?(person|someone|staff|receptionist)|don'?t record|stop recording|no recording)\b|इंसान|असली व्यक्ति|रिकॉर्ड मत|ಮನುಷ್ಯ/i,
  medical: /\b(which (medicine|tablet|antibiotic|painkiller)|what (medicine|tablet)|should i take|dose|dosage|is (it|this|that|my)\b[^?.]{0,40}\b(infection|infected|serious|cancer|normal|dangerous|broken|cavity)|do i need (a |an )?(root canal|extraction|antibiotic|surgery|medicine)|what (is wrong|do i have)|diagnos\w*|prescri\w*|home remedy|can i (eat|drink|take))\b|कौन सी दवा|दवाई|ಯಾವ ಮಾತ್ರೆ|ಔಷಧ/i,
  cancel: /\b(cancel|call off|won'?t be able to come|can'?t come)\b|रद्द|कैंसल|ರದ್ದು/i,
  reschedule: /\b(reschedul\w*|change (my |the )?(appointment|time|date)|move (my |the )?appointment|another (day|time)|postpone|prepone)\b|बदल|ಬದಲಾ/i,
  confirm: /^(yes|yeah|yep|ok(ay)?|sure|confirm(ed)?|i will come|i'?ll (be there|come)|haan|ha|ji|theek hai|houdu|sari)\b|^हाँ|^हां|^ठीक|^ಹೌದು|^ಸರಿ/i,
  deny: /^(no|nope|not now|nahi|illa)\b|^नहीं|^ಇಲ್ಲ/i,
  book: /\b(appointment|book|booking|slot|see (the )?doctor|consult\w*|check ?up|visit|come in|cleaning|root canal|braces|filling|extraction|tooth ?ache|toothache|pain)\b|अपॉइंटमेंट|अपोइंटमेंट|डॉक्टर से मिल|दांत|दर्द|ಅಪಾಯಿಂಟ್ಮೆಂಟ್|ಹಲ್ಲು|ನೋವು/i,
  availability: /\b(is (dr|doctor)\b.*\b(available|there|in)|available on|open on|timings?|when (is|are) (you|the clinic) open|what time)\b|कब खुला|ಸಮಯ/i,
  complaint: /\b(complain\w*|unhappy|bad experience|rude|waited (too long|for hours)|refund|overcharged)\b|शिकायत|ದೂರು/i,
  bye: /\b(bye|thank you|thanks|that'?s all|nothing else|dhanyavad|shukriya)\b|धन्यवाद|ಧನ್ಯವಾದ/i,
};

// ---------- what NEPA says (approved wording, three languages) ----------
type Msg = Record<Lang, string>;
const T = {
  disclose: { en: "Hello, this is {name}, {clinic}'s AI receptionist. This call may be recorded for clinic records.", hi: "नमस्ते, मैं {name} हूँ, {clinic} की एआई रिसेप्शनिस्ट। यह कॉल क्लिनिक के रिकॉर्ड के लिए रिकॉर्ड की जा सकती है।", kn: "ನಮಸ್ಕಾರ, ನಾನು {name}, {clinic} ನ ಎಐ ರಿಸೆಪ್ಷನಿಸ್ಟ್. ಈ ಕರೆಯನ್ನು ಕ್ಲಿನಿಕ್ ದಾಖಲೆಗಾಗಿ ರೆಕಾರ್ಡ್ ಮಾಡಬಹುದು." },
  howHelp: { en: "How can I help you today?", hi: "मैं आपकी क्या मदद कर सकती हूँ?", kn: "ನಾನು ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?" },
  emergency: { en: "This sounds like an emergency. Please call 108 or 112 now, or go to the nearest hospital emergency department. I am alerting the clinic staff as well.", hi: "यह आपातकाल लग रहा है। कृपया तुरंत 108 या 112 पर कॉल करें, या नज़दीकी अस्पताल की इमरजेंसी में जाएँ। मैं क्लिनिक स्टाफ़ को भी सूचित कर रही हूँ।", kn: "ಇದು ತುರ್ತು ಪರಿಸ್ಥಿತಿ ಎನಿಸುತ್ತದೆ. ದಯವಿಟ್ಟು ಈಗಲೇ 108 ಅಥವಾ 112 ಗೆ ಕರೆ ಮಾಡಿ, ಅಥವಾ ಹತ್ತಿರದ ಆಸ್ಪತ್ರೆಯ ತುರ್ತು ವಿಭಾಗಕ್ಕೆ ಹೋಗಿ. ನಾನು ಕ್ಲಿನಿಕ್ ಸಿಬ್ಬಂದಿಗೂ ತಿಳಿಸುತ್ತಿದ್ದೇನೆ." },
  handoff: { en: "Of course. I'm connecting you to the clinic staff now. If nobody picks up, they will call you back soon.", hi: "ज़रूर। मैं आपको अभी क्लिनिक स्टाफ़ से जोड़ रही हूँ। अगर कोई फ़ोन न उठाए, तो वे जल्द ही आपको कॉल करेंगे।", kn: "ಖಂಡಿತ. ನಿಮ್ಮನ್ನು ಈಗ ಕ್ಲಿನಿಕ್ ಸಿಬ್ಬಂದಿಗೆ ಸಂಪರ್ಕಿಸುತ್ತಿದ್ದೇನೆ. ಯಾರೂ ಉತ್ತರಿಸದಿದ್ದರೆ, ಅವರು ಶೀಘ್ರದಲ್ಲೇ ಕರೆ ಮಾಡುತ್ತಾರೆ." },
  noMedical: { en: "I'm sorry, I can't give medical advice or suggest medicines. The doctor can check this properly. Would you like me to request an appointment?", hi: "माफ़ कीजिए, मैं चिकित्सा सलाह या दवा नहीं बता सकती। डॉक्टर इसे ठीक से देख सकते हैं। क्या मैं आपके लिए अपॉइंटमेंट का अनुरोध करूँ?", kn: "ಕ್ಷಮಿಸಿ, ನಾನು ವೈದ್ಯಕೀಯ ಸಲಹೆ ಅಥವಾ ಔಷಧಿ ಹೇಳಲು ಸಾಧ್ಯವಿಲ್ಲ. ವೈದ್ಯರು ಸರಿಯಾಗಿ ನೋಡುತ್ತಾರೆ. ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಬೇಕೇ?" },
  dontKnow: { en: "I don't have that information. I'll ask the clinic staff to call you back with the answer.", hi: "मेरे पास यह जानकारी नहीं है। मैं क्लिनिक स्टाफ़ से कहूँगी कि वे आपको जवाब के साथ कॉल करें।", kn: "ಆ ಮಾಹಿತಿ ನನ್ನ ಬಳಿ ಇಲ್ಲ. ಕ್ಲಿನಿಕ್ ಸಿಬ್ಬಂದಿ ಉತ್ತರದೊಂದಿಗೆ ಕರೆ ಮಾಡಲು ಹೇಳುತ್ತೇನೆ." },
  offerSlot: { en: "The earliest time I can see is {when} with {doctor}. Shall I request that?", hi: "सबसे पहला समय {when} है, {doctor} के साथ। क्या मैं यह अनुरोध करूँ?", kn: "ಮೊದಲ ಲಭ್ಯ ಸಮಯ {when}, {doctor} ಅವರೊಂದಿಗೆ. ಅದನ್ನು ಕೇಳಲೇ?" },
  noSlots: { en: "I can't see a free time in the next few days. I'll ask the staff to call you to fix a time.", hi: "अगले कुछ दिनों में खाली समय नहीं दिख रहा। मैं स्टाफ़ से कहूँगी कि वे समय तय करने के लिए आपको कॉल करें।", kn: "ಮುಂದಿನ ಕೆಲವು ದಿನಗಳಲ್ಲಿ ಖಾಲಿ ಸಮಯ ಕಾಣುತ್ತಿಲ್ಲ. ಸಮಯ ನಿಗದಿಪಡಿಸಲು ಸಿಬ್ಬಂದಿ ಕರೆ ಮಾಡುತ್ತಾರೆ." },
  askName: { en: "May I have your full name, please?", hi: "कृपया अपना पूरा नाम बताइए।", kn: "ದಯವಿಟ್ಟು ನಿಮ್ಮ ಪೂರ್ಣ ಹೆಸರು ಹೇಳಿ." },
  booked: { en: "Done. Your appointment is booked for {when} with {doctor}.", hi: "हो गया। आपकी अपॉइंटमेंट {when} को {doctor} के साथ बुक है।", kn: "ಆಯಿತು. ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ {when} ಕ್ಕೆ {doctor} ಅವರೊಂದಿಗೆ ಬುಕ್ ಆಗಿದೆ." },
  requested: { en: "I've sent your request for {when} to the clinic. They will confirm it with you shortly. It is not booked until they confirm.", hi: "मैंने {when} के लिए आपका अनुरोध क्लिनिक को भेज दिया है। वे जल्द ही पुष्टि करेंगे। पुष्टि होने तक यह बुक नहीं है।", kn: "{when} ಕ್ಕೆ ನಿಮ್ಮ ವಿನಂತಿಯನ್ನು ಕ್ಲಿನಿಕ್‌ಗೆ ಕಳುಹಿಸಿದ್ದೇನೆ. ಅವರು ಶೀಘ್ರದಲ್ಲೇ ಖಚಿತಪಡಿಸುತ್ತಾರೆ. ಖಚಿತವಾಗುವವರೆಗೆ ಬುಕ್ ಆಗಿಲ್ಲ." },
  failed: { en: "Sorry, I couldn't complete that. The clinic staff will call you back to sort it out.", hi: "माफ़ कीजिए, यह पूरा नहीं हो सका। क्लिनिक स्टाफ़ आपको कॉल करेगा।", kn: "ಕ್ಷಮಿಸಿ, ಅದು ಪೂರ್ಣಗೊಳ್ಳಲಿಲ್ಲ. ಕ್ಲಿನಿಕ್ ಸಿಬ್ಬಂದಿ ಕರೆ ಮಾಡುತ್ತಾರೆ." },
  cancelled: { en: "Your appointment on {when} is cancelled.", hi: "{when} की आपकी अपॉइंटमेंट रद्द कर दी गई है।", kn: "{when} ರ ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ರದ್ದಾಗಿದೆ." },
  changeRequested: { en: "I've passed your request to the clinic. They will call you to confirm.", hi: "मैंने आपका अनुरोध क्लिनिक को भेज दिया है। वे पुष्टि के लिए कॉल करेंगे।", kn: "ನಿಮ್ಮ ವಿನಂತಿಯನ್ನು ಕ್ಲಿನಿಕ್‌ಗೆ ತಿಳಿಸಿದ್ದೇನೆ. ಅವರು ಕರೆ ಮಾಡುತ್ತಾರೆ." },
  noAppointment: { en: "I couldn't find an upcoming appointment for this number. I'll ask the staff to call you back.", hi: "इस नंबर पर कोई आने वाली अपॉइंटमेंट नहीं मिली। मैं स्टाफ़ से कॉल करने को कहूँगी।", kn: "ಈ ಸಂಖ್ಯೆಗೆ ಮುಂದಿನ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಸಿಗಲಿಲ್ಲ. ಸಿಬ್ಬಂದಿ ಕರೆ ಮಾಡುತ್ತಾರೆ." },
  confirmed: { en: "Thank you, your appointment on {when} is confirmed.", hi: "धन्यवाद, {when} की आपकी अपॉइंटमेंट पक्की है।", kn: "ಧನ್ಯವಾದ, {when} ರ ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಖಚಿತವಾಗಿದೆ." },
  complaint: { en: "I'm sorry to hear that. I've noted it and the clinic will call you back.", hi: "यह सुनकर खेद है। मैंने इसे दर्ज कर लिया है और क्लिनिक आपको कॉल करेगा।", kn: "ಕೇಳಿ ಬೇಸರವಾಯಿತು. ಇದನ್ನು ದಾಖಲಿಸಿದ್ದೇನೆ, ಕ್ಲಿನಿಕ್ ಕರೆ ಮಾಡುತ್ತದೆ." },
  notUnderstood: { en: "Sorry, could you say that again?", hi: "माफ़ कीजिए, क्या आप फिर से बता सकते हैं?", kn: "ಕ್ಷಮಿಸಿ, ಮತ್ತೊಮ್ಮೆ ಹೇಳುತ್ತೀರಾ?" },
  anythingElse: { en: "Is there anything else I can help with?", hi: "क्या मैं और कुछ मदद कर सकती हूँ?", kn: "ಇನ್ನೇನಾದರೂ ಸಹಾಯ ಬೇಕೇ?" },
  bye: { en: "Thank you for calling {clinic}. Goodbye.", hi: "{clinic} को कॉल करने के लिए धन्यवाद। नमस्ते।", kn: "{clinic} ಗೆ ಕರೆ ಮಾಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದ. ವಂದನೆಗಳು." },
  noSay: { en: "No problem.", hi: "कोई बात नहीं।", kn: "ಪರವಾಗಿಲ್ಲ." },
} satisfies Record<string, Msg>;

function say(m: Msg, lang: Lang, vars: Record<string, string> = {}) {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), m[lang] ?? m.en);
}

export interface EngineResult { reply: string; state: ConversationState }

export interface ConversationModel {
  readonly name: string;
  readonly simulated: boolean;
  next(t: ToolContext, state: ConversationState, callerSays: string | null): Promise<EngineResult>;
}

const fmtWhen = (d: Date, tz: string, lang: Lang = "en") => d.toLocaleString(lang === "hi" ? "hi-IN" : lang === "kn" ? "kn-IN" : "en-IN", { timeZone: tz, weekday: "long", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** Deterministic rule-based model. Used for simulated calls and the Testing Simulator. */
export class RuleBasedModel implements ConversationModel {
  readonly name = "rule-based";
  readonly simulated = true;

  async next(t: ToolContext, s: ConversationState, callerSays: string | null): Promise<EngineResult> {
    const r = t.r;
    const tz = r.knowledge.clinic.timezone;
    const lang0 = s.lang;
    const allowed = (l: Lang): Lang => (r.languages.includes(l) ? l : (r.languages.includes(r.clinicConfig.preferredLanguage) ? r.clinicConfig.preferredLanguage : (r.languages[0] as Lang)) ?? "en");
    const reply = (text: string) => {
      s.turns.push({ speaker: "nepa", text, lang: s.lang, atMs: s.turns.length * 4000 });
      return { reply: text, state: s };
    };
    const vars = { name: r.agentConfig?.name ?? "Nepa", clinic: r.knowledge.clinic.name };

    // opening turn: mandatory AI and recording disclosure, then the configured greeting
    if (callerSays === null) {
      s.lang = allowed(lang0);
      if (s.callerPhone && !s.patient) s.patient = await findCaller(t, s.callerPhone);
      const custom = r.agentConfig?.scripts.greeting || r.clinicConfig.greeting[s.lang];
      const conflict = r.conflicts.some((c) => c.field.startsWith("greeting") || c.field === "scripts.greeting");
      return reply(`${say(T.disclose, s.lang, vars)} ${custom && !conflict ? custom : say(T.howHelp, s.lang)}`);
    }

    s.turns.push({ speaker: "caller", text: callerSays, lang: detectLang(callerSays, s.lang), atMs: s.turns.length * 4000 });
    if (r.clinicConfig.languageSwitching) s.lang = allowed(detectLang(callerSays, s.lang));
    const text = callerSays.trim();
    const patientId = s.patient?.patientId ?? null;

    // 1. safety: emergencies always first
    if (RX.emergency.test(text)) {
      s.intent = "emergency"; s.outcome = "escalated_emergency"; s.handedOff = true; s.ended = true;
      await handToStaff(t, "call_handed_over", `EMERGENCY described by caller: “${text.slice(0, 200)}”. Caller told to call 108/112.`, 1, patientId);
      s.actions.push({ tool: "hand_to_staff", outcome: { status: "done" } });
      return reply(say(T.emergency, s.lang));
    }
    // 2. caller objects to AI or recording, asks for a person, or a clinic escalation keyword
    const extraKeywords = [...(r.clinicConfig.escalation.keywords ?? []), ...(r.agentConfig?.escalation.keywords ?? [])].filter(Boolean);
    if (RX.objection.test(text) || extraKeywords.some((k) => text.toLowerCase().includes(k.toLowerCase()))) {
      s.intent = s.intent ?? "speak_to_staff"; s.outcome = "handed_to_staff"; s.handedOff = true; s.ended = true;
      await handToStaff(t, "call_handed_over", `Caller asked for staff: “${text.slice(0, 200)}”`, 2, patientId);
      s.actions.push({ tool: "hand_to_staff", outcome: { status: "done" } });
      return reply(say(T.handoff, s.lang));
    }
    // 3. medical advice: refuse and offer an appointment
    if (RX.medical.test(text)) {
      s.intent = "medical_question";
      s.awaiting = { kind: "book_confirm", reason: text.slice(0, 120) };
      const slot = (await this.firstSlot(t))[0];
      if (slot) s.awaiting.slot = { doctorId: slot.doctorId, doctorName: slot.doctorName, start: slot.start.toISOString() };
      return reply(say(T.noMedical, s.lang));
    }

    // 4. answers to NEPA's own questions
    if (s.awaiting?.kind === "name") {
      const name = text.replace(/^(my name is|i am|this is|mera naam|naan)\s+/i, "").trim();
      if (name.length < 2) return reply(say(T.askName, s.lang));
      const id = (await t.c.query("SELECT rc_nepa_register_caller($1,$2,$3) AS id", [name.slice(0, 120), s.callerPhone, s.awaiting.reason ?? null])).rows[0].id;
      s.patient = { patientId: id, name, consent: "not_recorded", nextAppointmentId: null, nextAt: null };
      s.awaiting = { ...s.awaiting, kind: "book_confirm" };
      return this.book(t, s, reply);
    }
    if (s.awaiting?.kind === "book_confirm") {
      if (RX.confirm.test(text) || (s.intent === "medical_question" && RX.book.test(text))) {
        if (!s.awaiting.slot) { s.awaiting = null; return this.noSlot(t, s, reply); }
        if (!s.patient) { s.awaiting = { ...s.awaiting, kind: "name" }; return reply(say(T.askName, s.lang)); }
        return this.book(t, s, reply);
      }
      if (RX.deny.test(text)) { s.awaiting = null; return reply(`${say(T.noSay, s.lang)} ${say(T.anythingElse, s.lang)}`); }
    }

    // 5. what the caller wants
    if (RX.cancel.test(text)) {
      s.intent = "cancel";
      if (!s.patient?.nextAppointmentId) {
        await handToStaff(t, "cancellation_request", `Wants to cancel, but no upcoming appointment found for ${s.callerPhone ?? "unknown number"}.`, 2, patientId);
        return reply(say(T.noAppointment, s.lang));
      }
      const out = await requestStatusChange(t, s.patient.nextAppointmentId, "cancelled", patientId, "Cancelled by patient on call");
      s.actions.push({ tool: "cancel_appointment", outcome: out });
      s.outcome = out.status === "done" ? "cancelled" : out.status === "failed" ? "action_failed" : "request_sent";
      if (out.status === "done") return reply(`${say(T.cancelled, s.lang, { when: fmtWhen(s.patient.nextAt!, tz, s.lang) })} ${say(T.anythingElse, s.lang)}`);
      return reply(say(out.status === "failed" ? T.failed : T.changeRequested, s.lang));
    }
    if (RX.reschedule.test(text)) {
      s.intent = "reschedule";
      if (!s.patient?.nextAppointmentId) {
        await handToStaff(t, "reschedule_request", `Wants to reschedule: “${text.slice(0, 200)}”, no upcoming appointment found.`, 2, patientId);
        return reply(say(T.noAppointment, s.lang));
      }
      const out = await requestReschedule(t, s.patient.nextAppointmentId, patientId, text.slice(0, 200));
      s.actions.push({ tool: "reschedule_appointment", outcome: out });
      s.outcome = "request_sent";
      return reply(say(T.changeRequested, s.lang));
    }
    if (s.patient?.nextAppointmentId && RX.confirm.test(text) && s.intent === "confirmation") {
      const out = await requestStatusChange(t, s.patient.nextAppointmentId, "confirmed", patientId);
      s.actions.push({ tool: "confirm_appointment", outcome: out });
      s.outcome = out.status === "done" ? "confirmed" : "action_failed";
      return reply(out.status === "done" ? say(T.confirmed, s.lang, { when: fmtWhen(s.patient.nextAt!, tz, s.lang) }) : say(T.failed, s.lang));
    }
    if (RX.complaint.test(text)) {
      s.intent = "complaint"; s.outcome = "handed_to_staff";
      await handToStaff(t, "complaint", `Complaint on call: “${text.slice(0, 300)}”`, 2, patientId);
      return reply(say(T.complaint, s.lang));
    }
    // approved answers come before booking keywords ("do you do root canal?" is a question)
    const faq = answerFaq(r, text, s.lang);
    if (faq && !/\b(book|appointment)\b/i.test(text)) {
      s.intent = s.intent ?? "faq"; s.outcome = s.outcome ?? "answered";
      s.actions.push({ tool: "answer_faq", outcome: { status: "done" } });
      return reply(`${faq.answer} ${say(T.anythingElse, s.lang)}`);
    }
    if (RX.book.test(text)) {
      s.intent = "booking";
      const slot = (await this.firstSlot(t))[0];
      if (!slot) return this.noSlot(t, s, reply);
      s.awaiting = { kind: "book_confirm", slot: { doctorId: slot.doctorId, doctorName: slot.doctorName, start: slot.start.toISOString() }, reason: text.slice(0, 120) };
      return reply(say(T.offerSlot, s.lang, { when: fmtWhen(slot.start, tz, s.lang), doctor: slot.doctorName }));
    }
    if (RX.availability.test(text)) {
      // never invent availability or timings that are not in the approved data
      s.intent = "availability_question"; s.outcome = "callback_needed";
      await handToStaff(t, "unanswered_question", `Asked: “${text.slice(0, 200)}”`, 2, patientId);
      return reply(say(T.dontKnow, s.lang));
    }
    if (RX.bye.test(text) || (RX.deny.test(text) && s.turns.length > 3)) {
      s.ended = true; s.outcome = s.outcome ?? "ended_by_caller";
      return reply(say(T.bye, s.lang, vars));
    }
    // a real question with no approved answer: never improvise
    if (text.split(/\s+/).length >= 4 || /\?$/.test(text)) {
      s.intent = s.intent ?? "question"; s.outcome = "callback_needed";
      await handToStaff(t, "unanswered_question", `Question NEPA could not answer: “${text.slice(0, 200)}”`, 2, patientId);
      return reply(`${say(T.dontKnow, s.lang)} ${say(T.anythingElse, s.lang)}`);
    }
    s.unknownCount++;
    if (s.unknownCount >= 3 || s.turns.length >= (r.agentConfig?.escalation.maxTurnsBeforeHandoff ?? 12) * 2) {
      s.handedOff = true; s.ended = true; s.outcome = "handed_to_staff";
      await handToStaff(t, "call_not_completed", "NEPA could not understand the caller.", 2, patientId);
      return reply(say(T.handoff, s.lang));
    }
    return reply(say(T.notUnderstood, s.lang));
  }

  private async firstSlot(t: ToolContext) {
    const tz = t.r.knowledge.clinic.timezone;
    for (let i = 0; i < 7; i++) {
      const date = new Date(Date.now() + i * 86_400_000).toLocaleDateString("en-CA", { timeZone: tz });
      const slots = await freeSlots(t, date);
      if (slots.length) return slots;
    }
    return [];
  }

  private async noSlot(t: ToolContext, s: ConversationState, reply: (x: string) => EngineResult) {
    s.outcome = "callback_needed";
    await handToStaff(t, "unanswered_question", "Wants an appointment; no free time found in the next 7 days (or opening hours not set).", 2, s.patient?.patientId ?? null);
    return reply(say(T.noSlots, s.lang));
  }

  private async book(t: ToolContext, s: ConversationState, reply: (x: string) => EngineResult) {
    const slot = s.awaiting!.slot!;
    const minutes = t.r.knowledge.services[0]?.durationMinutes ?? 30;
    const out = await requestBooking(t, { patientId: s.patient!.patientId, doctorId: slot.doctorId, start: new Date(slot.start), minutes, reason: s.awaiting?.reason ?? null });
    s.actions.push({ tool: "book_appointment", outcome: out });
    s.awaiting = null;
    const when = fmtWhen(new Date(slot.start), t.r.knowledge.clinic.timezone, s.lang);
    if (out.status === "done") { s.outcome = "booked"; return reply(`${say(T.booked, s.lang, { when, doctor: slot.doctorName })} ${say(T.anythingElse, s.lang)}`); }
    if (out.status === "awaiting_approval" || out.status === "suggested") { s.outcome = "booking_requested"; return reply(`${say(T.requested, s.lang, { when })} ${say(T.anythingElse, s.lang)}`); }
    s.outcome = "action_failed";
    await handToStaff(t, "call_not_completed", `Booking could not be completed: ${"reason" in out ? out.reason : ""}`, 2, s.patient!.patientId);
    return reply(say(T.failed, s.lang));
  }
}

export function getModel(): ConversationModel {
  // When an LLM provider is selected, return its adapter here (behind the same safety checks).
  return new RuleBasedModel();
}
