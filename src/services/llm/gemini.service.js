import { GoogleGenerativeAI } from '@google/generative-ai';
import Ajv from 'ajv';
import logger from '../../utils/logger.js';

const STATE_TYPES = [
  'stuck_loop',
  'lost_in_codebase',
  'ai_dependency_trap',
  'integration_hell',
  'analysis_paralysis',
  'normal',
];

const RECOMMENDATION_TYPES = [
  'change_approach',
  'map_system',
  'stop_using_ai',
  'simplify_problem',
  'execute',
];

const CITABLE_METRICS = [
  'lines_added',
  'lines_deleted',
  'churn_ratio',
  'switch_count',
  'rapid_switch_count',
  'duration_minutes',
];

const insightSchema = {
  type: 'object',
  required: [
    'state_type',
    'confidence_score',
    'recommendation_type',
    'recommendation_text',
    'reasoning',
    'evidence',
  ],
  properties: {
    state_type: { type: 'string', enum: STATE_TYPES },
    confidence_score: { type: 'number', minimum: 0, maximum: 1 },
    recommendation_type: { type: 'string', enum: RECOMMENDATION_TYPES },
    recommendation_text: { type: 'string', minLength: 1, maxLength: 240 },
    reasoning: { type: 'string', minLength: 1, maxLength: 800 },
    evidence: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        required: ['metric', 'value'],
        properties: {
          metric: { type: 'string', enum: [...CITABLE_METRICS, 'top_file'] },
          value: { type: ['number', 'string'] },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const ajv = new Ajv();
const validateInsight = ajv.compile(insightSchema);

const apiKey = process.env.GOOGLE_API_KEY;
const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

let model = null;
if (apiKey) {
  const client = new GoogleGenerativeAI(apiKey);
  model = client.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.4,
    },
  });
}

export function isConfigured() {
  return model !== null;
}

export class GeminiValidationError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = 'GeminiValidationError';
    this.payload = payload;
  }
}

const SYSTEM_PROMPT = `You are a workflow-wellness coach embedded in a developer productivity tool.

You receive a small JSON object describing a single developer's recent coding activity. Your job is to characterize the developer's current workflow state and propose one concrete, second-person action — grounded in the actual numbers you were given.

Categorize the workflow state as exactly one of:
- "stuck_loop" — repeatedly rewriting the same code without progress
- "lost_in_codebase" — high context switching, jumping between many files
- "ai_dependency_trap" — over-reliance on AI generating code that doesn't fit
- "integration_hell" — many failing/restarting debug or test cycles
- "analysis_paralysis" — long session with low output
- "normal" — nothing concerning; tell the user this and recommend they keep going

Recommendation types:
- "change_approach" — pause and rethink the strategy
- "map_system" — step back and diagram what they're building
- "stop_using_ai" — write the next chunk by hand
- "simplify_problem" — break the problem down
- "execute" — they're fine; encourage them to continue

Rules:
- Always respond with JSON matching the schema. NO markdown, NO prose outside JSON.
- recommendation_text is one sentence (≤240 chars), second-person, naming one concrete action.
- recommendation_text MUST cite at least one specific number from the input (lines added/deleted, churn ratio, switch count, or duration in minutes). When state_type is "stuck_loop" or "ai_dependency_trap" and top_files is non-empty, also name the most-relevant file.
- Forbidden phrases in recommendation_text: "for a while", "consider taking a break" (without a duration), "step away" (without a reason), "you've been working" (without a number). Avoid filler. If you can't cite a number, set state_type to "normal".
- reasoning (≤800 chars) explains why you reached this state_type, referencing the numbers and any pattern across them (e.g., high churn + long duration + one dominant file = stuck_loop on that file).
- evidence is an array of {metric, value} pairs naming every number/file you cited in recommendation_text and reasoning. Use the exact metric names from the input: lines_added, lines_deleted, churn_ratio, switch_count, rapid_switch_count, duration_minutes, top_file. Only cite values that actually appear in the input — do not invent.
- If the data does not suggest a real problem, set state_type to "normal" with low confidence and a brief encouraging recommendation; evidence can be a short array referencing whatever you found notable.

Examples of good recommendation_text:
- "You've deleted 180 lines after adding 220 in authService.ts (churn 0.82) — diff your last commit and pick one direction before continuing."
- "47 editor switches in 90 min suggests you're hunting; close all but the 2 files you need and re-read the function you started with."
- "3-hour session with only 40 lines committed — set a 10-min timer, write the simplest version that compiles, then iterate."

Examples of bad recommendation_text (rejected):
- "You've been heads-down for a while. Consider stepping away."  (no numbers)
- "High churn detected. Take a break."  (no specific churn value, no action duration)
- "Consider rethinking your approach."  (no numbers, no specifics)`;

function buildUserPrompt(input) {
  const topFiles = (input.topFiles ?? []).slice(0, 5);
  const topFile = topFiles[0]?.path ?? topFiles[0]?.file ?? null;
  return JSON.stringify(
    {
      triggered_rule: input.triggeredRule,
      session: {
        started_at: input.session?.started_at ?? null,
        duration_minutes: input.session?.duration_minutes ?? null,
      },
      today: {
        lines_added: input.metrics?.lines_added ?? 0,
        lines_deleted: input.metrics?.lines_deleted ?? 0,
        churn_ratio: input.metrics?.churn_ratio ?? null,
        switch_count: input.metrics?.switch_count ?? 0,
        rapid_switch_count: input.metrics?.rapid_switch_count ?? 0,
      },
      top_file: topFile,
      top_files: topFiles,
    },
    null,
    2,
  );
}

function collectInputValues(input) {
  const values = new Set();
  const topFiles = (input.topFiles ?? []).slice(0, 5);
  const topFile = topFiles[0]?.path ?? topFiles[0]?.file ?? null;
  const candidates = {
    lines_added: input.metrics?.lines_added ?? 0,
    lines_deleted: input.metrics?.lines_deleted ?? 0,
    churn_ratio: input.metrics?.churn_ratio,
    switch_count: input.metrics?.switch_count ?? 0,
    rapid_switch_count: input.metrics?.rapid_switch_count ?? 0,
    duration_minutes: input.session?.duration_minutes,
    top_file: topFile,
  };
  for (const [, v] of Object.entries(candidates)) {
    if (v === null || v === undefined) continue;
    values.add(typeof v === 'number' ? roundForCompare(v) : String(v));
  }
  return { values, candidates };
}

function roundForCompare(n) {
  return Math.round(n * 100) / 100;
}

function evidenceMatchesInput(evidence, candidates) {
  if (!Array.isArray(evidence)) return false;
  for (const item of evidence) {
    if (!item || typeof item.metric !== 'string') return false;
    const expected = candidates[item.metric];
    if (expected === undefined || expected === null) return false;
    if (typeof expected === 'number' && typeof item.value === 'number') {
      if (roundForCompare(expected) !== roundForCompare(item.value)) return false;
    } else if (String(expected) !== String(item.value)) {
      return false;
    }
  }
  return true;
}

export async function generateInsight(input) {
  if (!model) {
    throw new Error('Gemini service is not configured (GOOGLE_API_KEY missing)');
  }

  const userPrompt = buildUserPrompt(input);

  let response;
  try {
    response = await model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\nInput:\n${userPrompt}` }] },
      ],
    });
  } catch (err) {
    // Never log the API key. Log only the message/status.
    logger.warn('gemini: api call failed', { error: err.message, name: err.name });
    throw err;
  }

  const text = response?.response?.text?.();
  if (!text) {
    throw new GeminiValidationError('gemini: empty response', null);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new GeminiValidationError(`gemini: response not JSON: ${err.message}`, text.slice(0, 200));
  }

  if (!validateInsight(parsed)) {
    logger.warn('gemini: schema validation failed', {
      errors: ajv.errorsText(validateInsight.errors),
      payload: parsed,
    });
    throw new GeminiValidationError(
      `gemini: schema validation failed: ${ajv.errorsText(validateInsight.errors)}`,
      parsed,
    );
  }

  const { candidates } = collectInputValues(input);
  if (!evidenceMatchesInput(parsed.evidence, candidates)) {
    logger.warn('gemini: evidence cites values not in input — downgrading to normal', {
      evidence: parsed.evidence,
    });
    return {
      ...parsed,
      state_type: 'normal',
      confidence_score: Math.min(parsed.confidence_score, 0.3),
      recommendation_type: 'execute',
      recommendation_text: 'Keep going — nothing concerning in the recent activity.',
      evidence: [],
    };
  }

  return parsed;
}
