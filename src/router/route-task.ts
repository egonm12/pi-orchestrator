import { allowanceConstraint, type TaskAllowanceOwner } from "../budget/task-allowance.ts";
import type { ModelInfo } from "../models/model-info.ts";
import type { BanLists } from "../policy/ban-lists.ts";
import { classifyTier, type ClassifierModelCall, type LoadedClassifierChain } from "../routing/tier-classifier.ts";
import type { ResolvedTierMap } from "../routing/tier-map.ts";
import { failedHardFilter, routeForcedRung, routeTier, type ConstraintRung, type RouterEvidence, type RoutingConstraints } from "../routing/tier-router.ts";
import { isAtLeastTier } from "../routing/classifier.ts";
import { deriveProviderUsage, type RoutingEvidenceSource } from "./evidence.ts";
import type { RoutingMode } from "../routing/decision-record.ts";

export interface ActiveRouter {
  readonly mode: RoutingMode;
  readonly tierMap: ResolvedTierMap;
  readonly banLists: BanLists;
  readonly chain: LoadedClassifierChain;
  readonly callModel: ClassifierModelCall;
  readonly evidence: RoutingEvidenceSource;
  readonly owner: TaskAllowanceOwner;
  readonly recordDir: string;
  readonly installedModels: readonly ModelInfo[];
}

const WRAPPING = /^[\s"'`([{<]+|[\s"'`)\]}>.,;:!?]+$/g;
const FILE_NAME = /^[\w.-]*[\w-]{2}\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** Split on whitespace, strip surrounding punctuation, drop URLs, then keep
 * paths containing `/` or file names with a two-character stem and extension.
 * Preserve first mention order and include each path only once. */
function namedPaths(taskText: string): string[] {
  const paths: string[] = [];
  for (const word of taskText.split(/\s+/)) {
    const candidate = word.replace(WRAPPING, "");
    if (candidate.length === 0 || candidate.includes("://")) continue;
    if ((candidate.includes("/") || FILE_NAME.test(candidate)) && !paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

function hardFilterEvidence(router: ActiveRouter, taskText: string, at: Date, evidence: ReturnType<RoutingEvidenceSource>,
  constraints: RoutingConstraints): RouterEvidence {
  const estimatedPromptTokens = Buffer.byteLength(taskText, "utf8");
  return {
    providerUsage: deriveProviderUsage(evidence, at), catalog: evidence.catalog, estimatedPromptTokens,
    allowance: allowanceConstraint(router.owner, evidence.catalog, { role: "subtask", maxInputTokens: estimatedPromptTokens }),
    authorization: evidence.authorization, banLists: router.banLists,
    ...(constraints.excludedRung === undefined ? {} : { excludedRung: constraints.excludedRung }),
  };
}

export function recordedRungPassesHardFilters(router: ActiveRouter, rung: ConstraintRung, taskText: string, at: Date,
  constraints: RoutingConstraints = {}): boolean {
  return failedHardFilter(rung, hardFilterEvidence(router, taskText, at, router.evidence(), constraints)) === undefined;
}

/** Classify, then route under the worker's routing constraints: a minimum
 *  tier raises the tier routing starts at, an excluded rung is removed in
 *  every tier, and a forced rung replaces the tier choice. */
export async function routeTask(router: ActiveRouter, taskText: string, agentRole: string, at: Date, constraints: RoutingConstraints = {}) {
  const evidence = router.evidence();
  const classification = await classifyTier(
    { task: taskText, role: agentRole, paths: namedPaths(taskText) },
    { chain: router.chain, callModel: router.callModel, allowance: { owner: router.owner, catalog: evidence.catalog } },
  );
  const filters = hardFilterEvidence(router, taskText, at, evidence, constraints);
  const { minimumTier, forcedRung } = constraints;
  const tier = minimumTier === undefined || isAtLeastTier(classification.tier, minimumTier) ? classification.tier : minimumTier;
  const route = forcedRung === undefined ? routeTier({ tier, tierMap: router.tierMap, evidence: filters }) : routeForcedRung(forcedRung, filters);
  return { classification, route };
}
