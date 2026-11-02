import { afterEach, expect, it, vi } from 'vitest'
import { decisionDefaults, DecisionError, submitDecision, type DecisionInput } from '../src/decisions.ts'

const settings = { ...decisionDefaults, enabled: true }
const input: DecisionInput = {
  context: 'Change the text of one button in an existing file.',
  questions: [{ id: 'route', question: 'Which approved role is sufficient?', options: [
    { id: 'reader', description: 'Cheap model for a direct mechanical edit.' },
    { id: 'planner', description: 'Stronger model for difficult architecture.' },
  ] }],
}
const answer = (confidence = 0.95, choice = 'reader') => ({ model: 'typesafe/jev-1.14-test', answers: {
  route: { type: 'choice', choice, confidence, probabilities: { reader: 0.96, planner: 0.04 } },
}, usage: { input_tokens: 200, output_tokens: 0, cost: 0.0000084 } })
const signal = new AbortController().signal

afterEach(() => { vi.unstubAllGlobals() })

it('batches finite choices through Decisions without a chat-completions request', async () => {
  const payload = answer()
  payload.answers = { ...payload.answers, skill: payload.answers.route } as typeof payload.answers
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload))
  vi.stubGlobal('fetch', fetcher)
  const result = await submitDecision(settings, { ...input, questions: [...input.questions, { ...input.questions[0]!, id: 'skill' }] }, 'fixture-key', [], signal)
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, init] = fetcher.mock.calls[0]!
  expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
  expect(init?.headers).toMatchObject({ Authorization: 'Bearer fixture-key' })
  if (typeof init?.body !== 'string') throw new Error('Expected JSON request body')
  const body = JSON.parse(init.body) as { questions: Record<string, object> }
  expect(Object.keys(body.questions)).toEqual(['route', 'skill'])
  expect(result.decisions.map(decision => decision.choice)).toEqual(['reader', 'reader'])
  expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 0, cost: 0.0000084 })
  expect(JSON.stringify(result)).not.toContain('fixture-key')
})

it('abstains on low or missing confidence instead of inventing a successful decision', async () => {
  const payload = answer(0.4)
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json(payload))))
  const low = await submitDecision(settings, input, 'fixture-key', [], signal)
  expect(low.decisions[0]).toMatchObject({ status: 'uncertain', choice: null, confidence: 0.4 })
  Reflect.deleteProperty(payload.answers.route, 'confidence')
  const missing = await submitDecision(settings, input, 'fixture-key', [], signal)
  expect(missing.decisions[0]).toMatchObject({ status: 'uncertain', choice: null, confidence: 0 })
})

it('passes only the explicitly selected durable image bytes', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer()))
  vi.stubGlobal('fetch', fetcher)
  const images = [{ attachmentId: 'sha256:fixture', mediaType: 'image/png', data: Uint8Array.from([1, 2, 3]) }]
  const result = await submitDecision(settings, { ...input, image_count: 1 }, 'fixture-key', images, signal)
  const encoded = fetcher.mock.calls[0]?.[1]?.body
  if (typeof encoded !== 'string') throw new Error('Expected JSON request body')
  const body = JSON.parse(encoded) as { state: object[] }
  expect(body.state[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } })
  expect(result.images).toEqual(['sha256:fixture'])
})

it.each([
  ['unknown choice', () => answer(0.95, 'unapproved')],
  ['invalid probability', () => ({ ...answer(), answers: { route: { ...answer().answers.route, probabilities: { reader: 1.3, planner: 0 } } } })],
  ['non-distribution', () => ({ ...answer(), answers: { route: { ...answer().answers.route, probabilities: { reader: 0.1, planner: 0.1 } } } })],
  ['missing answer', () => ({ ...answer(), answers: {} })],
  ['invalid confidence', () => answer(9)],
])('rejects %s without applying a model or workflow change', async (_name, response) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response())))
  await expect(submitDecision(settings, input, 'fixture-key', [], signal)).rejects.toMatchObject({ code: 'DECISION_INVALID_RESPONSE' })
})

it('rejects oversized, disabled and ambiguous inputs before any paid request', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(submitDecision({ ...settings, enabled: false }, input, 'fixture-key', [], signal)).rejects.toMatchObject({ code: 'DECISION_DISABLED' })
  await expect(submitDecision({ ...settings, maxTextBytes: 10 }, input, 'fixture-key', [], signal)).rejects.toMatchObject({ code: 'DECISION_INPUT_LIMIT' })
  await expect(submitDecision(settings, { ...input, questions: [input.questions[0]!, input.questions[0]!] }, 'fixture-key', [], signal)).rejects.toMatchObject({ code: 'DECISION_QUESTION_INVALID' })
  await expect(submitDecision(settings, { ...input, image_count: 1 }, 'fixture-key', [], signal)).rejects.toMatchObject({ code: 'DECISION_IMAGE_LIMIT' })
  expect(fetcher).not.toHaveBeenCalled()
})

it('reports HTTP failure without exposing provider bodies or automatically retrying', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive-provider-body', { status: 402 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(submitDecision(settings, input, 'fixture-key', [], signal)).rejects.toMatchObject({ code: 'DECISION_HTTP' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('propagates caller cancellation and bounds stalled network calls', async () => {
  const fetcher = vi.fn((_url, options: RequestInit) => new Promise((_, reject) => {
    options.signal!.addEventListener('abort', () => { reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error('aborted')) }, { once: true })
  }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new AbortController()
  const pending = submitDecision(settings, input, 'fixture-key', [], controller.signal)
  controller.abort(new Error('caller-stopped'))
  await expect(pending).rejects.toThrow('caller-stopped')
  await expect(submitDecision({ ...settings, timeoutMs: 10 }, input, 'fixture-key', [], signal)).rejects.toMatchObject({ code: 'DECISION_TIMEOUT' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('classifies transport failure without including raw exception detail', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('sensitive-provider-detail')))
  const failure = await submitDecision(settings, input, 'fixture-key', [], signal).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(DecisionError)
  expect(failure).toMatchObject({ code: 'DECISION_TRANSPORT' })
  if (!(failure instanceof DecisionError)) throw new Error('Expected a typed decision failure')
  expect(failure.message).not.toContain('sensitive')
})

it('batches native yes/no and score primitives with conservative confidence', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ model: settings.model, answers: {
    violation: { type: 'noul', noul: 0.8 },
    risk: { type: 'score', score: 1.6, confidence: 0.9, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } },
  } }))
  vi.stubGlobal('fetch', fetcher)
  const result = await submitDecision({ ...settings, minConfidence: 0.3 }, { context: 'Synthetic changed code and review evidence.', questions: [
    { id: 'violation', type: 'noul', question: 'Does the change violate the supplied rule?' },
    { id: 'risk', type: 'score', question: 'How risky is the change?', levels: ['Cosmetic', 'Behavioral', 'Security sensitive'] },
  ] }, 'fixture-key', [], signal)
  expect(result.decisions[0]).toMatchObject({ type: 'noul', noul: 0.8, status: 'decided', choice: null })
  expect(result.decisions[0]?.confidence).toBeCloseTo(0.6)
  expect(result.decisions[1]).toMatchObject({ type: 'score', score: 1.6, status: 'decided', choice: null })
  expect(result.decisions[1]?.confidence).toBeCloseTo(0.4)
  const wire = fetcher.mock.calls[0]?.[1]?.body
  if (typeof wire !== 'string') throw new Error('Expected JSON request')
  const body = JSON.parse(wire) as { questions: Record<string, unknown> }
  expect(body.questions.violation).toEqual({ type: 'noul', instructions: 'Does the change violate the supplied rule?' })
  expect(body.questions.risk).toMatchObject({ criteria: ['Cosmetic', 'Behavioral', 'Security sensitive'] })
})

it('rejects contradictory choices and invalid rubric scores instead of trusting a confidence field', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(answer(0.99, 'planner'))))
  await expect(submitDecision(settings, input, 'fixture-key', [], signal)).rejects.toMatchObject({ code: 'DECISION_INVALID_RESPONSE' })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ model: settings.model, answers: {
    route: { type: 'choice', choice: 'reader', confidence: 1, probabilities: { reader: 0.51, planner: 0.49 } },
  } })))
  expect((await submitDecision(settings, input, 'fixture-key', [], signal)).decisions[0]).toMatchObject({ status: 'uncertain', choice: null })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ model: settings.model, answers: {
    risk: { type: 'score', score: 2, confidence: 1, probabilities: { 0: 1, 1: 0, 2: 0 } },
  } })))
  await expect(submitDecision(settings, { context: 'Evidence', questions: [{ id: 'risk', type: 'score', question: 'Risk?', levels: ['Low', 'Medium', 'High'] }] }, 'fixture-key', [], signal))
    .rejects.toMatchObject({ code: 'DECISION_INVALID_RESPONSE' })
})

it.each([
  { id: 'bad', question: 'Missing options' },
  { id: 'bad', type: 'score', question: 'Missing levels' },
  { id: 'bad', type: 'noul', question: 'Unused options', options: [] },
])('rejects an incomplete typed question before a paid request: $question', async (question) => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(submitDecision(settings, { context: 'Evidence', questions: [question as never] }, 'fixture-key', [], signal))
    .rejects.toMatchObject({ code: 'DECISION_OPTIONS_INVALID' })
  expect(fetcher).not.toHaveBeenCalled()
})
