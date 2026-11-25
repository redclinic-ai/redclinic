// WhatsApp message templates. Outside a 24-hour reply window WhatsApp only delivers templates approved in the
// clinic's WhatsApp Business account, so the wording here must match what is submitted for approval there
// (docs/INTEGRATION_REQUIREMENTS.md). Placeholders: {name} {clinic} {assistant} {when} {maps} {phone} {service} {review}.
// Every template is "utility" (about the patient's own care) except review_request, which Meta treats as marketing.

export type Lang = "en" | "hi" | "kn";
export interface Template { label: string; category: "utility" | "marketing"; replies: string; text: Record<Lang, string> }

export const TEMPLATES = {
  appointment_confirmation: {
    label: "Confirm an appointment", category: "utility", replies: "1 confirms the appointment, 2 asks staff to change it",
    text: {
      en: "Hello {name}, this is {assistant} from {clinic}. Your appointment is on {when}. Reply 1 to confirm or 2 if you need to change it.",
      hi: "नमस्ते {name}, मैं {clinic} से {assistant} बोल रही हूँ। आपका अपॉइंटमेंट {when} को है। पक्का करने के लिए 1 भेजें, बदलना हो तो 2 भेजें।",
      kn: "ನಮಸ್ಕಾರ {name}, ನಾನು {clinic} ನಿಂದ {assistant}. ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ {when} ರಂದು ಇದೆ. ಖಚಿತಪಡಿಸಲು 1, ಬದಲಾಯಿಸಲು 2 ಕಳುಹಿಸಿ.",
    },
  },
  no_show_location: {
    label: "Missed appointment, with directions", category: "utility", replies: "1 asks NEPA to call and rebook",
    text: {
      en: "Hello {name}, we missed you at {clinic} today. If you had trouble finding us, here are directions: {maps}. Reply 1 and we will call you to book a new time.",
      hi: "नमस्ते {name}, आज आप {clinic} नहीं आ पाए। रास्ता ढूँढने में दिक्कत हुई हो तो यह रहा: {maps}। नया समय लेने के लिए 1 भेजें, हम आपको कॉल करेंगे।",
      kn: "ನಮಸ್ಕಾರ {name}, ಇಂದು ನೀವು {clinic} ಗೆ ಬರಲಿಲ್ಲ. ದಾರಿ ಹುಡುಕಲು ತೊಂದರೆಯಾಗಿದ್ದರೆ: {maps}. ಹೊಸ ಸಮಯಕ್ಕಾಗಿ 1 ಕಳುಹಿಸಿ, ನಾವು ಕರೆ ಮಾಡುತ್ತೇವೆ.",
    },
  },
  post_visit_checkin: {
    label: "Check-in after a visit", category: "utility", replies: "any worrying reply goes to staff as urgent",
    text: {
      en: "Hello {name}, this is {assistant} from {clinic}. How are you feeling after your visit? Reply here if anything worries you. In an emergency, call 108.",
      hi: "नमस्ते {name}, मैं {clinic} से {assistant}। आपके विज़िट के बाद अब आप कैसा महसूस कर रहे हैं? कोई परेशानी हो तो यहीं बताएँ। आपात स्थिति में 108 पर कॉल करें।",
      kn: "ನಮಸ್ಕಾರ {name}, ನಾನು {clinic} ನಿಂದ {assistant}. ಭೇಟಿಯ ನಂತರ ನೀವು ಹೇಗಿದ್ದೀರಿ? ಏನಾದರೂ ತೊಂದರೆ ಇದ್ದರೆ ಇಲ್ಲಿ ತಿಳಿಸಿ. ತುರ್ತು ಸಂದರ್ಭದಲ್ಲಿ 108 ಗೆ ಕರೆ ಮಾಡಿ.",
    },
  },
  next_visit: {
    label: "Invite to book the next visit", category: "utility", replies: "1 asks NEPA to call and book",
    text: {
      en: "Hello {name}, it is time for your next check-up at {clinic}. Reply 1 and we will call you to book, or call us on {phone}.",
      hi: "नमस्ते {name}, {clinic} में आपके अगले चेक-अप का समय हो गया है। बुक करने के लिए 1 भेजें, हम कॉल करेंगे, या हमें {phone} पर कॉल करें।",
      kn: "ನಮಸ್ಕಾರ {name}, {clinic} ನಲ್ಲಿ ನಿಮ್ಮ ಮುಂದಿನ ತಪಾಸಣೆಯ ಸಮಯ ಬಂದಿದೆ. ಬುಕ್ ಮಾಡಲು 1 ಕಳುಹಿಸಿ, ನಾವು ಕರೆ ಮಾಡುತ್ತೇವೆ, ಅಥವಾ {phone} ಗೆ ಕರೆ ಮಾಡಿ.",
    },
  },
  review_request: {
    label: "Ask for a Google review", category: "marketing", replies: "STOP stops messages",
    text: {
      en: "Thank you for visiting {clinic}, {name}. If you were happy with your care, a short Google review helps other patients find us: {review}. Reply STOP to stop these messages.",
      hi: "{clinic} आने के लिए धन्यवाद, {name}। अगर आप हमारी सेवा से खुश हैं, तो एक छोटा Google रिव्यू दूसरों की मदद करता है: {review}। ये संदेश बंद करने के लिए STOP भेजें।",
      kn: "{clinic} ಗೆ ಭೇಟಿ ನೀಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು, {name}. ನಿಮಗೆ ತೃಪ್ತಿಯಾಗಿದ್ದರೆ, ಒಂದು ಚಿಕ್ಕ Google ವಿಮರ್ಶೆ ಇತರರಿಗೆ ಸಹಾಯ ಮಾಡುತ್ತದೆ: {review}. ಈ ಸಂದೇಶಗಳನ್ನು ನಿಲ್ಲಿಸಲು STOP ಕಳುಹಿಸಿ.",
    },
  },
  lead_welcome: {
    label: "Welcome a new enquiry", category: "utility", replies: "any reply goes to staff",
    text: {
      en: "Hello {name}, thank you for your interest in {clinic}. This is {assistant}. We will call you shortly to help you book. You can also call us on {phone}.",
      hi: "नमस्ते {name}, {clinic} में रुचि के लिए धन्यवाद। मैं {assistant}। बुकिंग में मदद के लिए हम आपको जल्द कॉल करेंगे। आप हमें {phone} पर भी कॉल कर सकते हैं।",
      kn: "ನಮಸ್ಕಾರ {name}, {clinic} ಬಗ್ಗೆ ಆಸಕ್ತಿ ತೋರಿಸಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ನಾನು {assistant}. ಬುಕ್ ಮಾಡಲು ನಾವು ಶೀಘ್ರದಲ್ಲೇ ಕರೆ ಮಾಡುತ್ತೇವೆ. ನೀವು {phone} ಗೆ ಕರೆ ಮಾಡಬಹುದು.",
    },
  },
} as const satisfies Record<string, Template>;
export type TemplateKey = keyof typeof TEMPLATES;
export const TEMPLATE_KEYS = Object.keys(TEMPLATES) as [TemplateKey, ...TemplateKey[]];

/** Fills placeholders. A template that needs a value the clinic has not set (directions, review link) is not sendable. */
export function render(key: TemplateKey, lang: Lang, vars: Record<string, string | null | undefined>): { ok: true; text: string } | { ok: false; missing: string } {
  const t = TEMPLATES[key].text[lang] ?? TEMPLATES[key].text.en;
  let missing = "";
  const text = t.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vars[k];
    if (!v) { missing ||= k; return ""; }
    return v;
  });
  return missing ? { ok: false, missing } : { ok: true, text };
}

const NEED: Record<string, string> = { maps: "a directions link", review: "a Google review link", phone: "the clinic phone number", when: "the appointment time" };
export const describeMissing = (k: string) => NEED[k] ?? k;
