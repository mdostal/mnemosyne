// Reusable memory pre-hook injection primitive.
//
// This intentionally does not wire into live dispatch. Runners can call
// inject(ticket, repoScope) before a ticket run, then append the returned block
// after their stable system prefix.

import { recall as engineRecall } from "./engine.mjs";
import { buildMemoryBundle, estimateTokens } from "../hooks/lib/format.mjs";

export const DEFAULT_INJECT_HITS = 5;
export const DEFAULT_INJECT_TOKEN_BUDGET = 1500;
export const DEFAULT_INJECT_ROLE = "developer";

export function ticketTopic(ticket) {
  if (typeof ticket === "string") return ticket.trim();
  if (!ticket || typeof ticket !== "object") return "";

  return [
    ticket.identifier || ticket.key || ticket.id,
    ticket.title,
    ticket.topic,
    ticket.description,
  ]
    .filter((part) => part != null && String(part).trim())
    .map((part) => String(part).trim())
    .join("\n\n");
}

function assertInjectInput(query, repoScope) {
  if (!query) {
    const err = new Error("ticket topic is required");
    err.status = 400;
    throw err;
  }
  if (!repoScope || !String(repoScope).trim()) {
    const err = new Error("repoScope is required");
    err.status = 400;
    throw err;
  }
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function buildCappedBundle(recallResult, meta, maxTokens) {
  let max = positiveNumber(meta.max, DEFAULT_INJECT_HITS);
  let bundle = null;

  while (max >= 0) {
    bundle = buildMemoryBundle(recallResult, { ...meta, max });
    if (estimateTokens(bundle.text) <= maxTokens || max === 0) return bundle;
    max -= 1;
  }

  return bundle;
}

export async function inject(ticket, repoScope, options = {}) {
  const query = ticketTopic(ticket);
  const scope = String(repoScope || "").trim();
  assertInjectInput(query, scope);

  const recallFn = options.recall || engineRecall;
  const maxTokens = Math.min(
    positiveNumber(options.tokenBudget ?? options.maxTokens, DEFAULT_INJECT_TOKEN_BUDGET),
    DEFAULT_INJECT_TOKEN_BUDGET
  );
  const hits = positiveNumber(options.hits, DEFAULT_INJECT_HITS);
  const result = await recallFn(query, scope, { hits });

  const bundle = buildCappedBundle(
    result,
    {
      scope,
      sharedScope: options.sharedScope ?? "-",
      role: options.role || DEFAULT_INJECT_ROLE,
      url: options.url,
      max: hits,
      tokenBudget: maxTokens,
      ticket:
        (ticket && typeof ticket === "object" && (ticket.identifier || ticket.key || ticket.id)) ||
        "-",
    },
    maxTokens
  );

  return bundle.text;
}
