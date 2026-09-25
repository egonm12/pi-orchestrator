// Ticket 06: the risk and ambiguity classifier.
//
// The ticket is explicit that this is the part that is ours to build: existing
// implementations threshold confidence about data sensitivity (a bounded
// problem) or about predicted answer quality. This one thresholds confidence
// about TASK RISK AND AMBIGUITY -- is this change security-sensitive, are the
// requirements clear -- which has no off-the-shelf classifier.
//
// Two deliberate properties:
//
//   1. It is a pure function of the task text. No network call, no model call,
//      no benchmark. Ticket 05 requires routing to consult the local catalog
//      only, and a classification that phoned a model would break that as well
//      as making every routing decision non-reproducible.
//   2. Its confidence is confidence IN THE CLASSIFICATION -- "how sure am I
//      that this is the risk tier" -- and is computed here, from signal
//      evidence in the text. It is never a number an assessed model reported
//      about its own answer. The ticket forbids that input, and routing-policy.ts
//      is structurally unable to consume one.
//
// HONESTY NOTE, carried in the source rather than only in a report: this is a
// first-pass keyword-and-density heuristic. Its precision and recall have NOT
// been measured against a labelled corpus, because no such corpus exists here.
// It is deterministic, inspectable and reproducible, which makes it testable
// and safe to replace -- it feeds stage 1, it is not stage 1 -- but it should
// not be described as a validated classifier. Known imprecision: it reads
// words, not meaning, so "token" in a throughput sentence reads as an auth
// signal, and a security-sensitive task described without any of these words
// reads as `standard`. The conservative-escalation rule in routing-policy.ts
// is what limits the damage from both directions, which is precisely why the
// ticket asks for the escalation machinery to be borrowed rather than trusted
// to the classifier.

export type RiskTier = "mechanical" | "standard" | "elevated" | "critical";

/** Ascending. Index is the rank, so a higher index is a more demanding tier. */
export const RISK_TIERS: readonly RiskTier[] = [
  "mechanical",
  "standard",
  "elevated",
  "critical",
] as const;

export function tierRank(tier: RiskTier): number {
  return RISK_TIERS.indexOf(tier);
}

export function isAtLeastTier(tier: RiskTier, floor: RiskTier): boolean {
  return tierRank(tier) >= tierRank(floor);
}

export type SignalKind =
  | "security-sensitive"
  | "destructive"
  | "public-behavior"
  | "mechanical"
  | "ambiguity";

export interface ClassificationSignal {
  readonly kind: SignalKind;
  /** The named pattern that matched, so a decision can be explained. */
  readonly label: string;
  /** What in the text matched it. */
  readonly matched: string;
}

interface PatternDef {
  readonly kind: SignalKind;
  readonly label: string;
  readonly regex: RegExp;
}

// Patterns are exported so the classifier's inputs are inspectable and a
// reviewer can argue with a specific word rather than with a black box.
export const CLASSIFIER_PATTERNS: readonly PatternDef[] = [
  { kind: "security-sensitive", label: "auth", regex: /\bauth(n|z|entication|orisation|orization|orize)?\b/ },
  { kind: "security-sensitive", label: "login", regex: /\b(log ?in|logout|sign-?in|sign-?on)\b/ },
  { kind: "security-sensitive", label: "credential", regex: /\b(credential|password|passphrase|secret|api key|access key)\b/ },
  { kind: "security-sensitive", label: "token", regex: /\b(token|jwt|oauth|session cookie)\b/ },
  { kind: "security-sensitive", label: "crypto", regex: /\b(crypto|encrypt|decrypt|cipher|hash(ing)?|signature|signing)\b/ },
  { kind: "security-sensitive", label: "access-control", regex: /\b(permission|privilege|acl|rbac|access control|authoris\w*|escalat\w*)\b/ },
  { kind: "security-sensitive", label: "injection", regex: /\b(inject\w*|xss|csrf|ssrf|sql\b|sanitis\w*|sanitiz\w*|escap\w* (input|output))\b/ },
  { kind: "security-sensitive", label: "bypass", regex: /\b(bypass|circumvent|vulnerab\w*|exploit|cve-\d|sandbox escape)\b/ },
  { kind: "security-sensitive", label: "transport-security", regex: /\b(tls|ssl|certificate|mtls)\b/ },
  { kind: "security-sensitive", label: "regulated-data", regex: /\b(pii|personal data|gdpr|hipaa|payment|billing|card number)\b/ },

  { kind: "destructive", label: "data-loss", regex: /\b(delete|drop table|truncate|wipe|purge|destroy|rm -rf)\b/ },
  { kind: "destructive", label: "irreversible-vcs", regex: /\b(force[- ]push|reset --hard|rewrite history)\b/ },
  { kind: "destructive", label: "migration", regex: /\b(migration|migrate)\b/ },

  { kind: "public-behavior", label: "public-api", regex: /\b(public api|public interface|breaking change|backwards[- ]incompat\w*)\b/ },
  { kind: "public-behavior", label: "release", regex: /\b(publish|published|release|deploy\w*)\b/ },
  { kind: "public-behavior", label: "contract", regex: /\b(schema change|contract change|api contract|wire format)\b/ },

  { kind: "mechanical", label: "formatting", regex: /\b(re-?format|formatting|whitespace|indent\w*|lint|prettier|trailing comma)\b/ },
  { kind: "mechanical", label: "ordering", regex: /\b(alphabetis\w*|alphabetiz\w*|alphabetical\w*|sort|re-?order|import order)\b/ },
  { kind: "mechanical", label: "textual", regex: /\b(typo|spelling|rename|comment wording)\b/ },

  { kind: "ambiguity", label: "hedge", regex: /\b(maybe|somehow|not sure|unsure|probably|roughly|ideally|whatever|or something)\b/ },
  { kind: "ambiguity", label: "open-ended", regex: /\b(etc|and so on|figure out|as needed|as appropriate|tbd|to be decided)\b/ },
  { kind: "ambiguity", label: "unbounded-quality", regex: /\b(better|improve|clean ?up|tidy|refactor|nicer|appropriately|properly)\b/ },
] as const;

export interface RiskAssessment {
  readonly riskTier: RiskTier;
  readonly ambiguity: "clear" | "underspecified";
  /**
   * 0..1 confidence in THIS ASSESSMENT, computed from the signal evidence
   * below. Not a quality prediction, and not a number reported by any model
   * about its own output.
   */
  readonly confidence: number;
  readonly signals: readonly ClassificationSignal[];
  readonly rationale: string;
  /** Present so a reviewer can see the arithmetic, not just its result. */
  readonly signalCounts: Readonly<Record<SignalKind, number>>;
  /** Stated on every assessment so no consumer can treat this as validated. */
  readonly classifierBasis: "first-pass-heuristic-unvalidated";
}

const EMPTY_COUNTS: Readonly<Record<SignalKind, number>> = {
  "security-sensitive": 0,
  destructive: 0,
  "public-behavior": 0,
  mechanical: 0,
  ambiguity: 0,
};

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Rounded so that two identical descriptions produce byte-identical records
 *  and tests compare exact values rather than float noise. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function classifyTask(taskDescription: string): RiskAssessment {
  const text = taskDescription.toLowerCase();
  const wordCount = taskDescription.trim().split(/\s+/).filter(Boolean).length;

  const signals: ClassificationSignal[] = [];
  const counts: Record<SignalKind, number> = { ...EMPTY_COUNTS };

  for (const def of CLASSIFIER_PATTERNS) {
    const match = def.regex.exec(text);
    if (!match) continue;
    signals.push({ kind: def.kind, label: def.label, matched: match[0] });
    counts[def.kind] += 1;
  }

  const risky = counts["security-sensitive"] + counts.destructive;
  const elevating = risky + counts["public-behavior"];
  const total = elevating + counts.mechanical + counts.ambiguity;

  // Tier. Risk signals dominate mechanical ones on purpose: the ticket's
  // central example is a security-sensitive one-liner, which is small and
  // mechanical-looking and must still not be treated as mechanical work.
  let riskTier: RiskTier;
  if (risky >= 2) riskTier = "critical";
  else if (risky === 1) riskTier = "elevated";
  else if (counts["public-behavior"] >= 1) riskTier = "elevated";
  else if (counts.mechanical >= 1) riskTier = "mechanical";
  else riskTier = "standard";

  // Confidence. Starts from a weak prior and moves only on evidence present in
  // the text: agreeing signals raise it, hedging language lowers it, signals
  // that disagree with each other lower it, and a short description with no
  // signals at all lowers it hard -- "short and featureless" is the case where
  // this classifier genuinely does not know what it is looking at.
  let confidence = 0.55;
  confidence += Math.min(0.3, 0.1 * elevating);
  confidence += Math.min(0.2, 0.1 * counts.mechanical);
  confidence -= Math.min(0.45, 0.15 * counts.ambiguity);
  if (elevating > 0 && counts.mechanical > 0) confidence -= 0.2;
  if (total === 0 && wordCount < 8) confidence -= 0.3;
  confidence = round4(clamp01(confidence));

  const ambiguity: "clear" | "underspecified" =
    counts.ambiguity >= 1 || (total === 0 && wordCount < 8) ? "underspecified" : "clear";

  const described =
    signals.length === 0
      ? "no risk, mechanical or ambiguity signals matched"
      : signals.map((s) => `${s.kind}:${s.label}(${s.matched})`).join(", ");

  return {
    riskTier,
    ambiguity,
    confidence,
    signals,
    signalCounts: counts,
    rationale: `${wordCount} words; ${described}`,
    classifierBasis: "first-pass-heuristic-unvalidated",
  };
}
