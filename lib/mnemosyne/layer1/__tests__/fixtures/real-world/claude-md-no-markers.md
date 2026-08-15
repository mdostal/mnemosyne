# Kestrel Billing Service

This is the internal CLAUDE.md for the `kestrel-billing` repo. It predates
Mnemosyne entirely — nobody has run a persona sync against this file yet, so
there are no Mnemosyne-managed markers anywhere below. Treat every word of
this file as human-authored and precious.

## What this service does

Kestrel is the billing/invoicing microservice for the Fenwick platform. It
owns:

- Subscription state machine (trial -> active -> past_due -> canceled)
- Stripe webhook ingestion (`/webhooks/stripe`)
- Monthly invoice generation (cron, `scripts/generate-invoices.rb`)

## Local setup

1. `bundle install`
2. `bin/rails db:setup`
3. Copy `.env.example` to `.env` and ask in #kestrel-eng for the Stripe test
   keys — do NOT commit real keys, even test-mode ones.
4. `bin/rails server`

## Conventions

- We use RSpec, not Minitest. Every PR needs a spec.
- Money is always represented in cents (`Integer`), never `Float`, never
  `BigDecimal` unless you have a very good reason and a comment explaining
  it.
- Webhook handlers must be idempotent — Stripe retries on any non-2xx.

## Known gotchas

- The `invoices` table is huge (40M+ rows) in production. Any migration that
  touches it needs a `strong_migrations`-safe form, or it needs to go
  through the DBA review channel first.
- Sandbox Stripe webhooks arrive out of order more often than you'd think.
  Don't assume `created_at` ordering on the webhook payload matches actual
  event ordering — use Stripe's own event `id` sequence instead.

## Who to ask

- Billing domain questions: #kestrel-eng
- Stripe webhook weirdness: ask Priya first, she wrote the retry logic
- On-call: see the PagerDuty schedule, not this file (this file goes stale,
  PagerDuty doesn't)
