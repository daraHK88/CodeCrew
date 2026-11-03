/** Bounded OpenRouter decision advice, independent of code-writing model routes. */
import { DecisionError } from './decision-error.ts'
export { DecisionError } from './decision-error.ts'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { prepareDecisionRequest, type DecisionRecipe } from './decision-recipes.ts'
import { inspectDecisionFiles } from './decision-files.ts'
import { defineTool, type InferValue } from '@deepseek-ai/dsh-tools'

/** Global limits for optional structured decision advice. */
export interface DecisionSettings {
  /** Register the optional decision advisor tool. */
  enabled: boolean
  /** Let Jev select one permitted skill when local rules do not match a substantial task. */
  autoSelectSkills?: boolean
  /** Select an approved worker profile when the supervisor omits model_profile. */
  autoRouteWorkers?: boolean
  /** Allow explicitly selected workspace files to be assessed without returning their contents. */
  inspectFiles?: boolean
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
  minConfidence: 0.7, maxTextBytes: 12000, maxImageBytes: 2097152, maxCallsPerTurn: 2, maxQuestions: 8, maxOptions: 12,
}

/** Validated decision settings, including latency and request-size limits. */
export const decisionSchema = z.object({
  autoSelectSkills: z.boolean().default(false), autoRouteWorkers: z.boolean().default(false), inspectFiles: z.boolean().default(false),
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

/** One finite choice, yes/no probability, or ordered-rubric question. */
export type DecisionQuestion =
  | { id: string; question: string; type?: 'choice'; options: { id: string; description: string }[] }
  | { id: string; question: string; type: 'noul' }
  | { id: string; question: string; type: 'score'; levels: string[] }
/** Caller supplies a compact task description and explicitly requests retained session images. */
export interface DecisionInput {
  context: string
  questions: DecisionQuestion[]
  image_count?: number
}
/** Optional recipes and explicitly selected files for the model-facing advisor. */
export interface DecisionRequest {
  context: string
  questions?: DecisionQuestion[]
  recipe?: DecisionRecipe
  files?: string[]
  image_count?: number
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
    if (question.type === 'noul') {
      if ('options' in question || 'levels' in question) throw new DecisionError('DECISION_OPTIONS_INVALID', 'Noul questions do not take options or levels.')
      continue
    }
    if (question.type === 'score') {
      if (!Array.isArray(question.levels) || 'options' in question || question.levels.length < 2 || question.levels.length > 10 || question.levels.some(level => !level.trim())) {
        throw new DecisionError('DECISION_OPTIONS_INVALID', 'Scores require two to ten nonempty ordered levels.')
      }
      continue
    }
    if (!Array.isArray(question.options) || 'levels' in question) {
      throw new DecisionError('DECISION_OPTIONS_INVALID', 'Choice questions require options; score questions require levels.')
    }
    const choices = new Set(question.options.map(option => option.id))
    if (choices.size !== question.options.length || question.options.length < 2 || question.options.length > settings.maxOptions
      || question.options.some(option => !identifier.test(option.id) || !option.description.trim())) {
      throw new DecisionError('DECISION_OPTIONS_INVALID', 'Provide distinct option ids with descriptions within the configured limit.')
    }
  }
}

/** Image bytes already belong to a durable, immutable session attachment. */
export interface DecisionImage { attachmentId: string; mediaType: string; data: Uint8Array }

/** The text-only provider envelope shared by size checks and submission. */
function decisionTextBody(settings: DecisionSettings, input: DecisionInput) {
  return { model: settings.model, state: [input.context], questions: Object.fromEntries(input.questions.map(question => [question.id, {
    type: question.type ?? 'choice', instructions: question.question,
    ...question.type === 'noul' ? {} : { criteria: question.type === 'score'
      ? question.levels : Object.fromEntries(question.options.map(option => [option.id, option.description])) },
  }])) }
}

/**
 * Complete text bytes across the admission input and provider envelope, including escaped metadata.
 * @param settings - decision model and request policy.
 * @param input - compact decision questions and context.
 * @returns the larger complete text byte count used at admission or submission.
 */
export function decisionTextBytes(settings: DecisionSettings, input: DecisionInput): number {
  return Math.max(Buffer.byteLength(JSON.stringify(input)), Buffer.byteLength(JSON.stringify(decisionTextBody(settings, input))))
}

/**
 * Shared decision budget owned by one calling agent and its registration lifetime.
 */
export interface DecisionAdvisor {
  /** Remove the advisor tool and step listener. */
  (): void
  /** Submit bounded advice using the same per-turn budget as automatic routing. */
  ask(input: DecisionInput, signal: AbortSignal, images?: readonly DecisionImage[]): Promise<InferValue<typeof decisionResultSchema>>
}

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
  const body = { ...decisionTextBody(settings, input), state }
  if (decisionTextBytes(settings, input) > settings.maxTextBytes) {
    throw new DecisionError('DECISION_INPUT_LIMIT', 'Complete decision text exceeds the configured request budget.')
  }
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
  const decisions = input.questions.map((question): InferValue<typeof decisionResultSchema>['decisions'][number] => {
    const answer = answers[question.id]
    const type = question.type ?? 'choice'
    const invalid = () => new DecisionError('DECISION_INVALID_RESPONSE', 'Decision service returned an invalid or inconsistent typed answer.')
    if (!record(answer) || answer.type !== type) throw invalid()
    if (question.type === 'noul') {
      if (!probability(answer.noul)) throw invalid()
      const confidence = Math.abs(2 * answer.noul - 1)
      return { id: question.id, type, status: confidence >= settings.minConfidence ? 'decided' : 'uncertain',
        choice: null, confidence, noul: answer.noul, score: null, distribution: [
          { option: 'yes', probability: answer.noul }, { option: 'no', probability: 1 - answer.noul },
        ] }
    }
    if (!record(answer.probabilities) || (answer.confidence !== undefined && !probability(answer.confidence))) throw invalid()
    const labels = question.type === 'score' ? question.levels.map((_, index) => String(index)) : question.options.map(option => option.id)
    const probabilities = answer.probabilities
    if (Object.keys(probabilities).length !== labels.length) throw invalid()
    const distribution = labels.map((option) => {
      const chance = probabilities[option]
      if (!probability(chance)) throw invalid()
      return { option, probability: chance }
    })
    if (Math.abs(distribution.reduce((sum, item) => sum + item.probability, 0) - 1) > 0.02) throw invalid()
    const top = Math.max(...distribution.map(item => item.probability))
    // A claimed confidence cannot turn a flat distribution into a confident decision.
    let derivedConfidence = Math.max(0, (top - 1 / labels.length) / (1 - 1 / labels.length))
    if (question.type === 'score') {
      const modal = distribution.findIndex(item => item.probability === top)
      const spread = distribution.reduce((sum, item, index) => sum + item.probability * Math.abs(index - modal), 0)
      const uniform = distribution.reduce((sum, _, index) => sum + Math.abs(index - (labels.length - 1) / 2), 0) / labels.length
      derivedConfidence = Math.max(0, 1 - spread / uniform)
    }
    const confidence = Math.min(answer.confidence ?? 0, derivedConfidence)
    if (question.type === 'score') {
      const score = answer.score
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > question.levels.length - 1) throw invalid()
      const weighted = distribution.reduce((sum, item, index) => sum + index * item.probability, 0)
      if (Math.abs(score - weighted) > 0.05) throw invalid()
      return { id: question.id, type, status: confidence >= settings.minConfidence ? 'decided' : 'uncertain',
        choice: null, confidence, noul: null, score, distribution }
    }
    if (typeof answer.choice !== 'string' || !distribution.some(item => item.option === answer.choice && item.probability === top)) throw invalid()
    const unique = distribution.filter(item => item.probability === top).length === 1
    const decided = unique && confidence >= settings.minConfidence
    return { id: question.id, type, status: decided ? 'decided' : 'uncertain',
      choice: decided ? answer.choice : null, confidence, noul: null, score: null, distribution }
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
      type: { type: 'string', enum: ['choice', 'noul', 'score'], required: true }, noul: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
      score: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
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
 * @param exposeTool - whether this role may request advice directly; leaf workers use their supervisor's routing.
 * @returns Callable registration disposer and shared budgeted decision caller.
 */
export function installDecisionTool(ctx: Context, agent: Agent, settings: () => DecisionSettings, exposeTool = true): DecisionAdvisor {
  let budget = { turn: -1, calls: 0 }
  const stopStep = ctx.on('agent/pre-step', async (input, next) => {
    if (input.agent === agent && budget.turn !== input.turn) budget = { turn: input.turn, calls: 0 }
    return next()
  })
  const ask = async (input: DecisionInput, signal: AbortSignal, images: readonly DecisionImage[] = []) => {
    const policy = settings()
    validateInput(policy, input)
    signal.throwIfAborted()
    const key = await ctx.get('credentials')?.resolve(credentialRef(policy.apiKeyEnv))
    if (!key?.value) throw new DecisionError('DECISION_CREDENTIAL_REQUIRED', 'Configure the OpenRouter credential in Models settings before using decision advice.')
    if (budget.calls >= policy.maxCallsPerTurn) throw new DecisionError('DECISION_BUDGET', 'Decision request budget reached for this turn. Continue with supervisor judgment.')
    budget.calls++
    return submitDecision(policy, input, key.value, images, signal)
  }
  const stopTool = ctx.tools.register(defineTool({
    name: 'coding_decide',
    description: 'Ask typed choice, yes/no, or rubric questions. Optional recipes assess review risk, test coverage, rules, browser progress or compaction readiness. Explicit workspace files can be assessed without returning their contents. Batch questions; use grep for exact lookups. Advice is not permission or verification.',
    parameters: {
      context: { type: 'string', required: true, description: 'Short task, constraints and relevant evidence. No transcript or secrets.' },
      recipe: { type: 'string', enum: ['custom', 'review', 'coverage', 'rules', 'browser', 'compaction', 'rank_files'], description: 'Use a fixed question set; custom requires questions.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Explicit workspace files to send to the decision model instead of loading their text here; no globs, secret files, or paths outside the workspace.' },
      questions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, question: { type: 'string', required: true },
        type: { type: 'string', enum: ['choice', 'noul', 'score'], description: 'Defaults to choice. Noul returns probability of yes; score rates ordered levels.' },
        levels: { type: 'array', items: { type: 'string' }, description: 'Two to ten ordered rubric levels for score only.' },
        options: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true }, description: { type: 'string', required: true },
        } } },
      } } },
      image_count: { type: 'integer', description: 'Explicitly include the latest one or two retained session images, in chronological order; omit for text only.' },
    },
    output: { schema: { ...decisionResultSchema, properties: { ...decisionResultSchema.properties,
      sources: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, version: { type: 'string', required: true }, bytes: { type: 'number', required: true },
      } } }, reviewDepth: { type: 'string', required: true },
      ranking: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, probability: { type: 'number', required: true },
      } } },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: () => ({ card: 'generic', title: 'Decision advice', kind: 'read' }),
    async execute(request: DecisionRequest, exec) {
      const policy = settings()
      let input = prepareDecisionRequest(request)
      validateInput(policy, input)
      exec.signal.throwIfAborted()
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
      const inspected = await inspectDecisionFiles(ctx, agent, request.files ?? [], input, policy, exec.signal)
      input = { ...input, context: inspected.context }
      const result = await ask(input, exec.signal, images)
      const reviewDepth = request.recipe === 'review'
        ? result.decisions.every(item => item.status === 'decided' && item.noul !== null && item.noul < 0.5) ? 'quick' : 'full'
        : 'not_assessed'
      const ranking = request.recipe === 'rank_files' ? (request.files ?? []).map((path, index) => ({ path,
        probability: result.decisions[0]?.distribution.find(item => item.option === `file_${index}`)?.probability ?? 0,
      })).sort((a, b) => b.probability - a.probability) : []
      return { ...result, sources: inspected.sources, reviewDepth, ranking }
    },
  }), { when: () => exposeTool && settings().enabled })
  return Object.assign(() => { stopTool(); stopStep() }, { ask })
}
