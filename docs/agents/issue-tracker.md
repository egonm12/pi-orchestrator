# Issue tracker: beans

Issues ("beans") for this repo live in `.beans/` and are managed with the `beans` CLI (prefix `pi-orchestrator-`). Run `beans prime` for the full usage guide. Always pass `--json` when parsing output.

## When a skill says "publish to the issue tracker"

```bash
beans create --json "Title" -t <milestone|epic|feature|task|bug> -d "Body..." -s todo --tag <triage-label>
```

- Specs go in an `epic` or `feature` bean. Implementation tickets are child beans with `--parent <spec-id>`, one bean per ticket.
- Dependencies: `--blocked-by <id>`.
- Use `-s draft` for work that still needs refinement.

## When a skill says "fetch the relevant ticket"

`beans show --json <id>`. For a ticket with its relationships:

```bash
beans query --json '{ bean(id: "<id>") { title body status tags parent { id title } children { id title status } } }'
```

## Comments and triage state

- Comments: `beans update <id> --body-append "## Comments\n\n..."`
- Triage state is recorded as a tag (see `triage-labels.md`). Change it with `beans update <id> --remove-tag <old> --tag <new>`.
- `wontfix`: also set `-s scrapped` and append a `## Reasons for Scrapping` section.

## Wayfinding operations

Used by `/wayfinder`.

- **Map**: a parent `epic` bean whose body holds Notes, Decisions so far and Fog.
- **Child ticket**: a bean with `--parent <map-id>`, the question in its body, and a `type:<research|prototype|grilling|task>` tag.
- **Blocking**: `--blocked-by <id>`.
- **Frontier**: `beans list --json --ready --parent <map-id>`. Pick the oldest.
- **Claim**: `beans update <id> -s in-progress` before starting any work.
- **Resolve**: append an `## Answer` section, set `-s completed`, then append a short summary and link to the map bean's Decisions so far.
