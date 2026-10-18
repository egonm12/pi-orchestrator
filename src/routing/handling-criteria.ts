// When the orchestrator handles a prompt itself and when it hands it to
// workers (ADR 0020, amended by ADR 0021). Shared by the handling judge's own
// prompt (handling-judge.ts) and the effort judge's combined question
// (effort-rubric.ts), so both calls judge by the same text.

/** When to answer self and when delegate. */
export const HANDLING_CRITERIA = [
  "Self is the default: the orchestrator works fast on its own, and a worker adds a minute or more of overhead before it starts.",
  "Answer self for questions, lookups, investigating one problem, edits and fixes in a few files, commits, and steps that must run one after another, even when they take several minutes.",
  "Answer delegate only when the prompt has independent parts that can run in parallel, or is large: broad research across many sources or files, or changes across many files.",
  "Running for minutes is not a reason to delegate: a worker takes as long.",
].join(" ");
