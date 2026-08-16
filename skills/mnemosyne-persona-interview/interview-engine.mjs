// interview-engine.mjs — pure, dependency-light interview mechanics for the
// mnemosyne-persona-interview skill (pw-10).
//
// Grounded line-by-line in plugin-hive's kickoff-protocol.md "Phase 3b:
// Discovery Questions" (~/.claude/plugins/cache/plugin-hive/plugin-hive/*/hive/references/kickoff-protocol.md
// — the only real, working precedent for this shape anywhere this repo
// depends on):
//
//   - Adaptive question set (kickoff-protocol.md Phase 3b, "Adaptive question
//     set"): "Before asking, check what current-state discovery already
//     surfaced. Do NOT re-ask items already answered." CORE_QUESTIONS /
//     OPTIONAL_QUESTIONS below mirror kickoff's 4-core + 2-optional shape,
//     narrowed to persona authoring (design-discussion.md §3b): "what does
//     this tier/persona know," "what does it explicitly NOT hold," "does it
//     have a parent to query up to" as the 3 core questions, plus 2 optional
//     follow-ups reusing kickoff's own "success"/"avoid" optional-follow-up
//     shape verbatim.
//   - Persistence rule (kickoff-protocol.md Phase 3b, "Persistence rule"):
//     "Answered questions: write the operator's answer verbatim... Skipped/
//     deferred questions: write `unknown`... Optional follow-ups skipped:
//     omit the field rather than writing `unknown`." Mirrored exactly below:
//     skipped CORE answers get an explicit placeholder marker (SKIP_PLACEHOLDER)
//     in the resulting `sections` content — never silent omission; skipped
//     OPTIONAL answers are omitted entirely — no section, no marker.
//   - Non-blocking hard-fail rule (kickoff-protocol.md Phase 3b, "Hard-fail
//     rule"): "kickoff MUST continue normally after Phase 3b regardless of
//     how many questions were skipped." Mirrored below: runPersonaInterview()
//     ALWAYS returns a `persona` object shaped to satisfy
//     lib/mnemosyne/layer1/persona.ts's assertValidPersona, even when every
//     core question is skipped and no displayName/scope override is given —
//     see test/persona-interview-skill.test.ts's "max-skip" case, which
//     proves this against the REAL validator, not a superficial resemblance.
//
// This module intentionally has ZERO Persona-schema validation logic of its
// own, and zero import from lib/mnemosyne/layer1/persona.ts — it produces
// plain data. persona.ts's assertValidPersona remains the single real
// enforcement point (persona.ts's own doc comment); this engine's job is
// only to prove its output satisfies that gate (done in the test file, which
// imports both), never to reimplement it.

/** Explicit marker for a skipped CORE question — never silent omission (kickoff-protocol.md Phase 3b persistence rule). */
export const SKIP_PLACEHOLDER = '[not provided — skipped during interview]';

/** Explicit, non-placeholder text for a core question that was actually answered "no parent." */
export const NO_PARENT_TEXT = 'No parent tier to query up to (explicitly answered: none).';

/**
 * The 3 core, individually-skippable questions (design-discussion.md §3b;
 * pw-10-interview-skill-mechanics.yaml acceptance criteria), mirroring
 * kickoff-protocol.md's north_star core-question table shape (one row per
 * question, a field to write into, adaptive-skip governed by `contextKey`).
 */
export const CORE_QUESTIONS = [
  {
    id: 'knows',
    prompt:
      "What does this persona know? (its actual working knowledge for THIS scopeId — not the tier's canonical " +
      'responsibility statement, which TIER_CONTENT[tier] already answers; this is what THIS specific persona ' +
      'instance holds.)',
    sectionHeading: 'What this persona knows',
    contextKey: 'knows',
  },
  {
    id: 'not_hold',
    prompt: 'What does it explicitly NOT hold?',
    sectionHeading: 'What this persona does NOT hold',
    contextKey: 'notHold',
  },
  {
    id: 'parent',
    prompt: "Does it have a parent to query up to? (give a parent tier + scopeId, e.g. \"project-orchestrator/acme-web\", or say \"none\")",
    sectionHeading: 'Parent to query up to',
    contextKey: 'parent',
  },
];

/**
 * 2 optional follow-ups, reusing kickoff-protocol.md Phase 3b's own
 * "success"/"avoid" optional-follow-up shape (kickoff-protocol.md Phase 3b,
 * "After the 4 core questions, offer 2 optional follow-ups") — same
 * mechanics, persona-authoring wording.
 */
export const OPTIONAL_QUESTIONS = [
  {
    id: 'success',
    prompt: 'What does success look like for this persona? (optional)',
    sectionHeading: 'Success',
    contextKey: 'success',
  },
  {
    id: 'avoid',
    prompt: 'What should this persona avoid? (optional)',
    sectionHeading: 'Avoid',
    contextKey: 'avoid',
  },
];

/** Tiers whose store is global (persona.ts's PERSONA_STORE_BY_TIER global set) — must stay in
 * lockstep with that map. This is only an interview-time pre-check for parentRefs shape; the
 * REAL enforcement is persona.ts's assertValidPersona, which independently re-validates every
 * parentRefs entry's tier against PERSONA_STORE_BY_TIER — a drift here is caught there, not
 * silently accepted. */
const GLOBAL_TIERS = ['top-orchestrator', 'company-director', 'project-orchestrator'];

function normalizeSkipToken(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  const t = value.trim().toLowerCase();
  return t === '' || t === 'skip' || t === 'pass' || t === 'n/a' || t === 'na';
}

/**
 * Resolves one question's value against `context` first (kickoff's adaptive
 * skip: "check what current-state discovery already surfaced. Do NOT re-ask
 * items already answered"), then `responses` (an operator answer actually
 * given), then falls back to "skipped."
 */
export function resolveAnswer(question, { context = {}, responses = {} } = {}) {
  const ctxVal = context[question.contextKey];
  if (typeof ctxVal === 'string' && ctxVal.trim() !== '') {
    return { value: ctxVal.trim(), source: 'context' };
  }
  if (ctxVal && typeof ctxVal === 'object') {
    return { value: ctxVal, source: 'context' };
  }

  const resp = responses[question.id];
  if (!normalizeSkipToken(resp)) {
    return { value: typeof resp === 'string' ? resp.trim() : resp, source: 'answered' };
  }
  return { value: undefined, source: 'skipped' };
}

function parseParentAnswer(raw) {
  if (raw && typeof raw === 'object' && typeof raw.tier === 'string' && typeof raw.scopeId === 'string') {
    return { tier: raw.tier, scopeId: raw.scopeId };
  }
  if (typeof raw === 'string') {
    const m = raw.trim().match(/^([a-z-]+)\s*[/,: ]\s*(.+)$/i);
    if (m) return { tier: m[1].trim(), scopeId: m[2].trim() };
  }
  return null;
}

/**
 * Runs the full adaptive interview and assembles the resulting Persona
 * record. `tier` and `scopeId` are invocation PARAMETERS, not interview
 * questions — design-discussion.md §3e: the interview is "parameterized by
 * which tier/store it's authoring for," so identity is supplied by the
 * caller (which lifecycle moment this is: global-tier before any repo
 * exists, or code-architect once a repo exists), never guessed or asked.
 *
 * `displayName`/`scope` are optional overrides — the SKILL.md process
 * defaults them from TIER_CONTENT[tier] (tiers.ts) before ever calling this
 * (an adaptive skip in its own right: the tier's canonical responsibility
 * statement already answers "what does this tier do," so the interview asks
 * about THIS persona instance's knowledge instead of re-deriving that). If
 * neither is supplied, this function still produces a non-empty value for
 * both — the non-blocking hard-fail rule applies to invocation as much as to
 * the interview questions themselves.
 *
 * `context` — prior-known facts (e.g. an existing persona draft, project
 * profile content) checked BEFORE asking each question (adaptive skip).
 * `responses` — the operator's actual answers to whichever questions ended
 * up asked (i.e. not already covered by `context`).
 */
export function runPersonaInterview({ tier, scopeId, displayName, scope, context = {}, responses = {} } = {}) {
  if (typeof tier !== 'string' || tier.trim() === '') {
    throw new Error("runPersonaInterview: 'tier' is required — which tier/store this interview authors for.");
  }
  if (typeof scopeId !== 'string' || scopeId.trim() === '') {
    throw new Error(
      "runPersonaInterview: 'scopeId' is required — the persona instance identity, a parameter this " +
        'interview is invoked with, not one of its adaptive-skip questions.',
    );
  }

  const asked = [];
  const skippedByContext = [];
  const skippedCore = [];
  const answeredOptional = [];
  const skippedOptional = [];
  const sections = [];
  let parentRefs;

  for (const q of CORE_QUESTIONS) {
    const resolved = resolveAnswer(q, { context, responses });
    if (resolved.source === 'context') skippedByContext.push(q.id);
    else asked.push(q.id);

    if (q.id === 'parent') {
      if (resolved.source === 'skipped') {
        skippedCore.push(q.id);
        sections.push({ heading: q.sectionHeading, body: SKIP_PLACEHOLDER });
        continue;
      }
      const parsed = parseParentAnswer(resolved.value);
      const rawStr = typeof resolved.value === 'string' ? resolved.value.trim() : '';
      if (parsed === null || /^(none|no)$/i.test(rawStr)) {
        sections.push({ heading: q.sectionHeading, body: NO_PARENT_TEXT });
      } else {
        sections.push({
          heading: q.sectionHeading,
          body: `Queries up to tier '${parsed.tier}', scopeId '${parsed.scopeId}' for anything beyond this persona's own scope — never copies that parent's content down locally.`,
        });
        if (GLOBAL_TIERS.includes(parsed.tier)) {
          parentRefs = [{ tier: parsed.tier, scopeId: parsed.scopeId }];
        }
      }
      continue;
    }

    if (resolved.source === 'skipped') {
      skippedCore.push(q.id);
      sections.push({ heading: q.sectionHeading, body: SKIP_PLACEHOLDER });
    } else {
      sections.push({ heading: q.sectionHeading, body: String(resolved.value) });
    }
  }

  for (const q of OPTIONAL_QUESTIONS) {
    const resolved = resolveAnswer(q, { context, responses });
    if (resolved.source === 'context') skippedByContext.push(q.id);
    else asked.push(q.id);

    if (resolved.source === 'skipped') {
      skippedOptional.push(q.id);
      // Omitted entirely — no section, no placeholder (kickoff's optional-follow-up rule).
    } else {
      answeredOptional.push(q.id);
      sections.push({ heading: q.sectionHeading, body: String(resolved.value) });
    }
  }

  const persona = {
    tier,
    scopeId: scopeId.trim(),
    displayName:
      typeof displayName === 'string' && displayName.trim() !== ''
        ? displayName.trim()
        : `${tier} (name not provided — skipped during interview)`,
    scope: typeof scope === 'string' && scope.trim() !== '' ? scope.trim() : SKIP_PLACEHOLDER,
    sections,
  };
  if (parentRefs) persona.parentRefs = parentRefs;

  return { persona, asked, skippedByContext, skippedCore, answeredOptional, skippedOptional };
}

/**
 * Builds the `remember()` text for this persona's interview record. Folds
 * `scopeId` (and `tier`) into the text itself — per persona.ts's
 * `resolveRememberScope` doc comment: "this resolver only owns the
 * scope-argument mapping... The caller (pw-10's interview skill) SHOULD also
 * fold scopeId into the remembered text itself so it stays recall-searchable,
 * not just present in the note's filename." This function is that fold; it
 * does NOT compute `scope`/`tag` itself — callers pair this text with
 * `resolveRememberScope(persona)`'s real `{scope, tag}` output (persona.ts),
 * never a second, invented scope-mapping scheme.
 */
export function buildRememberText(persona) {
  const body = persona.sections.map((s) => `${s.heading}: ${s.body}`).join(' | ');
  return (
    `Persona interview record — tier: ${persona.tier}, scopeId: ${persona.scopeId}, ` +
    `displayName: ${persona.displayName}. ${body}`
  );
}
