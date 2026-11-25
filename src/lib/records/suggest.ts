// Suggests record items from a document's text: medicines, diagnoses, allergies and lab values.
// Plain rules, no AI: predictable, explainable, and every suggestion carries the exact line it came from.
// Nothing here is saved; a doctor ticks what is right on the review screen.

export type SuggestionKind = "medication" | "condition" | "allergy" | "lab";
export interface Suggestion {
  key: string;
  kind: SuggestionKind;
  fields: Record<string, string>;
  evidence: { page: number; line: number; text: string };
}

const FORM = /\b(tab|tabs|tablet|cap|caps|capsule|syp|syrup|susp|suspension|inj|injection|oint|ointment|gel|drops?|mouthwash|mouth wash|cream|lotion|inhaler|sachet|powder)\b\.?/i;
const STRENGTH = /(\d+(?:\.\d+)?\s?(?:mg|mcg|g|gm|ml|iu|%|units?))\b/i;
const FREQ = /\b(\d\s?-\s?\d\s?-\s?\d(?:\s?-\s?\d)?|od|bd|bid|tds|tid|qid|hs|sos|stat|once (?:a )?daily|twice (?:a )?daily|thrice (?:a )?daily|once|twice|thrice|daily|at night|morning)\b/i;
const DURATION = /(?:x|for|×)\s*(\d+\s*(?:days?|weeks?|months?|d|wks?))\b/i;
const INSTR = /\b(after food|before food|with food|empty stomach|before bed|after meals|before meals)\b/i;
const DIAG = /^(?:provisional\s+)?(?:diagnosis|dx|impression|diagnosed with|assessment)\s*[:\-–]\s*(.+)$/i;
const ALLERGY = /^(?:allerg(?:y|ies|ic to))\s*[:\-–]?\s*(.+)$/i;
const NO_ALLERGY = /^(nil|none|no known|nkda|nka|no)\b/i;
const LAB = /^([A-Za-z][A-Za-z .()/,-]{1,40}?)\s*[:\-–]?\s+(\d+(?:\.\d+)?)\s*([a-zA-Zµ/%^0-9.]*(?:\/[a-zA-Zµ0-9.]+)?)\s*(?:\(?\s*(?:ref(?:erence)?\.?\s*(?:range|interval)?\s*:?\s*)?(\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?)\s*\)?)?\s*(high|low|h|l)?\s*$/i;
const NOT_LAB = /^(age|date|patient|name|dr|doctor|phone|mobile|tel|uhid|id|bill|invoice|page|sr|s\.?no|reg|room|bed|tooth|ref|review)\b/i;
const NOT_MEDICINE = /^(patient|name|age|date|dr\.?|diagnosis|allerg|address|review|follow|next visit)\b/i;

function clean(s: string) { return s.replace(/\s+/g, " ").replace(/^[\s\d.)\-•*]+/, "").trim(); }

export function suggest(pages: { page: number; text: string }[]): { items: Suggestion[]; documentDate: string | null } {
  const items: Suggestion[] = [];
  let documentDate: string | null = null;
  let n = 0;
  const add = (kind: SuggestionKind, fields: Record<string, string>, page: number, line: number, text: string) => {
    const k = `${kind}:${Object.values(fields)[0]?.toLowerCase()}`;
    if (items.some((i) => `${i.kind}:${Object.values(i.fields)[0]?.toLowerCase()}` === k)) return;   // same item twice
    items.push({ key: `s${++n}`, kind, fields, evidence: { page, line, text: text.slice(0, 300) } });
  };
  for (const { page, text } of pages) {
    let inRx = false;
    text.split(/\r?\n/).forEach((raw, idx) => {
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line) return;
      const lineNo = idx + 1;
      if (!documentDate) {
        const d = line.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
        if (d && +d[2] >= 1 && +d[2] <= 12 && +d[1] >= 1 && +d[1] <= 31) documentDate = `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}`;
      }
      if (/^(rx|℞|prescription|medicines?|advice)\b\.?:?$/i.test(line)) { inRx = true; return; }

      const dg = line.match(DIAG);
      if (dg) {
        for (const part of dg[1].split(/[;,]| and (?=[A-Z])/)) {
          const name = clean(part);
          if (name.length >= 3) add("condition", { name }, page, lineNo, line);
        }
        return;
      }
      const al = line.match(ALLERGY);
      if (al) {
        if (NO_ALLERGY.test(al[1].trim())) return;
        for (const part of al[1].split(/[;,]/)) {
          const m = part.match(/^\s*([^()]+?)\s*(?:\(([^)]+)\))?\s*$/);
          if (m && clean(m[1]).length >= 2) add("allergy", { substance: clean(m[1]), ...(m[2] ? { reaction: m[2].trim() } : {}) }, page, lineNo, line);
        }
        return;
      }
      const looksMedicine = !NOT_MEDICINE.test(line) && (FORM.test(line) || (inRx && STRENGTH.test(line) && FREQ.test(line)));
      if (looksMedicine) {
        const strength = line.match(STRENGTH)?.[1] ?? "";
        let name = clean(line.replace(FORM, " ").split(STRENGTH)[0].split(FREQ)[0].split(DURATION)[0]);
        name = name.replace(/\b(\d+(\.\d+)?)$/, "").trim();
        if (name.length >= 3 && name.length <= 80) {
          const form = line.match(FORM)?.[1]?.toLowerCase() ?? "";
          add("medication", {
            name, ...(strength ? { strength: strength.replace(/\s+/g, " ") } : {}),
            ...(line.match(FREQ) ? { frequency: line.match(FREQ)![1].replace(/\s/g, "") } : {}),
            ...(line.match(DURATION) ? { duration: line.match(DURATION)![1] } : {}),
            ...(line.match(INSTR) ? { instructions: line.match(INSTR)![1] } : {}),
            ...(form ? { route: /drop|mouthwash|cream|lotion|oint|gel/.test(form) ? "local" : /inj/.test(form) ? "injection" : "oral" } : {}),
          }, page, lineNo, line);
          return;
        }
      }
      if (!NOT_LAB.test(line)) {
        const lb = line.match(LAB);
        // a lab value needs a unit or a reference range, so "Age 34" or "Tooth 36" are not taken for results
        if (lb && (lb[3] || lb[4]) && !/^\d/.test(lb[1]) && clean(lb[1]).length >= 2) {
          const value = Number(lb[2]);
          let flag = lb[5] ? (/^h/i.test(lb[5]) ? "high" : "low") : "";
          if (!flag && lb[4]) {
            const [lo, hi] = lb[4].split(/[-–]/).map((x) => Number(x.trim()));
            flag = value < lo ? "low" : value > hi ? "high" : "normal";
          }
          add("lab", { test_name: clean(lb[1]), value: lb[2], ...(lb[3] ? { unit: lb[3] } : {}), ...(lb[4] ? { reference_range: lb[4].replace(/\s/g, "") } : {}), ...(flag ? { flag } : {}) }, page, lineNo, line);
        }
      }
    });
  }
  return { items, documentDate };
}
