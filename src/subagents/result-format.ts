// The reporting rules and the Result format every non-fork worker gets
// (ADR 0010), and the runtime's check of a finished worker's Result. The
// check reads section headers only, without a model call, and never rejects:
// a missing section adds a note to that worker's part of the tool result.
// A forked worker runs as the orchestrator itself (ADR 0008) and gets neither.

/** The Result's sections, in the order a worker writes them. */
export const RESULT_SECTIONS = ["Confirmed", "Changed", "Unverified", "Could not check", "Verified by"] as const;

export type ResultSection = typeof RESULT_SECTIONS[number];

/** Appended to every non-fork worker's system prompt, before any agent definition's instructions. */
export const REPORTING_RULES = `# Reporting rules

You are a worker. Your final reply is your Result: the orchestrator checks it as evidence before it acts on it, so it must hold up to a check.

- Verify before you report. Run the check or read the file; do not report what you only expect.
- Give file:line for every factual claim about code or files.
- Label every claim you did not verify as unverified.
- Say what you could not check, and why.
- Do only what the task asks. Name anything else you noticed instead of doing it.

End your final reply with your Result in these five sections, each under its own heading, in this order:

## Confirmed
What you verified, each claim with its file:line evidence.

## Changed
Each file you changed, with one sentence per change.

## Unverified
What you suspect but did not verify.

## Could not check
What you could not check, and why.

## Verified by
The exact commands you ran and their outcome.

Keep every heading, even for an empty section: write "None." under it.`;

/** A line's text once its heading, list and emphasis marks are gone, and whether it had a heading or bold mark. */
function headerText(line: string): { text: string; marked: boolean } {
  const heading = /^\s*#{1,6}\s*/.exec(line);
  let rest = heading ? line.slice(heading[0].length) : line.trimStart();
  rest = rest.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
  const marked = heading !== null || /^(?:\*\*|__)/.test(rest);
  return { text: rest.replace(/[*_]/g, "").trim(), marked };
}

/** Whether `line` heads `section`: a markdown heading or a bold label starting
 *  with its name, or a plain line of the name alone or followed by a colon. */
function headsSection(line: string, section: ResultSection): boolean {
  const { text, marked } = headerText(line);
  const lower = text.toLowerCase(), name = section.toLowerCase();
  if (!lower.startsWith(name)) return false;
  const after = lower.slice(name.length);
  if (/^\w/.test(after)) return false;
  return marked || /^\s*(?::|$)/.test(after);
}

/** The Result sections `text` has no header for, in section order. */
export function missingResultSections(text: string): ResultSection[] {
  const lines = text.split(/\r?\n/);
  return RESULT_SECTIONS.filter((section) => !lines.some((line) => headsSection(line, section)));
}

/** The note a Result with missing sections gets in the subagents tool result. */
export function missingSectionsNote(missing: readonly ResultSection[]): string {
  return `[Result check: this Result has no ${missing.join(", ")} section${missing.length === 1 ? "" : "s"}. ` +
    "Weigh its claims accordingly before you act on it.]";
}
