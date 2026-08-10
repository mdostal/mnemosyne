export interface PlanStep {
  id: string;
  title: string;
  description: string;
  depends_on?: string[];
}

export interface PlanResponse {
  summary: string;
  steps: PlanStep[];
  risks?: string[];
}

export function validatePlanResponse(value: unknown): PlanResponse {
  if (!isRecord(value)) {
    throw new Error('PlanResponse must be an object');
  }

  if (typeof value.summary !== 'string' || value.summary.trim() === '') {
    throw new Error('PlanResponse.summary must be a non-empty string');
  }

  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error('PlanResponse.steps must be a non-empty array');
  }

  const steps = value.steps.map(validatePlanStep);
  const response: PlanResponse = {
    summary: value.summary,
    steps,
  };

  if (value.risks !== undefined) {
    if (!Array.isArray(value.risks) || !value.risks.every((risk) => typeof risk === 'string')) {
      throw new Error('PlanResponse.risks must be an array of strings');
    }
    response.risks = value.risks;
  }

  return response;
}

function validatePlanStep(value: unknown): PlanStep {
  if (!isRecord(value)) {
    throw new Error('PlanResponse.steps entries must be objects');
  }

  if (typeof value.id !== 'string' || value.id.trim() === '') {
    throw new Error('PlanStep.id must be a non-empty string');
  }

  if (typeof value.title !== 'string' || value.title.trim() === '') {
    throw new Error('PlanStep.title must be a non-empty string');
  }

  if (typeof value.description !== 'string' || value.description.trim() === '') {
    throw new Error('PlanStep.description must be a non-empty string');
  }

  const step: PlanStep = {
    id: value.id,
    title: value.title,
    description: value.description,
  };

  if (value.depends_on !== undefined) {
    if (
      !Array.isArray(value.depends_on) ||
      !value.depends_on.every((dependency) => typeof dependency === 'string')
    ) {
      throw new Error('PlanStep.depends_on must be an array of strings');
    }
    step.depends_on = value.depends_on;
  }

  return step;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
