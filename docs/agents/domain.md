# Domain docs

Single-context layout: one root `CONTEXT.md` plus root `docs/adr/`.

## Before exploring

- Read root `CONTEXT.md` when it exists.
- Read `docs/adr/` entries that touch the area you are about to work in.
- Upstream's own vocabulary lives in `docs/internals/glossary.md` and its decisions in `docs/internals/`. `CONTEXT.md` extends that glossary for fork-specific terms (NeoPi provider, RPC mode); it must not redefine upstream terms.

If any of these files don't exist, proceed silently. `/domain-modeling` (via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Use the glossary's vocabulary

When output names a domain concept (issue title, proposal, hypothesis, test name), use the term as defined in `CONTEXT.md` or the upstream glossary. A missing term is a signal: either you are inventing language the project doesn't use, or there is a real gap to note for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (one NeoPi process per thread), but worth reopening because…_
