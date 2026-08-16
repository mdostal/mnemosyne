# Agents Guide — Fenwick Platform  
   
This file tells Codex-style agents how this repo is organized. It has
inconsistent formatting because three different people have edited it over
two years and nobody ever normalized it. That's realistic and deliberate —
do not "fix" the formatting as part of any automated pass.

### Repository layout (heading level jumps straight from H1 to H3)

- `services/` — one directory per microservice   
- `libs/shared/` — cross-service Ruby gems  
- `infra/` — Terraform, one workspace per environment

Some lines above have trailing spaces on purpose — this file has never been
run through a formatter/linter that strips them.

---

That horizontal rule above is NOT a Mnemosyne marker. It's just an
old-fashioned Markdown section break someone added by hand back when this
file was still organized as a single long FAQ. Leave it alone.

##### Deploy checklist (H5, way deeper than anything above)

1. Merge to `dev`.   
2. Wait for CI.
3. Tag a release candidate.
4. Promote via the `infra/promote.sh` script — never `kubectl apply` by hand.

## Testing (back up to H2 after that H5 — also on purpose)

Run `make test` from the repo root. It fans out to each service's own test
runner.

#### A deeply nested aside (H4)

If a service's tests are flaky, check `infra/flaky-tests.md` before
disabling anything — there's usually a known root cause already logged
there.
