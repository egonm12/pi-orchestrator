// Ticket 23: the classifier's answer schema, versioned (stories 15 and 20).
//
// Change TIER_ANSWER_SCHEMA and `checkTierAnswer` only together with
// SCHEMA_VERSION. The JSON schema is what the model is shown; `checkTierAnswer`
// is what the harness enforces. They describe the same shape.

import { RISK_TIERS, type RiskTier } from "./classifier.ts";

export const SCHEMA_VERSION = "tier-answer-1";

export const RISK_LEVELS = ["none", "some", "high"] as const;
export const AMBIGUITY_LEVELS = ["clear", "partial", "vague"] as const;
export const COMPLEXITY_LEVELS = ["low", "medium", "high"] as const;
export const KINDS_OF_WORK = [
  "implement",
  "fix-after-review",
  "review",
  "security-review",
  "mechanical-edit",
  "research",
] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];
export type AmbiguityLevel = (typeof AMBIGUITY_LEVELS)[number];
export type ComplexityLevel = (typeof COMPLEXITY_LEVELS)[number];
export type KindOfWork = (typeof KINDS_OF_WORK)[number];

export interface TierAnswer {
  readonly tier: RiskTier;
  readonly risk: { readonly level: RiskLevel; readonly reasons: readonly string[] };
  readonly ambiguity: AmbiguityLevel;
  readonly complexity: ComplexityLevel;
  readonly kindOfWork: KindOfWork;
  readonly why: string;
}

export const TIER_ANSWER_SCHEMA = {
  $id: SCHEMA_VERSION,
  type: "object",
  additionalProperties: false,
  required: ["tier", "risk", "ambiguity", "complexity", "kindOfWork", "why"],
  properties: {
    tier: { enum: [...RISK_TIERS] },
    risk: {
      type: "object",
      additionalProperties: false,
      required: ["level", "reasons"],
      properties: {
        level: { enum: [...RISK_LEVELS] },
        reasons: { type: "array", items: { type: "string" } },
      },
    },
    ambiguity: { enum: [...AMBIGUITY_LEVELS] },
    complexity: { enum: [...COMPLEXITY_LEVELS] },
    kindOfWork: { enum: [...KINDS_OF_WORK] },
    why: { type: "string", minLength: 1 },
  },
} as const;

export type TierAnswerCheck =
  | { readonly ok: true; readonly answer: TierAnswer }
  | { readonly ok: false; readonly outcome: "schema-invalid" | "unknown-tier"; readonly detail: string };

const ANSWER_KEYS = ["tier", "risk", "ambiguity", "complexity", "kindOfWork", "why"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** One surrounding ```json fence is tolerated; the content is still checked in full. */
function unfenced(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fence ? fence[1]!.trim() : trimmed;
}

function invalid(detail: string): TierAnswerCheck {
  return { ok: false, outcome: "schema-invalid", detail };
}

/** Parse and validate a model's answer text against TIER_ANSWER_SCHEMA. */
export function checkTierAnswer(text: string): TierAnswerCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced(text));
  } catch {
    return invalid(`answer is not JSON: ${JSON.stringify(text.slice(0, 120))}`);
  }
  if (!isPlainObject(parsed)) return invalid("answer is not a JSON object");
  const extra = Object.keys(parsed).filter((key) => !(ANSWER_KEYS as readonly string[]).includes(key));
  if (extra.length > 0) return invalid(`answer has keys outside the schema: ${extra.join(", ")}`);
  const missing = ANSWER_KEYS.filter((key) => !Object.hasOwn(parsed, key));
  if (missing.length > 0) return invalid(`answer is missing ${missing.join(", ")}`);

  const { tier, risk, ambiguity, complexity, kindOfWork, why } = parsed;
  if (typeof tier !== "string") return invalid("tier is not a string");
  if (!isOneOf(RISK_TIERS, tier)) {
    return { ok: false, outcome: "unknown-tier", detail: `tier ${JSON.stringify(tier)} is not one of ${RISK_TIERS.join(", ")}` };
  }
  if (!isPlainObject(risk)) return invalid("risk is not an object");
  const riskExtra = Object.keys(risk).filter((key) => key !== "level" && key !== "reasons");
  if (riskExtra.length > 0) return invalid(`risk has keys outside the schema: ${riskExtra.join(", ")}`);
  if (!isOneOf(RISK_LEVELS, risk.level)) return invalid(`risk.level ${JSON.stringify(risk.level)} is not one of ${RISK_LEVELS.join(", ")}`);
  if (!Array.isArray(risk.reasons) || !risk.reasons.every((reason) => typeof reason === "string")) {
    return invalid("risk.reasons is not an array of strings");
  }
  if (!isOneOf(AMBIGUITY_LEVELS, ambiguity)) return invalid(`ambiguity ${JSON.stringify(ambiguity)} is not one of ${AMBIGUITY_LEVELS.join(", ")}`);
  if (!isOneOf(COMPLEXITY_LEVELS, complexity)) return invalid(`complexity ${JSON.stringify(complexity)} is not one of ${COMPLEXITY_LEVELS.join(", ")}`);
  if (!isOneOf(KINDS_OF_WORK, kindOfWork)) return invalid(`kindOfWork ${JSON.stringify(kindOfWork)} is not one of ${KINDS_OF_WORK.join(", ")}`);
  if (typeof why !== "string" || why.trim().length === 0) return invalid("why is not a non-empty string");

  return {
    ok: true,
    answer: {
      tier,
      risk: { level: risk.level, reasons: [...risk.reasons] as string[] },
      ambiguity,
      complexity,
      kindOfWork,
      why,
    },
  };
}
