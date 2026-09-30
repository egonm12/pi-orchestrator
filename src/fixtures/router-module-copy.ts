// What the router extension's module copy gives a test: the publishing seam
// and the task-allowance owner, from one module tree. A test loads this file
// with jiti (moduleCache: false), as pi loads each extension, so the owner it
// mints and the router it publishes belong to a copy of the router modules
// other than the test's own (../subagents/retry-module-copy.test.ts).

export { publishOrchestratorRouter } from "../router/orchestrator-router.ts";
export { newTaskLedger, TaskAllowanceOwner } from "../budget/task-allowance.ts";
