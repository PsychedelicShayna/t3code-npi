# Issue tracker: GitHub

Issues and specs for this fork live in GitHub Issues at `PsychedelicShayna/t3code-npi` (fork of `pingdotgg/t3code`). `origin` is the fork, `upstream` is pingdotgg; `gh repo set-default` points at the fork. Always pass `-R PsychedelicShayna/t3code-npi` when in doubt. Never file issues, comments, or PRs on `pingdotgg/t3code`.

## Conventions

- Create: `gh issue create -R PsychedelicShayna/t3code-npi --title "..." --body-file <path> --label ...`.
- Read: `gh issue view <number> --comments`, including labels.
- List: `gh issue list --state <state> --json number,title,body,labels,comments` with the filters the task requires.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close only when the Captain or the invoked workflow authorizes it.
- Upstream `AGENTS.md` still applies: implementation plans and scratch notes stay out of the worktree; the issue owns the checklist, the merged PR is the record.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill meanings

- "Publish to the issue tracker" means create a GitHub issue on the fork.
- "Fetch the relevant ticket" means read the GitHub issue, its comments, and labels.

## Dual taxonomy

Blended from the NeoPi fork (`PsychedelicShayna/neopi`, `docs/agents/issue-funnel.md`). Two orthogonal label layers; an issue carries both and neither replaces the other.

**House:**

- Type: `bug` or `enhancement` (other GitHub defaults only when they truly fit).
- Exactly one `effort: tiny|small|medium|large|very large`.
- Exactly one `priority: p0|p1|p2|p3`.
- `entangled` only for a true alternative cluster (shipping one supersedes the siblings), and only when the Captain ordered it.

**Matt triage (readiness):** `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

Do not invent labels; every label above already exists on the fork.

## Issue shape

House voice: concrete contract, explicit boundaries, checkable acceptance. Sentence-case headings. Drop sections that add nothing:

- Summary
- Observed behavior / current mechanism (paths, symbols, line numbers actually read)
- Gap
- Desired behavior
- Boundaries
- Tests (only when they defend an observable contract)
- Acceptance (`- [ ]` musts)

Dedupe before filing: amend an existing issue with a comment rather than opening a duplicate.
