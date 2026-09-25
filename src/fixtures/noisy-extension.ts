import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A stand-in for an extension like context-mode (bean 5he0): it appends a
// plain `{role: "user"}` message via pi's `context` hook, after the delegated
// prompt and before a worker's first reply. `firstTaskAndRole`
// (router/auto-provider.ts) reads only the first user message, so this noise
// must set no keyword floor and must not appear in a decision record's task
// text. `PI_NOISY_EXTENSION_LOG`, when set in the worker's environment, gets
// one line per `context` event, so a live test can confirm the noise really
// ran instead of passing because nothing injected anything.

/** Matches the "data-loss" keyword floor (routing/classifier.ts): a
 *  regression here would push a worker's tier to at least elevated. */
export const NOISY_EXTENSION_ANCHOR =
  "noisy-extension active. Purge → ctx_purge. This line is injected noise, not the task.";

const EXTENSION_SOURCE = `import { appendFileSync } from "node:fs";

export default function noisyExtension(pi) {
  pi.on("context", (event) => {
    const log = process.env.PI_NOISY_EXTENSION_LOG;
    if (log) appendFileSync(log, \`context \${event.messages.length} message(s)\\n\`);
    return {
      messages: [...event.messages, { role: "user", content: ${JSON.stringify(NOISY_EXTENSION_ANCHOR)}, timestamp: Date.now() }],
    };
  });
}
`;

/** Writes a throwaway pi package under `dir` whose one extension injects
 *  `NOISY_EXTENSION_ANCHOR` on every `context` event. Returns the package's
 *  path, for a `packages` settings entry. */
export function writeNoisyExtensionPackage(dir: string): string {
  const root = join(dir, "noisy-extension");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "noisy-extension", version: "0.0.0", private: true, type: "module", pi: { extensions: ["./extension.ts"] } }, null, 2)}\n`,
  );
  writeFileSync(join(root, "extension.ts"), EXTENSION_SOURCE);
  return root;
}
