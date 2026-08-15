# Northwind Holdings — Company Director working notes

This is the human-authored CLAUDE.md a company director-tier agent would find
at the top of Northwind Holdings' internal planning repo. Nobody has run a
Mnemosyne persona sync against this file yet, so there are no Mnemosyne-
managed markers anywhere below. Every word here is human-authored and
precious — this fixture exists to prove global-tier sync (top-orchestrator /
company-director / project-orchestrator) preserves it exactly the same way
code-architect sync already proves for repo-local content (pf-05).

## Portfolio

Northwind runs three product lines, each with its own project orchestrator:  

- **Kestrel** — billing/invoicing platform (see the `kestrel-billing` repo)
- **Fenwick** — the shared internal platform Kestrel and the others sit on
- **Harrow** — early-stage, pre-revenue, still finding product/market fit

## Business context

- Fiscal year runs Feb–Jan, not Jan–Dec. Quarterly planning docs use fiscal
  quarters, not calendar ones — a recurring source of confusion for new
  directors, worth restating here every time.
- Board updates go out the first Monday of each fiscal quarter. Draft with
  Finance, never send a first draft straight to the board.

---

That horizontal rule above is a human-authored section break, not a
Mnemosyne marker.

## Escalation

- Cross-company questions (anything touching a company other than Northwind)
  escalate to the top orchestrator — do not try to resolve those here.
- Cross-project questions within Northwind (e.g. "should Harrow reuse
  Fenwick's auth service") are this tier's own call, not delegated down to a
  single project orchestrator to decide unilaterally.

## Who to ask

- Board/investor questions: ask Directors' Ops first, not Legal
- Fiscal calendar weirdness: Finance owns the source of truth, this file goes
  stale
