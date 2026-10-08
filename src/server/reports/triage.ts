// Report triage (H-206): a deterministic keyword fallback assigns the
// initial `category` and `urgency` to every new report. The AI
// implementation (the same LLM adapter family as the policy verdict)
// arrives with H-208 and plugs into the ReportTriage interface — the
// fallback stays as the no-network default and the deterministic floor.

export type TriageInput = {
  reason: string;
  targetType: string;
};

export type TriageVerdict = {
  /** Fixed category vocabulary (policy-aligned). */
  category: string;
  /** 0 (noise) .. 3 (drop everything). */
  urgency: number;
};

export interface ReportTriage {
  triage(input: TriageInput): Promise<TriageVerdict>;
}

/**
 * Deterministic keyword rules, highest priority first. Keywords are
 * content (AGENTS §9): they match what reporters actually write, in the
 * languages the platform serves at beta.
 */
const RULES: ReadonlyArray<{ category: string; urgency: number; keywords: string[] }> = [
  { category: "CSAM", urgency: 3, keywords: ["child sexual", "csam", "sexual content involving a minor", "minor sexualized", "ребён", "несовершеннолетн"] },
  { category: "THREATS", urgency: 3, keywords: ["threat", "kill", "incitement", "угроз", "убийст", "призыв к насил"] },
  { category: "HARASSMENT", urgency: 2, keywords: ["harass", "hate", "slur", "травл", "ненавист", "оскорбл"] },
  { category: "DOXXING", urgency: 2, keywords: ["doxx", "personal data", "home address", "адрес", "личные данные"] },
  { category: "IMPERSONATION", urgency: 2, keywords: ["impersonat", "pretending to be", "притворя", "выдаёт себя"] },
  { category: "FRAUD", urgency: 2, keywords: ["scam", "fraud", "phishing", "мошенн", "фишинг"] },
  { category: "ILLEGAL_TRADE", urgency: 2, keywords: ["drugs", "weapons", "наркот", "оружи"] },
  { category: "COPYRIGHT", urgency: 1, keywords: ["copyright", "not mine", "stolen", "авторск", "украл"] },
  { category: "SPAM", urgency: 1, keywords: ["spam", "link farm", "спам", "реклама"] },
];

export class KeywordTriage implements ReportTriage {
  async triage(input: TriageInput): Promise<TriageVerdict> {
    const haystack = input.reason.toLowerCase();
    for (const rule of RULES) {
      if (rule.keywords.some((k) => haystack.includes(k))) {
        return { category: rule.category, urgency: rule.urgency };
      }
    }
    return { category: "OTHER", urgency: 1 };
  }
}

/** The active triage hook; H-208 replaces the implementation, not the seam. */
export function currentTriage(): ReportTriage {
  return new KeywordTriage();
}
