import { allowanceConstraint, type TaskAllowanceOwner } from "../budget/task-allowance.ts";
import type { ModelInfo } from "../models/model-info.ts";
import type { BanLists } from "../policy/ban-lists.ts";
import { classifyTier, type ClassifierModelCall, type LoadedClassifierChain } from "../routing/tier-classifier.ts";
import type { ResolvedTierMap, TierRung } from "../routing/tier-map.ts";
import { failedHardFilter, routeTier, type RouterEvidence } from "../routing/tier-router.ts";
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

function hardFilterEvidence(router: ActiveRouter, taskText: string, at: Date, evidence: ReturnType<RoutingEvidenceSource>): RouterEvidence {
  const estimatedPromptTokens = Buffer.byteLength(taskText, "utf8");
  return {
    providerUsage: deriveProviderUsage(evidence, at), catalog: evidence.catalog, estimatedPromptTokens,
    allowance: allowanceConstraint(router.owner, evidence.catalog, { role: "subtask", maxInputTokens: estimatedPromptTokens }),
    authorization: evidence.authorization, banLists: router.banLists,
  };
}

export function recordedRungPassesHardFilters(router: ActiveRouter, rung: Pick<TierRung, "model">, taskText: string, at: Date): boolean {
  return failedHardFilter(rung, hardFilterEvidence(router, taskText, at, router.evidence())) === undefined;
}

export async function routeTask(router: ActiveRouter, taskText: string, agentRole: string, at: Date) {
  const evidence = router.evidence();
  const classification = await classifyTier(
    { task: taskText, role: agentRole, paths: namedPaths(taskText) },
    { chain: router.chain, callModel: router.callModel, allowance: { owner: router.owner, catalog: evidence.catalog } },
  );
  const route = routeTier({ tier: classification.tier, tierMap: router.tierMap, evidence: hardFilterEvidence(router, taskText, at, evidence) });
  return { classification, route };
}
