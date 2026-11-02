/** Bounded OpenRouter decision advice, independent of code-writing model routes. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool, type InferValue } from '@deepseek-ai/dsh-tools'

/** Global limits for optional structured decision advice. */
export interface DecisionSettings {
  /** Register the optional decision advisor tool. */
  enabled: boolean
  /** OpenRouter Decisions model identifier. */
  model: string
  /** Credential reference or environment name holding the OpenRouter API key. */
  apiKeyEnv: string
  /** Deadline in milliseconds for one decision request. */
  timeoutMs: number
  /** Minimum accepted confidence; lower scores return uncertainty. */
  minConfidence: number
  /** Maximum UTF-8 bytes of serialized question text. */
  maxTextBytes: number
  /** Maximum combined bytes of retained image attachments. */
  maxImageBytes: number
  /** Maximum decision requests admitted during one agent turn. */
  maxCallsPerTurn: number
  /** Maximum finite questions in one request. */
  maxQuestions: number
  /** Maximum choices for each question. */
  maxOptions: number
}

/** Defaults remain editable through the owning coding configuration. */
export const decisionDefaults: DecisionSettings = {
  enabled: false, model: 'typesafe/jev-1.14', apiKeyEnv: 'OPENROUTER_API_KEY', timeoutMs: 2500,
  minConfidence: 0.7, maxTextBytes: 12000, maxImageBytes: 2097152, maxCallsPerTurn: 2, maxQuestions: 4, maxOptions: 12,
}

/** Validated decision settings, including latency and request-size limits. */
export const decisionSchema = z.object({
  enabled: z.boolean().default(false), model: z.string().default(decisionDefaults.model),
  apiKeyEnv: z.string().default(decisionDefaults.apiKeyEnv),
  timeoutMs: z.number().step(1).min(100).max(30000).default(decisionDefaults.timeoutMs),
  minConfidence: z.number().min(0).max(1).default(decisionDefaults.minConfidence),
  maxTextBytes: z.number().step(1).min(1).default(decisionDefaults.maxTextBytes),
  maxImageBytes: z.number().step(1).min(1).default(decisionDefaults.maxImageBytes),
  maxCallsPerTurn: z.number().step(1).min(1).default(decisionDefaults.maxCallsPerTurn),
  maxQuestions: z.number().step(1).min(1).max(16).default(decisionDefaults.maxQuestions),
  maxOptions: z.number().step(1).min(2).max(64).default(decisionDefaults.maxOptions),
}).default(decisionDefaults)

/** One finite question; option ids are returned without generated prose. */
export interface DecisionQuestion {
  id: string
  question: string
  options: { id: string; description: string }[]
}
/** Caller supplies a compact task description and explicitly requests retained session images. */
export interface DecisionInput {
  context: string
  questions: DecisionQuestion[]
  image_count?: number
}
/** Sanitized, handling-relevant decision failure. Provider bodies and credentials are never included. */
export class DecisionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DecisionError' }
}

const endpoint = 'https://openrouter.ai/api/alpha/decisions'
const identifier = /^[a-z][a-z0-9_]{0,47}$/
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

function validateInput(settings: DecisionSettings, input: DecisionInput): void {
  if (!settings.enabled) throw new DecisionError('DECISION_DISABLED', 'Decision advice is disabled in Coding settings.')
  if (!settings.model.trim()) throw new DecisionError('DECISION_MODEL_REQUIRED', 'Configure a decision model in Coding settings.')
  if (!input.context.trim() || Buffer.byteLength(JSON.stringify(input), 'utf8') > settings.maxTextBytes) {
    throw new DecisionError('DECISION_INPUT_LIMIT', 'Provide a short task summary within the configured text budget.')
  }
  if (input.questions.length < 1 || input.questions.length > settings.maxQuestions) {
    throw new DecisionError('DECISION_QUESTION_LIMIT', `Batch between 1 and ${settings.maxQuestions} questions.`)
  }
  if (input.image_count !== undefined && (!Number.isInteger(input.image_count) || input.image_count < 0 || input.image_count > 2)) {
    throw new DecisionError('DECISION_IMAGE_LIMIT', 'Request zero, one, or two retained session images.')
  }
  const ids = new Set<string>()
  for (const question of input.questions) {
    if (!identifier.test(question.id) || ids.has(question.id) || !question.question.trim()) {
      throw new DecisionError('DECISION_QUESTION_INVALID', 'Questions need unique short ids and nonempty instructions.')
    }
    ids.add(question.id)
    const choices = new Set(question.options.map(option => option.id))
    if (choices.size !== question.options.length || question.options.length < 2 || question.options.length > settings.maxOptions
      || question.options.some(option => !identifier.test(option.id) || !option.description.trim())) {
      throw new DecisionError('DECISION_OPTIONS_INVALID', 'Provide distinct option ids with descriptions within the configured limit.')
    }
  }
}

/** Image bytes already belong to a durable, immutable session attachment. */
export interface DecisionImage { attachmentId: string; mediaType: string; data: Uint8Array }

/**
 * Ask finite questions with one request and no automatic retries. Caller cancellation propagates;
 * deadline, transport, HTTP and invalid-answer failures carry sanitized codes. No workflow is changed.
 * @param settings - approved model, credential reference and request limits.
 * @param input - compact context and candidate choices.
 * @param apiKey - operation-scoped credential; never returned or logged.
 * @param images - verified bytes of explicitly selected retained images.
 * @param signal - caller-owned cancellation.
 * @returns advice, uncertainty, actual model, timing and usage for the durable tool result.
 */
export async function submitDecision(
  settings: DecisionSettings, input: DecisionInput, apiKey: string, images: readonly DecisionImage[], signal: AbortSignal,
): Promise<InferValue<typeof decisionResultSchema>> {
  validateInput(settings, input)
  signal.throwIfAborted()
  const imageBytes = images.reduce((sum, image) => sum + image.data.byteLength, 0)
  if (images.length !== (input.image_count ?? 0) || imageBytes > settings.maxImageBytes) {
    throw new DecisionError('DECISION_IMAGE_LIMIT', 'Requested session images are missing or exceed the configured image budget.')
  }
  const state: (string | { type: 'image_url'; image_url: { url: string } })[] = [input.context]
  for (const image of images) state.push({
    type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` },
  })
  const body = { model: settings.model, state, questions: Object.fromEntries(input.questions.map(question => [question.id, {
    type: 'choice', instructions: question.question,
    criteria: Object.fromEntries(question.options.map(option => [option.id, option.description])),
  }])) }
  const deadline = AbortSignal.timeout(settings.timeoutMs)
  const started = performance.now()
  let value: unknown
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'CodeCrew' },
      body: JSON.stringify(body), signal: AbortSignal.any([signal, deadline]),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new DecisionError('DECISION_HTTP', `Decision service returned HTTP ${response.status}. Continue with supervisor judgment.`)
    }
    value = await response.json()
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (error instanceof DecisionError) throw error
    if (deadline.aborted) throw new DecisionError('DECISION_TIMEOUT', 'Decision deadline reached. Continue without another decision call.')
    throw new DecisionError('DECISION_TRANSPORT', 'Decision service did not return a readable response. Continue with supervisor judgment.')
  }
  signal.throwIfAborted()
  if (!record(value) || typeof value.model !== 'string' || !record(value.answers)) {
    throw new DecisionError('DECISION_INVALID_RESPONSE', 'Decision service returned an invalid answer envelope.')
  }
  const answers = value.answers
  const decisions = input.questions.map((question) => {
    const answer = answers[question.id]
    if (!record(answer) || answer.type !== 'choice' || typeof answer.choice !== 'string'
      || !question.options.some(option => option.id === answer.choice) || !record(answer.probabilities)
      || (answer.confidence !== undefined && !probability(answer.confidence))) {
      throw new DecisionError('DECISION_INVALID_RESPONSE', 'Decision service returned an unrecognized choice or confidence.')
    }
    const probabilities = answer.probabilities
    const distribution = question.options.map((option) => {
      const chance = probabilities[option.id]
      if (!probability(chance)) throw new DecisionError('DECISION_INVALID_RESPONSE', 'Decision service returned an invalid probability.')
      return { option: option.id, probability: chance }
    })
    if (Math.abs(distribution.reduce((sum, item) => sum + item.probability, 0) - 1) > 0.02) {
      throw new DecisionError('DECISION_INVALID_RESPONSE', 'Decision probabilities do not form a distribution.')
    }
    const confidence = answer.confidence ?? 0
    const status: 'decided' | 'uncertain' = confidence >= settings.minConfidence ? 'decided' : 'uncertain'
    return { id: question.id, status,
      choice: confidence >= settings.minConfidence ? answer.choice : null, confidence, distribution }
  })
  const usage = record(value.usage) ? value.usage : {}
  const metric = (key: string) => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : null
  return { model: value.model, requestedModel: settings.model, elapsedMs: Math.round(performance.now() - started), decisions,
    images: images.map(image => image.attachmentId), usage: { inputTokens: metric('input_tokens'), outputTokens: metric('output_tokens'), cost: metric('cost') } }
}

const decisionResultSchema = {
  type: 'object', additionalProperties: false, properties: {
    model: { type: 'string', required: true }, requestedModel: { type: 'string', required: true },
    elapsedMs: { type: 'number', required: true }, images: { type: 'array', items: { type: 'string' }, required: true },
    decisions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', required: true }, status: { type: 'string', enum: ['decided', 'uncertain'], required: true },
      choice: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true }, confidence: { type: 'number', required: true },
      distribution: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        option: { type: 'string', required: true }, probability: { type: 'number', required: true },
      } } },
    } } },
    usage: { type: 'object', required: true, additionalProperties: false, properties: {
      inputTokens: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
      outputTokens: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
      cost: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
    } },
  },
} as const

/**
 * Register optional advice only for enabled steps. Images come solely from the retained session;
 * new filesystem paths, URLs and unrelated attachments cannot be supplied by the model.
 * @param ctx - exact calling agent scope and its credential/attachment capabilities.
 * @param agent - owner of the retained input and per-turn request budget.
 * @param settings - live global decision policy.
 * @returns registration disposer.
 */
export function installDecisionTool(ctx: Context, agent: Agent, settings: () => DecisionSettings): () => void {
  let budget = { turn: -1, calls: 0 }
  const stopStep = ctx.on('agent/pre-step', async (input, next) => {
    const decision = await next()
    if (input.agent === agent && decision.kind !== 'reject' && budget.turn !== input.turn) budget = { turn: input.turn, calls: 0 }
    return decision
  })
  const stopTool = ctx.tools.register(defineTool({
    name: 'coding_decide',
    description: 'Get bounded decision advice for ambiguous model/skill selection, parallel work, failure triage, or a screenshot. Batch related questions. Skip routine edits and passing-check approval. Advice cannot replace supervisor verification.',
    parameters: {
      context: { type: 'string', required: true, description: 'Short task, constraints and relevant evidence. No transcript or secrets.' },
      questions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, question: { type: 'string', required: true },
        options: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true }, description: { type: 'string', required: true },
        } } },
      } } },
      image_count: { type: 'integer', description: 'Explicitly include the latest one or two retained session images, in chronological order; omit for text only.' },
    },
    output: { schema: decisionResultSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: () => ({ card: 'generic', title: 'Decision advice', kind: 'read' }),
    async execute(input, exec) {
      const policy = settings()
      validateInput(policy, input)
      exec.signal.throwIfAborted()
      const key = await ctx.get('credentials')?.resolve(credentialRef(policy.apiKeyEnv))
      if (!key?.value) throw new DecisionError('DECISION_CREDENTIAL_REQUIRED', 'Configure the OpenRouter credential in Models settings before using decision advice.')
      const refs: ImageAttachmentRef[] = []
      const wanted = input.image_count ?? 0
      if (wanted > 0) for (const message of agent.session.deriveMessages().toReversed()) {
        for (const block of message.content.toReversed()) {
          if (block.type === 'image' && !refs.some(ref => ref.attachmentId === block.attachment.attachmentId)) refs.unshift(block.attachment)
          if (refs.length === wanted) break
        }
        if (refs.length === wanted) break
      }
      const attachments = ctx.get('attachments')
      if (refs.length !== wanted || (wanted > 0 && attachments === undefined)
        || refs.reduce((sum, ref) => sum + ref.bytes, 0) > policy.maxImageBytes) {
        throw new DecisionError('DECISION_IMAGE_LIMIT', 'Requested retained session images are unavailable or exceed the image budget.')
      }
      const images: DecisionImage[] = []
      for (const ref of refs) {
        if (attachments === undefined) throw new DecisionError('DECISION_IMAGE_LIMIT', 'Session image storage is unavailable.')
        const stored = await attachments.readImage(ref, exec.signal)
        images.push({ attachmentId: String(ref.attachmentId), mediaType: stored.ref.mediaType, data: stored.data })
      }
      if (budget.calls >= policy.maxCallsPerTurn) throw new DecisionError('DECISION_BUDGET', 'Decision request budget reached for this turn. Continue with supervisor judgment.')
      budget.calls++
      return submitDecision(policy, input, key.value, images, exec.signal)
    },
  }), { when: () => settings().enabled })
  return () => { stopTool(); stopStep() }
}
