import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { serialize } from '@deepseek-ai/dsh-llm-deepseek/src/serialize.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import TeamService from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { decisionDefaults, decisionTextBytes, type DecisionAdvisor, type DecisionInput } from '../src/decisions.ts'
import { routeWorkerAssignments } from '../src/worker-skills.ts'
import { routeDecisionWorkers, savedWorkerProfile } from '../src/decision-routing.ts'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'

function serializeRequest(request: GenerateOptions) {
  const connection = resolveAdapterOptions({ models: [{ id: request.model, systemPromptUpdate: 'in-history' }] })
  return serialize(request, connection, request.messages, new Map(), () => undefined)
}

function runtimeContextText(request: GenerateOptions) {
  const context = request.messages.findLast(message => message.source?.kind === 'runtime-context')
  return context?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

const SIGNAL = new AbortController().signal
const TOOL_NAMES = [
  'team_checkpoint', 'team_dispatch', 'team_dispatch_status', 'team_task_report', 'team_dispatch_cancel',
  'select_model_profile',
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
].sort()

const WORKER_TOOL_NAMES = ['send_message', 'list_agents', 'wait_agent', 'team_task_list', 'team_task_get', 'team_task_update', 'team_task_report'].sort()

const roots: string[] = []
const contexts = new Set<Context>()
let callNumber = 0

/** Session query implementation whose search faces are outside these tests. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(script: ConstructorParameters<typeof MockAdapter>[0], legacyControl = false) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-tool-team-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  if (legacyControl) await ctx.plugin(ToolSubagentControl)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService)
  const fiber = await ctx.plugin(toolTeam)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('tool-team-lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, fiber, adapter }
}

function execute(
  ctx: Context,
  agent: Agent | undefined,
  name: string,
  args: unknown,
  signal: AbortSignal = SIGNAL,
) {
  return executeToolFixture(ctx, {
    callId: ToolCallId(`team-call-${++callNumber}`),
    name,
    arguments: args,
    signal,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function spawnedChildId(ctx: Context, lead: Agent, result: Awaited<ReturnType<typeof execute>>): SessionId {
  const parsed = JSON.parse(text(result)) as { member: { target: string } }
  const member = ctx.agentTeams.listMembers(lead).find(member => member.name === parsed.member.target)
  if (member === undefined) throw new Error('spawn_teammate target has no roster member')
  return member.id
}

async function assembly(ctx: Context, agent: Agent) {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  return ctx.systemPrompt.assemble({ scope })
}

async function runTurn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

async function waitRunning(ctx: Context, id: SessionId): Promise<Agent> {
  return vi.waitFor(() => {
    const child = ctx.agents.get(id)
    expect(child?.status).toBe('running')
    return child!
  }, { timeout: 5_000 })
}

async function waitNoAgent(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

describe('dsh-tool-team', () => {
  it.each(['running', 'inactive', 'provisioning', 'failed'] as const)(
    'projects %s members consistently in creation, listing, and schemas', async (status) => {
      const { ctx, lead } = await setup([])
      const member = {
        id: SessionId('private-member-session'), name: 'reviewer', role: 'teammate' as const,
        status, description: 'review changes', diagnostics: [],
      }
      vi.spyOn(ctx.agentTeams, 'spawnTeammate').mockResolvedValue({ member })
      vi.spyOn(ctx.agentTeams, 'listMembers').mockReturnValue([member])
      const expected = {
        target: 'reviewer', role: 'teammate', status,
        description: 'review changes', diagnostics: [],
      }
      const spawned = await execute(ctx, lead, 'spawn_teammate', {
        name: 'reviewer', description: 'review changes', prompt: 'review',
      })
      const listed = await execute(ctx, lead, 'list_agents', {})
      expect(spawned.isError).toBe(false)
      expect(listed.isError).toBe(false)
      expect(JSON.parse(text(spawned))).toEqual({ member: expected })
      expect(JSON.parse(text(listed))).toEqual([expected])
      const scope = scopeOf(lead.ctx)
      const spawnSchema = ctx.tools.get('spawn_teammate', scope)?.output.schema.properties?.member
      const listSchema = ctx.tools.get('list_agents', scope)?.output.schema.items
      for (const schema of [spawnSchema, listSchema]) {
        expect(schema?.properties).toHaveProperty('target')
        expect(schema?.properties).not.toHaveProperty('id')
        expect(schema?.properties).not.toHaveProperty('name')
        expect(schema?.properties?.status?.enum).toEqual(['running', 'inactive', 'provisioning', 'failed'])
      }
      expect(ctx.agentTeams.listMembers(lead)).toEqual([member])
    },
  )

  it.each(['running', 'inactive'] as const)('returns interrupted %s status', async (previousStatus) => {
    const { ctx, lead } = await setup([])
    const interrupt = vi.spyOn(ctx.agentTeams, 'interrupt').mockReturnValue({ previousStatus })
    const result = await execute(ctx, lead, 'interrupt_agent', { target: 'reviewer' })
    expect(JSON.parse(text(result))).toEqual({ previousStatus })
    expect(interrupt).toHaveBeenCalledWith(lead, 'reviewer')
  })

  it('omits interrupt tools and guidance for Leads and new teammates when disabled', async () => {
    const { ctx, lead, fiber } = await setup(['hang'])
    await fiber.dispose()
    await ctx.plugin(toolTeam, { interrupt: false })
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'worker', description: 'stay active', prompt: 'wait',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)
    for (const agent of [lead, child]) {
      const assembled = await assembly(ctx, agent)
      expect(assembled.tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
        .toEqual(agent === lead ? TOOL_NAMES.filter(name => name !== 'interrupt_agent') : WORKER_TOOL_NAMES)
      expect(renderPrompt(assembled)).not.toContain('interrupt_agent')
      const result = await execute(ctx, agent, 'interrupt_agent', { target: 'worker' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('unknown tool "interrupt_agent"')
    }
    expect(child.status).toBe('running')
    expect((await execute(ctx, lead, 'list_agents', {})).isError).toBe(false)
    expect(ctx.agentTeams.interrupt(lead, 'worker')).toEqual({ previousStatus: 'running' })
    await waitNoAgent(ctx, childId)
  })

  it('uses returned targets for messages, interruption, and task assignment', async () => {
    const { ctx, lead } = await setup(['hang', 'hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review changes', prompt: 'wait for work',
    })
    const { member } = JSON.parse(text(spawned)) as { member: { target: string } }
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)
    expect(member).not.toHaveProperty('id')
    expect(member).not.toHaveProperty('name')
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_agents', {}))) as Array<{ target: string }>
    expect(listed.map(row => row.target)).toEqual(['lead', member.target])
    const created = await execute(ctx, lead, 'team_task_create', { subject: 'review', description: 'review changes' })
    const task = JSON.parse(text(created)) as { id: string; revision: number }
    const assigned = await execute(ctx, lead, 'team_task_update', {
      task_id: task.id, expected_revision: task.revision, action: 'reassign', owner: member.target,
    })
    expect(assigned.isError).toBe(false)
    expect(JSON.parse(text(assigned))).toMatchObject({ ownerName: member.target })
    const tasks = await execute(ctx, lead, 'team_task_list', { owner: listed[1]!.target })
    expect(JSON.parse(text(tasks))).toMatchObject({ tasks: [{ id: task.id, ownerName: member.target }] })
    const sent = await execute(ctx, lead, 'send_message', { target: member.target, message: 'review the diff' })
    expect(sent.isError).toBe(false)
    expect(JSON.parse(text(sent))).toEqual({ sent: true })
    const interrupted = await execute(ctx, lead, 'interrupt_agent', { target: listed[1]!.target })
    expect(interrupted.isError).toBe(false)
    await child.whenIdle()
    expect(child.status).toBe('idle')
    expect(ctx.agentTeams.interrupt(lead, member.target)).toEqual({ previousStatus: 'inactive' })
    const stored = await execute(ctx, lead, 'list_agents', {})
    expect(JSON.parse(text(stored))).toContainEqual(expect.objectContaining({ target: member.target, status: 'inactive' }))
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ id: childId, name: member.target, status: 'inactive' })
  })

  it('gives workers scoped tools and a compact policy without supervisor context', async () => {
    const { ctx, lead } = await setup(['hang'])
    const leadAssembly = await assembly(ctx, lead)
    expect(leadAssembly.tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    const leadPrompt = renderPrompt(leadAssembly)
    expect(leadPrompt).toContain('Agent Teams is available in this session\n\n')
    expect(leadPrompt).toContain('FS_STALE_VERSION')
    expect(leadPrompt).toContain('Bash, formatters, code generators, and scripts are not fully protected')
    expect(leadPrompt).toContain('Task readiness starts only explicitly authorized team_dispatch assignments')
    expect(leadPrompt).toContain('returns noProgress immediately')
    expect(leadPrompt).not.toContain('Your Team role')
    expect(renderContextSnapshot(leadAssembly)).toContain('You are the Team Lead named "lead".')

    await ctx.agentTeams.updateCheckpoint(lead, { expectedRevision: 0, goal: 'unrelated supervisor goal', constraints: ['supervisor-only context'], nextActions: ['another assignment'] })
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'tool-worker',
      description: 'exercise scoped tools',
      prompt: 'stay available',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)
    const childAssembly = await assembly(ctx, child)
    expect(childAssembly.tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(WORKER_TOOL_NAMES)
    const childPrompt = renderPrompt(childAssembly)
    expect(childPrompt).toContain('Complete only your assigned task')
    expect(childPrompt).not.toContain('Approved worker profiles')
    expect(Buffer.byteLength(childPrompt)).toBeLessThan(Buffer.byteLength(leadPrompt) / 2)
    expect(childAssembly.contexts.find(context => context.name === 'team:checkpoint')?.text ?? '').toBe('')
    expect(renderContextSnapshot(childAssembly)).toContain('You are teammate "tool-worker".')
    expect(renderContextSnapshot(childAssembly)).not.toContain('unrelated supervisor goal')
    const automatic = await child.ctx.waterfall('skills/select-automatic', { agent: child, task: 'Implement dashboard behavior', signal: SIGNAL }, () => Promise.resolve(['design-distinctive-frontends']))
    expect(automatic).toEqual([])
    expect(await child.ctx.waterfall('skills/select-automatic', { agent: child, task: 'Diagnose an assigned failure', signal: SIGNAL }, () => Promise.resolve(['diagnosing-bugs']))).toEqual(['diagnosing-bugs'])
    expect(childAssembly.contexts).toContainEqual(expect.objectContaining({ name: 'team:identity' }))
    const initialPrompt = child.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.source.kind === 'user')
    expect(initialPrompt?.type === 'user/message'
      ? initialPrompt.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : []).toEqual(['stay available'])

    const denied = await execute(ctx, child, 'spawn_teammate', {
      name: 'nested', description: 'not allowed', prompt: 'no',
    })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain('unknown tool')
    await execute(ctx, lead, 'interrupt_agent', { target: 'tool-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it.each([
    ['fresh', undefined], ['fork', undefined], ['fork', 'in-history'],
  ] as const)('records %s teammate identity with update mode %s and keeps the wire prefix', async (mode, systemPromptUpdate) => {
    const { ctx, lead, adapter } = await setup([textResponse('parent answer'), textResponse('child answer')])
    if (systemPromptUpdate !== undefined) adapter.systemPromptUpdate = systemPromptUpdate
    await runTurn(lead, 'Parent task')
    const parentRequest = serializeRequest(adapter.requests[0]!)
    const parentHistory = structuredClone(lead.session.deriveMessages())
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work', context: mode,
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    const childId = spawnedChildId(ctx, lead, spawned)
    await waitNoAgent(ctx, childId)
    const childRequest = serializeRequest(adapter.requests[1]!)
    expect(childRequest.tools?.map(tool => tool.name).sort()).toEqual(WORKER_TOOL_NAMES)
    expect(childRequest.system).not.toEqual(parentRequest.system)
    expect(childRequest.system).not.toContain('Your Team role')
    if (mode === 'fork') {
      expect(childRequest.messages.slice(0, parentRequest.messages.length)).toEqual(parentRequest.messages)
      expect(adapter.requests[1]!.messages.slice(0, parentHistory.length).filter(message => message.role !== 'system')).toEqual(parentHistory.filter(message => message.role !== 'system'))
    } else {
      expect(JSON.stringify(childRequest.messages)).not.toContain('Parent task')
    }
    expect(runtimeContextText(adapter.requests[1]!)).toContain('You are teammate "reviewer".')
    expect(childRequest.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'Review the work' })
    await using persisted = await ctx.sessionPersistence.open(childId, 'read')
    const { events } = await persisted.read()
    const initial = events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(initial?.type === 'user/message' ? initial.data.content : []).toEqual([
      { type: 'text', text: 'Review the work' },
    ])
  })

  it('reuses unchanged Lead identity in an ordinary Lead fork', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('parent answer'), textResponse('fork answer')])
    await runTurn(lead, 'Parent task')
    const seed = lead.session.snapshotEvents()
    const childId = SessionId('ordinary-team-fork')
    const handle = await ctx.agents.create({
      sessionId: childId,
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { parentSession: lead.id, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: SIGNAL,
    })
    await runTurn(handle.agent, 'Continue independently')
    const parentRequest = serializeRequest(adapter.requests[0]!)
    const childRequest = serializeRequest(adapter.requests[1]!)
    expect(childRequest.tools).toEqual(parentRequest.tools)
    expect(childRequest.messages.slice(0, parentRequest.messages.length)).toEqual(parentRequest.messages)
    expect(childRequest.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'Continue independently' })
    expect(JSON.stringify(childRequest.messages)).not.toContain('system-reminder')
    expect(handle.agent.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)
    expect(ctx.agentTeams.listMembers(handle.agent).map(member => member.name)).toEqual(['lead'])
    await handle.dispose()
  })

  it.each([undefined, 'in-history'] as const)('appends current Lead identity to a teammate fork with update mode %s', async (systemPromptUpdate) => {
    const { ctx, lead, adapter } = await setup([textResponse('review done'), textResponse('lead notified'), textResponse('fork answer')])
    if (systemPromptUpdate !== undefined) adapter.systemPromptUpdate = systemPromptUpdate
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work',
    })
    const teammateId = spawnedChildId(ctx, lead, spawned)
    await waitNoAgent(ctx, teammateId)
    await using persisted = await ctx.sessionPersistence.open(teammateId, 'read')
    const { events: seed } = await persisted.read()
    const handle = await ctx.agents.create({
      sessionId: SessionId('fork-from-teammate'),
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { parentSession: teammateId, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: SIGNAL,
    })
    try {
      const inheritedHistory = structuredClone(handle.agent.session.deriveMessages())
      await runTurn(handle.agent, 'Continue independently')
      const original = serializeRequest(adapter.requests.find(request => request.sessionId === teammateId)!)
      const forkRequest = adapter.requests.find(request => request.sessionId === handle.agent.id)!
      const fork = serializeRequest(forkRequest)
      expect(fork.tools?.map(tool => tool.name).sort()).toEqual(TOOL_NAMES)
      expect(fork.tools).not.toEqual(original.tools)
      expect(fork.messages.slice(0, original.messages.length)).toEqual(original.messages)
      expect(forkRequest.messages.slice(0, inheritedHistory.length).filter(message => message.role !== 'system')).toEqual(inheritedHistory.filter(message => message.role !== 'system'))
      expect(fork.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'Continue independently' })
      expect(runtimeContextText(forkRequest)).toContain('You are the Team Lead named "lead".')
      expect(handle.agent.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)
    } finally {
      await handle.dispose()
    }
  })

  it('restores compacted identity and does not repeat an unchanged retained snapshot', async () => {
    const { ctx, lead, adapter } = await setup([
      toolCallResponse('first-list', 'list_agents', {}),
      toolCallResponse('second-list', 'list_agents', {}),
      textResponse('done'),
    ])
    ctx.on('agent/pre-step', async ({ agent, step }, next) => {
      if (step === 3) {
        const identity = agent.session.snapshotEvents().find(event => event.type === 'user/message'
          && event.data.source.kind === 'runtime-context')
        if (identity === undefined) throw new Error('expected teammate runtime context')
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'Compacted earlier context.' }],
          source: { kind: 'test-compaction' },
        }), {
          surfaceOp: { op: 'replace', startSeq: identity.seq, endSeq: identity.seq },
          sourceEventSeqs: [identity.seq],
        })
      }
      return next()
    })
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    await waitNoAgent(ctx, childId)
    for (const request of adapter.requests.filter(request => request.sessionId === childId)) {
      const snapshots = request.messages.filter(message => message.source?.kind === 'runtime-context')
      expect(snapshots).toHaveLength(1)
      expect(runtimeContextText(request)).toContain('You are teammate "reviewer".')
    }
    await using persisted = await ctx.sessionPersistence.open(childId, 'read')
    const { events } = await persisted.read()
    expect(events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'runtime-context')).toHaveLength(2)
  })

  it.each(['reject', 'empty', 'abort'] as const)('does not revive a teammate step after %s', async (mode) => {
    const { ctx, lead, adapter } = await setup([])
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (agent === lead) return decision
      if (mode === 'reject') return { kind: 'reject' }
      if (mode === 'abort') agent.cancel({ kind: 'user' })
      return { kind: 'enter', messages: [] }
    })
    await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work',
    })
    const childId = SessionId(ctx.agentTeams.listMembers(lead).find(member => member.name === 'reviewer')!.id)
    await waitNoAgent(ctx, childId)
    expect(adapter.requests.filter(request => request.sessionId === childId)).toEqual([])
    await using persisted = await ctx.sessionPersistence.open(childId, 'read')
    const { events } = await persisted.read()
    expect(events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user')).toEqual([])
  })

  it('keeps required Team identities when optional runtime context is suppressed', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('worker done')])
    ctx.systemPrompt.suppressRuntimeContext()
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    await waitNoAgent(ctx, spawnedChildId(ctx, lead, spawned))
    expect(renderContextSnapshot(await assembly(ctx, lead))).toContain('You are the Team Lead named "lead".')
    expect(runtimeContextText(adapter.requests[0]!)).toContain('You are teammate "reviewer".')
  })

  it('returns actionable no-progress output and renders structured wait cancellation', async () => {
    const inactiveSetup = await setup([textResponse('worker done')])
    const inactiveSpawn = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'spawn_teammate', {
      name: 'inactive-worker', description: 'finish immediately', prompt: 'finish',
    })
    const inactiveId = spawnedChildId(inactiveSetup.ctx, inactiveSetup.lead, inactiveSpawn)
    await waitNoAgent(inactiveSetup.ctx, inactiveId)
    const noProgress = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'wait_agent', { timeout_ms: 3_600_000 })
    expect(noProgress.isError).toBe(false)
    expect(JSON.parse(text(noProgress))).toEqual({
      timedOut: false,
      noProgress: {
        reason: 'no-active-peer',
        message: 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.',
      },
    })
    for (const timeout_ms of [9_999, 3_600_001, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'wait_agent', { timeout_ms })
      expect(invalid.isError).toBe(true)
      expect(text(invalid)).toContain('timeoutMs must be an integer from 10000 through 3600000')
    }

    const activeSetup = await setup(['hang'])
    const activeSpawn = await execute(activeSetup.ctx, activeSetup.lead, 'spawn_teammate', {
      name: 'active-worker', description: 'stay active', prompt: 'wait',
    })
    const activeId = spawnedChildId(activeSetup.ctx, activeSetup.lead, activeSpawn)
    await waitRunning(activeSetup.ctx, activeId)
    const controller = new AbortController()
    const waiting = execute(activeSetup.ctx, activeSetup.lead, 'wait_agent', { timeout_ms: 10_000 }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort({ kind: 'user' })
    const aborted = await waiting
    expect(aborted.isError).toBe(true)
    expect(text(aborted)).toBe("Error: wait_agent aborted: { kind: 'user' }")
    await execute(activeSetup.ctx, activeSetup.lead, 'interrupt_agent', { target: 'active-worker' })
    await waitNoAgent(activeSetup.ctx, activeId)
  })

  it('adapts roster, mailbox, wait, and task CAS operations to canonical JSON', async () => {
    const { ctx, lead } = await setup(['hang', textResponse('lead received wakeup')])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'json-worker', description: 'json worker', prompt: 'wait', context: 'fresh',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)

    const roster = await execute(ctx, child, 'list_agents', {})
    expect(JSON.parse(text(roster))).toMatchObject([
      { target: 'lead', role: 'lead' },
      { target: 'json-worker', role: 'teammate' },
    ])
    // Every Team result reaches the model as compact JSON: indentation would
    // spend tokens on every roster, task, and receipt without adding meaning.
    expect(text(roster)).toBe(JSON.stringify(JSON.parse(text(roster))))
    const peer = await execute(ctx, child, 'send_message', { target: 'lead', message: 'progress report' })
    expect(peer.isError).toBe(false)
    expect(JSON.parse(text(peer))).toEqual({ sent: true })
    const followup = await execute(ctx, child, 'send_message', { target: 'lead', message: 'review the report' })
    expect(followup.isError).toBe(false)
    expect(JSON.parse(text(followup))).toEqual({ sent: true })
    await lead.whenIdle()

    const created = await execute(ctx, lead, 'team_task_create', {
      subject: 'tool task',
      description: 'created through tool',
      blocked_by: [],
      write_scopes: ['src/team'],
    })
    const task = JSON.parse(text(created)) as { id: string; revision: number }
    const listed = await execute(ctx, child, 'team_task_list', { ready: true, limit: 1 })
    expect(JSON.parse(text(listed))).toMatchObject({ tasks: [{ id: task.id, ready: true }] })
    const read = await execute(ctx, child, 'team_task_get', { task_id: task.id })
    expect(JSON.parse(text(read))).toMatchObject({ id: task.id, revision: 1, description: 'created through tool' })
    expect(text(created)).not.toContain('created through tool')
    expect(text(listed)).not.toContain('created through tool')
    const claimed = await execute(ctx, child, 'team_task_update', {
      task_id: task.id,
      expected_revision: task.revision,
      action: 'claim',
    })
    expect(JSON.parse(text(claimed))).toMatchObject({ status: 'in_progress', ownerName: 'json-worker' })
    expect(text(claimed)).not.toContain('created through tool')
    const stale = await execute(ctx, lead, 'team_task_update', {
      task_id: task.id,
      expected_revision: task.revision,
      action: 'delete',
    })
    expect(stale.isError).toBe(true)
    expect(text(stale)).toContain('stale team task')

    const wait = execute(ctx, lead, 'wait_agent', { timeout_ms: 10_000 })
    const completedCall = new Promise<Awaited<ReturnType<typeof execute>>>((resolve, reject) => {
      setTimeout(() => {
        void execute(ctx, child, 'team_task_update', {
          task_id: task.id,
          expected_revision: 2,
          action: 'complete',
        }).then(resolve, reject)
      }, 0)
    })
    await expect(wait).resolves.toMatchObject({ isError: false })
    expect((await completedCall).isError).toBe(false)

    const childInterrupt = await execute(ctx, child, 'interrupt_agent', { target: 'json-worker' })
    expect(childInterrupt.isError).toBe(true)
    await execute(ctx, lead, 'interrupt_agent', { target: 'json-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('adapts optional task filters, mutations, pagination, and default waiting', async () => {
    const { ctx, lead } = await setup(['hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'fork-worker', description: 'fork worker', prompt: 'stay active', context: 'fork',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    await waitRunning(ctx, childId)

    const firstResult = await execute(ctx, lead, 'team_task_create', {
      subject: 'first', description: 'first task',
    })
    const secondResult = await execute(ctx, lead, 'team_task_create', {
      subject: 'second', description: 'second task',
    })
    const first = JSON.parse(text(firstResult)) as { id: string; revision: number }
    const second = JSON.parse(text(secondResult)) as { id: string; revision: number }
    const claimed = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id, expected_revision: first.revision, action: 'claim',
    })
    const claim = JSON.parse(text(claimed)) as { revision: number }

    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      status: 'in_progress', owner: 'lead', cursor: 0, limit: 1,
    })))).toMatchObject({ tasks: [{ id: first.id }] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      owner: 'unowned', limit: 1,
    })))).toMatchObject({ tasks: [{ id: second.id }] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      cursor: 0, limit: 1,
    })))).toMatchObject({ nextCursor: 1 })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      cursor: 1,
    })))).not.toHaveProperty('nextCursor')
    expect((await execute(ctx, lead, 'team_task_list', { cursor: -1 })).isError).toBe(true)
    expect((await execute(ctx, lead, 'team_task_list', { limit: 101 })).isError).toBe(true)

    const edited = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: claim.revision,
      action: 'edit',
      subject: 'edited',
      description: 'edited description',
      write_scopes: ['src/team'],
    })
    const edit = JSON.parse(text(edited)) as { revision: number }
    const dependencies = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: edit.revision,
      action: 'set_dependencies',
      blocked_by: [second.id],
    })
    expect(dependencies.isError).toBe(false)
    const dependency = JSON.parse(text(dependencies)) as { revision: number }
    expect((await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: dependency.revision,
      action: 'reassign',
      owner: 'fork-worker',
    })).isError).toBe(true)

    const wait = execute(ctx, lead, 'wait_agent', {})
    const wake = new Promise<Awaited<ReturnType<typeof execute>>>((resolve, reject) => {
      setTimeout(() => {
        void execute(ctx, lead, 'team_task_create', {
          subject: 'wake', description: 'wake default wait',
        }).then(resolve, reject)
      }, 0)
    })
    expect((await wait).isError).toBe(false)
    expect((await wake).isError).toBe(false)

    await execute(ctx, lead, 'interrupt_agent', { target: 'fork-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('removes and reinstalls every scoped registration across plugin HMR without stopping the child', async () => {
    const { ctx, lead, fiber } = await setup(['hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'hmr-worker', description: 'hmr worker', prompt: 'wait',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)

    await fiber.dispose()
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name).some(name => TOOL_NAMES.includes(name))).toBe(false)
    expect((await assembly(ctx, child)).tools.map(schema => schema.name).some(name => TOOL_NAMES.includes(name))).toBe(false)
    expect(ctx.agents.get(childId)).toBe(child)
    for (const agent of [lead, child]) {
      expect((await assembly(ctx, agent)).contexts.some(context => context.name === 'team:identity')).toBe(false)
    }

    const disabled = await ctx.plugin(toolTeam, { interrupt: false })
    for (const agent of [lead, child]) {
      const assembled = await assembly(ctx, agent)
      expect(assembled.tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
        .toEqual(agent === lead ? TOOL_NAMES.filter(name => name !== 'interrupt_agent') : WORKER_TOOL_NAMES)
      expect(renderPrompt(assembled)).not.toContain('interrupt_agent')
    }
    expect(child.status).toBe('running')
    await disabled.dispose()

    const replacement = await ctx.plugin(toolTeam)
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    expect((await assembly(ctx, child)).tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(WORKER_TOOL_NAMES)
    await execute(ctx, lead, 'interrupt_agent', { target: 'hmr-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
    await replacement.dispose()
  })

  it('shadows legacy global control names only inside Team member scopes', async () => {
    const { ctx, lead, fiber } = await setup([], true)
    const teamSchema = (await assembly(ctx, lead)).tools.find(schema => schema.name === 'send_message')
    expect(JSON.stringify(teamSchema)).toContain('target')
    expect(JSON.stringify(teamSchema)).not.toContain('subagent_id')

    await fiber.dispose()
    const legacySchema = (await assembly(ctx, lead)).tools.find(schema => schema.name === 'send_message')
    expect(JSON.stringify(legacySchema)).toContain('agent_id')
  })

  it('limits worker global tools without hiding execution tools, changing the Lead or surviving HMR disposal', async () => {
    const { ctx, lead, fiber } = await setup(['hang'], true)
    await fiber.dispose()
    for (const name of ['read_fixture', 'unrelated_management']) ctx.tools.register(defineContentToolFixture({
      name, description: name, parameters: {}, async execute() { return [{ type: 'text', text: name }] },
    }))
    const restricted = await ctx.plugin(toolTeam, { workerTools: ['read_fixture'] })
    const spawned = await execute(ctx, lead, 'spawn_teammate', { name: 'scoped-worker', description: 'read one input', prompt: 'read fixture' })
    expect(spawned.isError, text(spawned)).toBe(false)
    const child = await waitRunning(ctx, spawnedChildId(ctx, lead, spawned))
    const names = (await assembly(ctx, child)).tools.map(tool => tool.name)
    expect(names).toContain('read_fixture')
    expect(names).toContain('team_task_report')
    expect(names).not.toContain('unrelated_management')
    expect(names).not.toContain('spawn_teammate')
    expect((await execute(ctx, child, 'unrelated_management', {})).isError).toBe(true)
    expect((await execute(ctx, child, 'read_fixture', {})).isError).toBe(false)
    expect((await assembly(ctx, lead)).tools.map(tool => tool.name)).toContain('unrelated_management')
    await restricted.dispose()
    expect((await assembly(ctx, child)).tools.map(tool => tool.name)).toContain('unrelated_management')
    ctx.agentTeams.interrupt(lead, 'scoped-worker')
  })

  it('rolls back partial scoped installation after a same-scope collision', async () => {
    const { ctx, lead, fiber } = await setup([])
    await fiber.dispose()
    lead.ctx.tools.register(defineContentToolFixture({
      name: 'spawn_teammate',
      description: 'intentional collision',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'collision' }] },
    }))

    await expect(ctx.plugin(toolTeam)).rejects.toThrow(/already registered/u)
    const assembled = await assembly(ctx, lead)
    expect(assembled.tools.filter(schema => TOOL_NAMES.includes(schema.name)).map(schema => schema.name))
      .toEqual(['spawn_teammate'])
    expect(assembled.contexts.some(context => context.name === 'team:identity')).toBe(false)
  })

  it('resolves direct-apply defaults without Loader schema normalization', async () => {
    const { ctx, lead, fiber, adapter } = await setup([textResponse('ordinary child')])
    await fiber.dispose()
    toolTeam.apply(ctx, {})
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    const ordinary = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'ordinary child',
      request: { prompt: [{ type: 'text', text: 'finish' }], parent: lead },
      signal: SIGNAL,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(ordinary.childId)).toBeUndefined() }, { timeout: 5_000 })
    const request = adapter.requests.find(request => request.sessionId === ordinary.childId)
    expect(request).toBeDefined()
    expect(JSON.stringify(request?.messages)).not.toContain('You are the Team Lead')
  })

  it.each([true, false])('reinstalls Team scope with interrupt=%s before a cold-resumed request', async (interrupt) => {
    const { ctx, lead, adapter, fiber } = await setup([textResponse('first'), textResponse('lead received settlement'), 'hang'])
    await fiber.dispose()
    await ctx.plugin(toolTeam, { interrupt })
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'cold-worker', description: 'cold worker', prompt: 'finish once',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
    expect(await ctx.subagents.listChildren(lead.id)).toContainEqual(expect.objectContaining({
      id: childId,
      mode: 'continuable',
    }))
    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.sessionId === lead.id)).toHaveLength(1)
    })
    await lead.whenIdle()

    const receipt = await ctx.agentTeams.sendMessage(lead, {
      target: 'cold-worker',
      content: [{ type: 'text', text: 'resume with Team scope' }],
      signal: SIGNAL,
    })
    expect(receipt.messageId).toEqual(expect.any(String))
    const resumed = await waitRunning(ctx, childId)
    expect((await assembly(ctx, resumed)).tools.map(schema => schema.name)
      .filter(name => TOOL_NAMES.includes(name)).sort()).toEqual(WORKER_TOOL_NAMES)
    expect(renderPrompt(await assembly(ctx, resumed))).not.toContain('interrupt_agent')
    expect(renderContextSnapshot(await assembly(ctx, resumed))).toContain('You are teammate "cold-worker".')
    const childRequests = () => adapter.requests.filter(request => request.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes('You are teammate "cold-worker".'))))
    await vi.waitFor(() => { expect(childRequests()).toHaveLength(2) })
    const firstMessages = childRequests()[0]!.messages
    expect(childRequests()[1]!.messages.slice(0, firstMessages.length)).toEqual(firstMessages)
    expect(resumed.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user')).toHaveLength(1)
    ctx.agentTeams.interrupt(lead, 'cold-worker')
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('fails safely without a calling Agent and has the function-plugin export shape', async () => {
    const { ctx } = await setup([])
    const result = await execute(ctx, undefined, 'list_agents', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown tool "list_agents"')
    expect('default' in toolTeam).toBe(false)
    expect(toolTeam.name).toBe('tool-agent-team')
    expect(toolTeam.inject).toEqual(['agents', 'agentTeams', 'tools', 'systemPrompt'])
  })

  it('uses configured fresh and fork provider names', async () => {
    const { ctx, lead, fiber } = await setup([textResponse('custom')])
    await fiber.dispose()
    await ctx.plugin(SubagentSpawn, { providerName: 'team-fresh' })
    await ctx.plugin(toolTeam, { freshProvider: 'team-fresh', forkProvider: 'fork' })
    const result = await execute(ctx, lead, 'spawn_teammate', {
      name: 'custom-provider', description: 'custom provider', prompt: 'go',
    })
    expect(result.isError).toBe(false)
    const childId = spawnedChildId(ctx, lead, result)
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ provider: 'team-fresh' })
  })
})


describe('coding-team delegation settings', () => {
  it('uses an approved inexpensive worker route instead of inheriting the Lead model', async () => {
    const { ctx, lead, fiber } = await setup(['hang'])
    await fiber.dispose()
    await ctx.plugin(toolTeam, { coding: {
      requireTaskBrief: false, defaultWorkerProfile: 'reader',
      workerProfiles: { reader: { provider: 'mock', model: 'small-worker', maxTokens: 512 } },
    } } as never)
    const result = await execute(ctx, lead, 'spawn_teammate', { name: 'reader', description: 'read one file', prompt: 'Read the named file and report the exported function.' })
    expect(result.isError).toBe(false)
    const childId = spawnedChildId(ctx, lead, result)
    await vi.waitFor(() => { expect(ctx.agents.get(childId)?.options).toMatchObject({ provider: 'mock', model: 'small-worker', maxTokens: 512 }) })
  })

  it('refuses unscoped, blocked, and unknown-profile delegation before starting a worker', async () => {
    const { ctx, lead, fiber } = await setup([])
    await fiber.dispose()
    await ctx.plugin(toolTeam, { coding: { requireTaskBrief: true, defaultWorkerProfile: '', workerProfiles: {} } } as never)
    const args = { name: 'reader', description: 'read file', prompt: 'Read file' }
    expect(text(await execute(ctx, lead, 'spawn_teammate', args))).toContain('complete assignment brief')
    expect(text(await execute(ctx, lead, 'spawn_teammate', { ...args, model_profile: 'missing' }))).toContain('Unknown worker model profile')
    const blocker = await ctx.agentTeams.createTask(lead, { subject: 'dependency', description: 'unfinished' })
    const task = await ctx.agentTeams.createTask(lead, { subject: 'blocked', description: 'unfinished', blockedBy: [blocker.id] })
    expect(text(await execute(ctx, lead, 'spawn_teammate', { ...args, task_id: task.id }))).toContain('not ready')
    const ready = await ctx.agentTeams.createTask(lead, { subject: 'ready', description: 'vague order' })
    expect(text(await execute(ctx, lead, 'spawn_teammate', { ...args, task_id: ready.id }))).toContain('Objective section')
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)
  })
})


it('starts a ready scoped assignment and reserves acceptance for the supervisor', async () => {
  const { ctx, lead, fiber, adapter } = await setup(['hang'])
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { requireTaskBrief: true, defaultWorkerProfile: '', workerProfiles: {} } } as never)
  const description = ['Objective', 'Inputs', 'Scope', 'Acceptance', 'Verification', 'Stop conditions'].map(heading => `## ${heading}\nConcrete ${heading.toLowerCase()} for this task.`).join('\n\n')
  const task = await ctx.agentTeams.createTask(lead, { subject: 'Inspect one file', description })
  const started = await execute(ctx, lead, 'spawn_teammate', { name: 'reader', description: 'inspect one file', prompt: 'Execute the scoped assignment.', task_id: task.id })
  expect(started.isError).toBe(false)
  const id = spawnedChildId(ctx, lead, started)
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeDefined() })
  const worker = ctx.agents.get(id)!
  await vi.waitFor(() => {
    const request = adapter.requests.find(request => request.sessionId === id)
    expect(request).toBeDefined()
    expect(JSON.stringify(request?.messages)).toContain(`Claim ${task.id} with expected_revision ${task.revision}`)
  })
  const claimed = await ctx.agentTeams.updateTask(worker, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
  const completion = { task_id: task.id, expected_revision: claimed.revision, action: 'complete' }
  expect(text(await execute(ctx, worker, 'team_task_update', { ...completion, evidence: 'File inspected.' }))).toContain('Only the supervisor')
  expect(text(await execute(ctx, lead, 'team_task_update', completion))).toContain('verification evidence')
  expect((await execute(ctx, lead, 'team_task_update', { ...completion, evidence: 'Reviewed the returned file references and confirmed the exported signature.' })).isError).toBe(false)
  expect(ctx.agentTeams.getTask(lead, task.id).status).toBe('completed')
})


it('records approved profile changes for the next step without changing the global default', async () => {
  const { ctx, lead, fiber } = await setup([])
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { requireTaskBrief: false, defaultWorkerProfile: 'reader', workerProfiles: {
    reader: { provider: 'mock', model: 'mock' }, planner: { provider: 'mock', model: 'planner' },
  } } } as never)
  const selected = await execute(ctx, lead, 'select_model_profile', { profile: 'planner', reason: 'The requested migration needs an architecture decision.' })
  expect(selected.isError).toBe(false)
  expect(lead.model.current()).toMatchObject({ provider: 'mock', model: 'planner' })
  expect(lead.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(true)
  expect((await execute(ctx, lead, 'select_model_profile', { profile: 'unapproved', reason: 'test' })).isError).toBe(true)
})


it('keeps decision calls optional and enforces the per-turn request budget', async () => {
  const args = { context: 'Choose the sufficient approved role for this synthetic exact edit.', questions: [{
    id: 'route', question: 'Which role is sufficient?', options: [
      { id: 'reader', description: 'Routine work' }, { id: 'planner', description: 'Difficult architecture' },
    ],
  }] }
  const { ctx, lead, fiber, adapter } = await setup([
    toolCallResponse('decision-one', 'coding_decide', args),
    toolCallResponse('decision-two', 'coding_decide', args),
    textResponse('The supervisor continues without another decision request.'),
  ])
  await ctx.plugin(MemoryCredentials, { OPENROUTER_API_KEY: 'fixture-key' })
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: {
    requireTaskBrief: false, defaultWorkerProfile: '', workerProfiles: {},
    decisions: { ...decisionDefaults, enabled: true, maxCallsPerTurn: 1 },
  } } as never)
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(Response.json({
    model: 'typesafe/jev-test', answers: { route: {
      type: 'choice', choice: 'reader', confidence: 0.99, probabilities: { reader: 1, planner: 0 },
    } },
  })))
  vi.stubGlobal('fetch', fetcher)
  try {
    await runTurn(lead, 'Exercise the two synthetic decision tool calls in the recording.')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(adapter.requests[0]?.tools?.some(tool => tool.name === 'coding_decide')).toBe(true)
    expect(JSON.stringify(lead.session.snapshotEvents())).toContain('Decision request budget reached')
    expect(lead.model.current()).toMatchObject({ provider: 'mock', model: 'mock' })
  } finally { vi.unstubAllGlobals() }
})

it('uses the local advisor tool without a hosted credential service', async () => {
  const args = { context: 'Read a file and list its exports.', questions: [{
    id: 'route', question: 'Which responsibility?', options: [{ id: 'reader', description: 'Read only' }, { id: 'planner', description: 'Plan architecture' }],
  }] }
  const { ctx, lead, fiber } = await setup([
    toolCallResponse('local-decision', 'coding_decide', args), textResponse('Continue with the selected responsibility.'),
  ])
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { requireTaskBrief: false, defaultWorkerProfile: '', workerProfiles: {},
    decisions: { ...decisionDefaults, enabled: true, model: 'local-router', localEndpoint: 'http://127.0.0.1:1235/v1/systemone' },
  } } as never)
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ model: 'local-router', answers: {
    route: { type: 'choice', choice: 'reader', confidence: 1, probabilities: { reader: 1, planner: 0 } },
  } }))
  vi.stubGlobal('fetch', fetcher)
  try {
    await runTurn(lead, 'Exercise the local synthetic decision tool call.')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(lead.session.snapshotEvents())).toContain('local-router')
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization')
  } finally { vi.unstubAllGlobals() }
})

it('routes an unpinned substantial worker among approved profiles and preserves explicit choices', async () => {
  const { ctx, lead, fiber } = await setup(['hang', 'hang'])
  await ctx.plugin(MemoryCredentials, { OPENROUTER_API_KEY: 'fixture-key' })
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { requireTaskBrief: false, defaultWorkerProfile: 'reader',
    workerProfiles: { reader: { provider: 'mock', model: 'reader' }, planner: { provider: 'mock', model: 'planner' } },
    decisions: { ...decisionDefaults, enabled: true, autoRouteWorkers: true },
  } } as never)
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ model: 'jev-fixture', answers: {
    profile: { type: 'choice', choice: 'profile_1', confidence: 1, probabilities: { profile_0: 0, profile_1: 1 } },
  } }))
  vi.stubGlobal('fetch', fetcher)
  try {
    const result = await execute(ctx, lead, 'spawn_teammate', { name: 'architect', description: 'Analyze migration design',
      prompt: 'Design a safe schema migration with concurrent readers and failure recovery. Provide the tradeoffs and acceptance checks.' })
    expect(result.isError, text(result)).toBe(false)
    const childId = spawnedChildId(ctx, lead, result)
    await vi.waitFor(() => { expect(ctx.agents.get(childId)?.options).toMatchObject({ model: 'planner' }) })
    expect(text(result)).toContain('jev-fixture')
    const explicit = await execute(ctx, lead, 'spawn_teammate', { name: 'pinned', description: 'Pinned reader',
      prompt: 'Investigate schema migration requirements.', model_profile: 'reader' })
    expect(explicit.isError, text(explicit)).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { vi.unstubAllGlobals() }
})

it('uses no routing request for a mechanical assignment and falls back after a service failure', async () => {
  const { ctx, lead, fiber } = await setup(['hang', 'hang'])
  await ctx.plugin(MemoryCredentials, { OPENROUTER_API_KEY: 'fixture-key' })
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { requireTaskBrief: false, defaultWorkerProfile: 'reader',
    workerProfiles: { reader: { provider: 'mock', model: 'reader' }, planner: { provider: 'mock', model: 'planner' } },
    decisions: { ...decisionDefaults, enabled: true, autoRouteWorkers: true },
  } } as never)
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic transport failure'))
  vi.stubGlobal('fetch', fetcher)
  try {
    expect((await execute(ctx, lead, 'spawn_teammate', { name: 'lookup', description: 'Lookup', prompt: 'Read one file and report its exported symbols.' })).isError).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
    const fallback = await execute(ctx, lead, 'spawn_teammate', { name: 'fallback', description: 'Design', prompt: 'Design a schema migration that preserves concurrent access and recovers from interrupted writes.' })
    expect(fallback.isError, text(fallback)).toBe(false)
    expect(text(fallback)).toContain('DECISION_TRANSPORT')
    expect(ctx.agents.get(spawnedChildId(ctx, lead, fallback))?.options.model).toBe('reader')
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { vi.unstubAllGlobals() }
})

it('keeps review triage conservative and never treats Jev as acceptance', async () => {
  const args = { context: 'Synthetic copy-only diff with unchanged behavior and verified text.', recipe: 'review' }
  const { ctx, lead, fiber } = await setup([
    toolCallResponse('review-quick', 'coding_decide', args),
    toolCallResponse('review-full', 'coding_decide', args),
    textResponse('The supervisor still verifies the change.'),
  ])
  await ctx.plugin(MemoryCredentials, { OPENROUTER_API_KEY: 'fixture-key' })
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { requireTaskBrief: false, defaultWorkerProfile: '', workerProfiles: {},
    decisions: { ...decisionDefaults, enabled: true },
  } } as never)
  let calls = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON request')
    const body = JSON.parse(init.body) as { questions: Record<string, unknown> }
    calls++
    return Promise.resolve(Response.json({ model: 'jev-fixture', answers: Object.fromEntries(Object.keys(body.questions).map((id, index) => [id,
      { type: 'noul', noul: calls === 2 && index === 0 ? 0.5 : 0 },
    ])) }))
  })
  vi.stubGlobal('fetch', fetcher)
  try {
    await runTurn(lead, 'Exercise both synthetic review decisions, without accepting any task.')
    const retained = JSON.stringify(lead.session.snapshotEvents().filter(event => event.type === 'tool/result'))
    expect(retained).toContain('reviewDepth')
    expect(retained).toContain('quick')
    expect(retained).toContain('full')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(ctx.agentTeams.listTasks(lead)).toEqual([])
  } finally { vi.unstubAllGlobals() }
})

it('loads Jev-selected permitted skills automatically and shares the turn budget with explicit advice', async () => {
  const args = { context: 'Which role should handle the next investigation?', questions: [{
    id: 'route', question: 'Choose a role', options: [{ id: 'reader', description: 'Read' }, { id: 'planner', description: 'Plan' }],
  }] }
  const { ctx, lead, fiber, adapter } = await setup([
    toolCallResponse('explicit-advice-after-skill', 'coding_decide', args), textResponse('Investigated with the loaded debugging skill.'),
  ])
  await ctx.plugin(MemoryCredentials, { OPENROUTER_API_KEY: 'fixture-key' })
  await ctx.plugin(SkillRegistry)
  ctx.skills.register({ name: 'debugging', description: 'Diagnose intermittent cancellation failures', source: 'runtime', content: 'SYNTHETIC_DEBUGGING_INSTRUCTIONS' })
  ctx.skills.register({ name: 'manual-debugging', description: 'Diagnose intermittent cancellation failures', source: 'runtime', content: 'MANUAL_ONLY',
    invocation: { modelInvocable: false, userInvocable: true } })
  await ctx.plugin(ToolSkill, { automatic: { enabled: true, maxSkills: 1, maxBytes: 4096, rules: [] } } as never)
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { requireTaskBrief: false, defaultWorkerProfile: '', workerProfiles: {},
    decisions: { ...decisionDefaults, enabled: true, autoSelectSkills: true, maxCallsPerTurn: 1 },
  } } as never)
  const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
    expect(init?.body).not.toContain('manual-debugging')
    return Promise.resolve(Response.json({ model: 'jev-fixture', answers: {
      skill: { type: 'choice', choice: 'skill_0', confidence: 1, probabilities: { none: 0, skill_0: 1 } },
    } }))
  })
  vi.stubGlobal('fetch', fetcher)
  try {
    await runTurn(lead, 'Diagnose intermittent cancellation failures in the background task runner.')
    expect(adapter.requests.length, JSON.stringify(lead.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data)).toBeGreaterThan(0)
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('SYNTHETIC_DEBUGGING_INSTRUCTIONS')
    expect(JSON.stringify(lead.session.snapshotEvents())).toContain('Decision request budget reached')
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { vi.unstubAllGlobals() }
})

it('keeps a bounded styling repair off the advisor and full design workflow even with a detailed verification brief', async () => {
  const { ctx, lead, fiber, adapter } = await setup([textResponse('Apply the scoped style repair directly.')])
  await ctx.plugin(MemoryCredentials, { OPENROUTER_API_KEY: 'fixture-key' })
  await ctx.plugin(SkillRegistry)
  ctx.skills.register({ name: 'impeccable', description: 'Review UI scrollbar styling, spacing and visual defects', source: 'runtime', content: 'FULL_INTERFACE_REVIEW_SENTINEL' })
  await ctx.plugin(ToolSkill, { automatic: { enabled: true, maxSkills: 1, maxBytes: 12000, rules: [] } } as never)
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { requireTaskBrief: false, defaultWorkerProfile: '', workerProfiles: {},
    decisions: { ...decisionDefaults, enabled: true, autoSelectSkills: true },
  } } as never)
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ model: 'jev-fixture', answers: {
    skill: { type: 'choice', choice: 'skill_0', confidence: 1, probabilities: { none: 0, skill_0: 1 } },
  } }))
  vi.stubGlobal('fetch', fetcher)
  const brief = 'Independent final review found one missed UI criterion: the page scrollbar is visible at the narrow viewport, although the task-list scrollbar is hidden. Fix only this styling defect directly. Preserve scrolling, visible keyboard focus, icons, data and working interactions. Keep your current model and use no workers. Run the existing affected viewport checks before reporting, keeping their output in the local report directory. Do not rewrite the dashboard, alter unrelated styles, change the fixture data, add dependencies, install a new browser or publish remotely. Leave the established component hierarchy and responsive breakpoints unchanged.'
  expect(brief.length).toBeGreaterThan(500)
  try {
    await runTurn(lead, brief)
    expect(fetcher).not.toHaveBeenCalled()
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('FULL_INTERFACE_REVIEW_SENTINEL')
  } finally { vi.unstubAllGlobals() }
})

it('ranks real files in one request without adding their contents to the coding model context', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codecrew-jev-context-')); roots.push(dir)
  writeFileSync(join(dir, 'auth.ts'), 'export const SYNTHETIC_PRIVATE_SOURCE_SENTINEL = "checks roles";\n')
  writeFileSync(join(dir, 'view.ts'), 'export const render = () => "page";\n')
  const args = { context: 'Find the owner of access checks.', recipe: 'rank_files', files: ['auth.ts', 'view.ts'] }
  const { ctx, lead, fiber, adapter } = await setup([
    toolCallResponse('rank-files', 'coding_decide', args), textResponse('Read auth.ts first; source remains outside the coding model context.'),
  ])
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.workingDirectory.set(lead, dir)
  await ctx.plugin(MemoryCredentials, { OPENROUTER_API_KEY: 'fixture-key' })
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { requireTaskBrief: false, defaultWorkerProfile: '', workerProfiles: {},
    decisions: { ...decisionDefaults, enabled: true, inspectFiles: true },
  } } as never)
  const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
    expect(init?.body).toContain('SYNTHETIC_PRIVATE_SOURCE_SENTINEL')
    return Promise.resolve(Response.json({ model: 'jev-fixture', answers: {
      relevance: { type: 'choice', choice: 'file_0', confidence: 1, probabilities: { none: 0, file_0: 1, file_1: 0 } },
    } }))
  })
  vi.stubGlobal('fetch', fetcher)
  try {
    await runTurn(lead, 'Rank the supplied synthetic files; do not read them into your own context.')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(adapter.requests)).not.toContain('SYNTHETIC_PRIVATE_SOURCE_SENTINEL')
    const retained = JSON.stringify(lead.session.snapshotEvents().filter(event => event.type === 'tool/result'))
    expect(retained).toContain('ranking')
    expect(retained).toContain('auth.ts')
    expect(retained).not.toContain('SYNTHETIC_PRIVATE_SOURCE_SENTINEL')
  } finally { vi.unstubAllGlobals() }
})

it('isolates automatic skill requests and budgets between multiple live agents', async () => {
  const { ctx, lead, fiber } = await setup([textResponse('Continue without a confidently selected skill.'), textResponse('Independent turn.')])
  await ctx.plugin(MemoryCredentials, { OPENROUTER_API_KEY: 'fixture-key' })
  await ctx.plugin(SkillRegistry)
  ctx.skills.register({ name: 'debugging', description: 'Analyze intermittent cancellation failures', source: 'runtime', content: 'Debug carefully.' })
  await ctx.plugin(ToolSkill, { automatic: { enabled: true, maxSkills: 1, maxBytes: 4096, rules: [] } } as never)
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { requireTaskBrief: false, defaultWorkerProfile: '', workerProfiles: {},
    decisions: { ...decisionDefaults, enabled: true, autoSelectSkills: true, maxCallsPerTurn: 1 },
  } } as never)
  const other = await ctx.agentLoop.create(SessionId('other-decision-owner'), { provider: 'mock', model: 'mock' })
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ model: 'jev-fixture', answers: {
    skill: { type: 'choice', choice: 'none', confidence: 0, probabilities: { none: 0.5, skill_0: 0.5 } },
  } }))
  vi.stubGlobal('fetch', fetcher)
  try {
    await runTurn(lead, 'Analyze intermittent cancellation failures in the background task runner.')
    expect(fetcher).toHaveBeenCalledTimes(1)
    await runTurn(other, 'Analyze intermittent cancellation failures in a different component.')
    expect(fetcher).toHaveBeenCalledTimes(2)
  } finally { vi.unstubAllGlobals() }
})

it('dispatches an approved route and exposes bounded reports without accepting worker self-approval', async () => {
  const { ctx, lead, adapter, fiber } = await setup(['hang', textResponse('Supervisor review'), textResponse('Worker cancelled')])
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { supervisorProfile: 'planner', requireTaskBrief: true, defaultWorkerProfile: 'reader', workerProfiles: {
    reader: { provider: 'mock', model: 'cheap-reader', maxTokens: 1024 },
    planner: { provider: 'mock', model: 'capable-supervisor' },
  } } } as never)
  const task = await ctx.agentTeams.createTask(lead, { subject: 'Read source', description: '## Objective\nInspect source.\n## Inputs\nsrc/example.js\n## Scope\nNone; read-only.\n## Acceptance\nConcrete findings.\n## Verification\nInspect assertions.\n## Stop conditions\nReport missing input.' })
  const args = { goal: 'Inspect the assigned source and verify findings', assignments: [{ task_id: task.id, expected_revision: task.revision, name: 'dispatched-reader', model_profile: 'reader' }] }
  expect(text(await execute(ctx, lead, 'team_dispatch', { ...args, assignments: [{ ...args.assignments[0], model_profile: 'unknown' }] }))).toContain('Unknown worker model profile')
  expect(ctx.agentTeams.listDispatches(lead)).toHaveLength(0)
  expect(text(await execute(ctx, lead, 'team_dispatch', args))).toContain('"queued":1')
  expect(lead.model.current()).toMatchObject({ provider: 'mock', model: 'mock' })
  const worker = await vi.waitFor(() => {
    const member = ctx.agentTeams.listMembers(lead).find(item => item.name === 'dispatched-reader')
    expect(member?.status).toBe('running')
    return ctx.agents.get(member!.id)!
  })
  expect(adapter.requests.find(request => request.sessionId === worker.id)).toMatchObject({ model: 'cheap-reader', maxTokens: 1024 })
  const report = { task_id: task.id, outcome: 'ready', summary: 'Checked assertions', changed_files: [], checks: ['Inspected the source assertions; expected values match'], risks: 'Runtime not executed' }
  expect(text(await execute(ctx, worker, 'team_task_report', { ...report, checks: [] }))).toContain('requires checks')
  expect(text(await execute(ctx, worker, 'team_task_report', report))).toContain('"reported":true')
  const compact = JSON.parse(text(await execute(ctx, lead, 'team_dispatch_status', {}))) as { assignments: object[] }
  expect(compact.assignments[0]).toMatchObject({ taskId: task.id, phase: 'review', model: 'cheap-reader' })
  expect(compact.assignments[0]).not.toHaveProperty('report')
  const detailed = JSON.parse(text(await execute(ctx, lead, 'team_dispatch_status', { task_id: task.id }))) as { assignments: object[] }
  expect(detailed.assignments[0]).toHaveProperty('report.checks', report.checks)
  expect(text(await execute(ctx, worker, 'team_task_update', { task_id: task.id, expected_revision: 2, action: 'complete', evidence: 'self-approved' }))).toContain('Only the supervisor')
  expect(text(await execute(ctx, lead, 'team_dispatch_cancel', { task_id: task.id }))).toContain('"cancelled":true')
  expect(ctx.agentTeams.getTask(lead, task.id)).toMatchObject({ status: 'pending' })
  expect(ctx.agents.get(worker.id)).toBeUndefined()
})

it('restores the coordinator goal after the retained runtime snapshot is replaced', async () => {
  const { ctx, lead, adapter } = await setup([textResponse('first'), textResponse('continued')])
  const goal = 'Finish the keyboard-accessible dashboard without losing task state'
  const saved = await execute(ctx, lead, 'team_checkpoint', {
    expected_revision: 0, goal, constraints: ['Preserve data'], next_actions: ['Verify mobile overflow'],
  })
  expect(saved.isError).toBe(false)
  await runTurn(lead, 'Continue the project')
  expect(JSON.stringify(adapter.requests[0]?.messages)).toContain(goal)
  const context = lead.session.snapshotEvents().findLast(event => event.type === 'user/message'
    && event.data.source.kind === 'runtime-context')
  expect(context).toBeDefined()
  lead.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Earlier conversation summarized.' }] }), {
    surfaceOp: { op: 'replace', startSeq: context!.seq, endSeq: context!.seq }, sourceEventSeqs: [context!.seq],
  })
  await runTurn(lead, 'Continue with the current goal and next actions')
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain(goal)
  expect(runtimeContextText(adapter.requests[1]!)).toContain('Verify mobile overflow')
  const snapshots = lead.session.snapshotEvents().filter(event => event.type === 'user/message'
    && event.data.source.kind === 'runtime-context')
  expect(snapshots).toHaveLength(2)
})

it('routes substantial automatic UI work to the approved Lead profile without changing routine or other agents', async () => {
  const { ctx, lead, fiber } = await setup([])
  await fiber.dispose()
  const settings = { uiProfile: 'designer', requireTaskBrief: false, defaultWorkerProfile: '', workerProfiles: {
    designer: { provider: 'mock', model: 'ui-model' },
  } }
  const routedFiber = await ctx.plugin(toolTeam, { coding: settings } as never)
  const other = await ctx.agentLoop.create(SessionId('other-ui-lead'), { provider: 'mock', model: 'mock' })
  const input = { agent: lead, names: ['design-distinctive-frontends'], task: 'Build a polished responsive dashboard', signal: SIGNAL }
  await lead.ctx.serial('skills/automatic-selected', { ...input, agent: other, names: ['diagnosing-bugs'] })
  expect(lead.model.current()?.model).toBe('mock')
  await lead.ctx.serial('skills/automatic-selected', { ...input, names: ['diagnosing-bugs'] })
  expect(lead.model.current()?.model).toBe('mock')
  await lead.ctx.serial('skills/automatic-selected', input)
  expect(lead.model.current()?.model).toBe('ui-model')
  expect(other.model.current()?.model).toBe('mock')
  await routedFiber.dispose()
  lead.model.select({ provider: 'mock', model: 'mock' })
  await lead.ctx.serial('skills/automatic-selected', input)
  expect(lead.model.current()?.model).toBe('mock')
})

it('changes the supervisor model only when dispatch explicitly requests the configured phase', async () => {
  const { ctx, lead, fiber } = await setup(['hang'])
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { supervisorProfile: 'planner', requireTaskBrief: true,
    defaultWorkerProfile: 'reader', workerProfiles: {
      reader: { provider: 'mock', model: 'independent-reader' },
      planner: { provider: 'mock', model: 'intentional-supervisor' },
    },
  } } as never)
  const task = await ctx.agentTeams.createTask(lead, { subject: 'Read source', description:
    '## Objective\nRead source.\n## Inputs\nsrc/example.js\n## Scope\nNone; read-only.\n## Acceptance\nConcrete findings.\n## Verification\nInspect assertions.\n## Stop conditions\nReport missing input.' })
  expect(text(await execute(ctx, lead, 'team_dispatch', { select_supervisor: true, goal: 'Inspect source',
    assignments: [{ task_id: task.id, expected_revision: task.revision, name: 'phase-reader', model_profile: 'reader' }],
  }))).toContain('"queued":1')
  expect(lead.model.current()?.model).toBe('intentional-supervisor')
  expect(ctx.agentTeams.listDispatches(lead)[0]?.agentOptions?.model).toBe('independent-reader')
})

it('routes three unpinned assignments in one advisor request without changing the supervisor', async () => {
  const { ctx, lead, fiber } = await setup(['hang', 'hang', 'hang'])
  await ctx.plugin(MemoryCredentials, { OPENROUTER_API_KEY: 'fixture-key' })
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { supervisorProfile: 'planner', requireTaskBrief: true,
    defaultWorkerProfile: 'reader', workerProfiles: {
      reader: { provider: 'mock', model: 'scoped-reader' },
      implementer: { provider: 'mock', model: 'scoped-implementer' },
      planner: { provider: 'mock', model: 'scoped-planner' },
    }, decisions: { ...decisionDefaults, enabled: true, autoRouteWorkers: true, maxCallsPerTurn: 1 },
  } } as never)
  const tasks = await Promise.all(['html', 'css', 'js'].map(name => ctx.agentTeams.createTask(lead, {
    subject: name, writeScopes: [`src/${name}`], description:
      `## Objective\nImplement the ${name} feature.\n## Inputs\nShared component specification.\n## Scope\nsrc/${name}\n## Acceptance\nMeet the supplied interface.\n## Verification\nRun focused checks.\n## Stop conditions\nReport missing inputs.`,
  })))
  const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
    const body = JSON.parse(init.body) as { questions: Record<string, unknown> }
    expect(Object.keys(body.questions)).toHaveLength(3)
    return Promise.resolve(Response.json({ model: 'jev-fixture', answers: Object.fromEntries(
      Object.keys(body.questions).map((id, i) => [id, { type: 'choice', choice: `profile_${i}`, confidence: 1,
        probabilities: { profile_0: i === 0 ? 1 : 0, profile_1: i === 1 ? 1 : 0, profile_2: i === 2 ? 1 : 0 } }]),
    ) }))
  })
  vi.stubGlobal('fetch', fetcher)
  try {
    const result = await execute(ctx, lead, 'team_dispatch', { goal: 'Build independent components',
      assignments: tasks.map((task, i) => ({ task_id: task.id, expected_revision: task.revision, name: `component-${i}`, isolation: 'shared' })),
    })
    expect(text(result)).toContain('"queued":3')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(ctx.agentTeams.listDispatches(lead).map(item => item.agentOptions?.model))
      .toEqual(['scoped-reader', 'scoped-implementer', 'scoped-planner'])
    expect(lead.model.current()?.model).toBe('mock')
  } finally { vi.unstubAllGlobals() }
})

it('chooses per-worker models and skills together, injects only each selected skill and retains the choices durably', async () => {
  const { ctx, lead, fiber, adapter } = await setup(['hang', 'hang'])
  await ctx.plugin(MemoryCredentials, { OPENROUTER_API_KEY: 'fixture-key' })
  await ctx.plugin(SkillRegistry)
  ctx.skills.register({ name: 'css-layout', description: 'CSS grid responsive typography', source: 'runtime', content: 'CSS_ONLY_SENTINEL' })
  ctx.skills.register({ name: 'javascript-events', description: 'JavaScript event handlers state', source: 'runtime', content: 'JS_ONLY_SENTINEL' })
  ctx.skills.register({ name: 'manual-only', description: 'CSS JavaScript', source: 'runtime', content: 'NEVER_INJECT', invocation: { modelInvocable: false, userInvocable: true } })
  await ctx.plugin(ToolSkill, { automatic: { enabled: true, maxSkills: 1, maxBytes: 4096, rules: [] } } as never)
  await fiber.dispose()
  await ctx.plugin(toolTeam, { coding: { requireTaskBrief: true, defaultWorkerProfile: 'implementer', workerProfiles: {
    reader: { provider: 'mock', model: 'cheap-inspection' }, implementer: { provider: 'mock', model: 'capable-coding' },
  }, decisions: { ...decisionDefaults, enabled: true, autoRouteWorkers: true, autoSelectSkills: true, maxCallsPerTurn: 1 } } } as never)
  const tasks = []
  for (const [index, objective] of ['CSS grid responsive typography', 'JavaScript event handlers state'].entries()) {
    tasks.push(await ctx.agentTeams.createTask(lead, { subject: objective, writeScopes: [`src/part-${index}`], description:
      `## Objective\n${objective}.\n## Inputs\nProvided interfaces.\n## Scope\nsrc/part-${index}\n## Acceptance\nMeet the supplied interface.\n## Verification\nRun focused checks.\n## Stop conditions\nReport missing inputs.` }))
  }
  const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON decision input')
    const body = JSON.parse(init.body) as { state: string[]; questions: Record<string, { criteria: Record<string, string> }> }
    expect(Object.keys(body.questions)).toEqual(['profile_0', 'skill_0', 'profile_1', 'skill_1'])
    expect(body.state.join('')).not.toContain('SENTINEL')
    expect(init.body).not.toContain('manual-only')
    return Promise.resolve(Response.json({ model: 'jev-fixture', answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const choice = id.startsWith('profile') ? 'profile_1' : Object.entries(question.criteria).find(([, text]) => text.includes(id === 'skill_0' ? 'css-layout' : 'javascript-events'))![0]
      return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }]
    })) }))
  })
  vi.stubGlobal('fetch', fetcher)
  try {
    const result = await execute(ctx, lead, 'team_dispatch', { goal: 'Integrate two independent files', assignments: tasks.map((task, i) => ({
      task_id: task.id, expected_revision: task.revision, name: `skilled-${i}`, isolation: 'shared',
    })) })
    expect(text(result)).toContain('"queued":2')
    await vi.waitFor(() => { expect(adapter.requests.filter(request => request.sessionId !== lead.id)).toHaveLength(2) })
    const members = ctx.agentTeams.listMembers(lead)
    for (let index = 0; index < 2; index++) {
      const request = adapter.requests.find(request => request.sessionId === members.find(member => member.name === `skilled-${index}`)?.id)!
      const messages = JSON.stringify(request.messages)
      expect(request.model).toBe('capable-coding')
      expect(request.tools?.some(tool => tool.name === 'coding_decide')).toBe(false)
      expect(messages).toContain(index === 0 ? 'CSS_ONLY_SENTINEL' : 'JS_ONLY_SENTINEL')
      expect(messages).not.toContain(index === 0 ? 'JS_ONLY_SENTINEL' : 'CSS_ONLY_SENTINEL')
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(ctx.agentTeams.listDispatches(lead).map(item => item.skills)).toEqual([['css-layout'], ['javascript-events']])
  } finally { vi.unstubAllGlobals() }
})

it('exposes only bounded coordination controls to a dispatched supervisor and keeps the Lead checkpoint protected', async () => {
  const { ctx, lead } = await setup(['hang', 'hang'])
  const brief = '## Objective\nCoordinate UI components.\n## Inputs\nShared contract.\n## Scope\nsrc/ui\n## Acceptance\nVerified children.\n## Verification\nInspect child checks.\n## Stop conditions\nReport blockers.'
  const task = await ctx.agentTeams.createTask(lead, { subject: 'UI package', description: brief, writeScopes: ['src/ui'] })
  expect(text(await execute(ctx, lead, 'team_dispatch', { goal: 'Build UI', assignments: [{ task_id: task.id,
    expected_revision: 1, name: 'ui-manager', role: 'supervisor', skills: [] }] }))).toContain('"queued":1')
  const supervisor = await vi.waitFor(() => {
    const member = ctx.agentTeams.listMembers(lead).find(member => member.name === 'ui-manager')
    expect(member?.status).toBe('running')
    return ctx.agents.get(member!.id)!
  })
  for (const name of ['team_task_create', 'team_dispatch', 'team_dispatch_status', 'team_dispatch_cancel']) expect(ctx.tools.get(name, supervisor)).toBeDefined()
  for (const name of ['spawn_teammate', 'team_checkpoint', 'select_model_profile', 'interrupt_agent']) expect(ctx.tools.get(name, supervisor)).toBeUndefined()
  expect(text(await execute(ctx, supervisor, 'team_dispatch', { goal: 'Replace root goal', assignments: [] }))).toContain('Only the Lead')
  const child = await execute(ctx, supervisor, 'team_task_create', { parent_task_id: task.id,
    subject: 'Component', description: brief, write_scopes: ['src/ui/component.tsx'] })
  expect(text(child)).toContain('parentTaskId')
  const parsed = JSON.parse(text(child)) as { id: string; revision: number }
  expect(text(await execute(ctx, supervisor, 'team_dispatch', { assignments: [{ task_id: parsed.id,
    expected_revision: parsed.revision, name: 'ui-component', isolation: 'shared', skills: [] }] }))).toContain('"queued":1')
  expect(ctx.agentTeams.getCheckpoint(lead)?.goal).toBe('Build UI')
  const worker = await vi.waitFor(() => {
    const member = ctx.agentTeams.listMembers(lead).find(member => member.name === 'ui-component')
    expect(member?.status).toBe('running')
    return ctx.agents.get(member!.id)!
  })
  expect(renderContextSnapshot(await assembly(ctx, worker))).toContain('Your assignment supervisor is named "ui-manager"')
  const visible = JSON.parse(text(await execute(ctx, worker, 'team_task_list', {}))) as { tasks: { id: string }[] }
  expect(visible.tasks.map(task => task.id)).toEqual([parsed.id])
})


it('packs ten worker routes by complete escaped request bytes instead of dropping an oversized question batch', async () => {
  const { ctx, lead } = await setup([])
  const policy = { ...decisionDefaults, enabled: true, autoRouteWorkers: true, maxQuestions: 8, maxTextBytes: 2500 }
  const requests: DecisionInput[] = []
  const advisor: DecisionAdvisor = Object.assign(() => undefined, { ask: async (input: DecisionInput) => {
    expect(decisionTextBytes(policy, input)).toBeLessThanOrEqual(policy.maxTextBytes)
    requests.push(input)
    return { model: 'fixture', requestedModel: 'fixture', elapsedMs: 0, images: [],
      decisions: input.questions.map(question => ({ id: question.id, type: 'choice' as const, status: 'decided' as const,
        choice: 'profile_0', confidence: 1, noul: null, score: null, distribution: [] })),
      usage: { inputTokens: null, outputTokens: null, cost: null } }
  } })
  const routes = await routeWorkerAssignments(ctx, lead, Array.from({ length: 10 }, (_, index) => ({
    task: `Implement component ${index}: ${'quoted "context" '.repeat(40)}`, skills: undefined, profileName: undefined, supervisor: false,
  })), advisor, { requireTaskBrief: true, defaultWorkerProfile: 'implementer', decisions: policy, workerProfiles: {
    reader: { provider: 'mock', model: 'cheap' }, implementer: { provider: 'mock', model: 'capable' },
  } }, SIGNAL)
  expect(requests.length).toBeGreaterThan(1)
  expect(requests.flatMap(input => input.questions)).toHaveLength(10)
  expect(routes.every(route => route.profileName === 'reader')).toBe(true)
})

it('reuses saved responsibilities without classifier calls and retains explicit model choices', async () => {
  const { ctx, lead } = await setup([])
  const ask = vi.fn<DecisionAdvisor['ask']>()
  const advisor: DecisionAdvisor = Object.assign(() => undefined, { ask })
  const routes = await routeWorkerAssignments(ctx, lead, ['Implement the button', 'Review the patch', 'Plan the migration', 'Fix the layout'].map((task, index) => ({
    task: `## Objective\n${task}\n## Inputs\nsrc/page.tsx\n## Scope\nsrc/page.tsx`,
    skills: [], profileName: index === 3 ? 'reviewer' : undefined, supervisor: false,
  })), advisor, { requireTaskBrief: true, defaultWorkerProfile: 'implementer', workerProfiles: {
    implementer: { provider: 'mock', model: 'coder' }, reviewer: { provider: 'mock', model: 'reviewer' }, planner: { provider: 'mock', model: 'planner' },
  }, decisions: { ...decisionDefaults, enabled: true, autoRouteWorkers: true, reuseWorkerProfiles: true } }, SIGNAL)
  expect(routes.map(route => route.profileName)).toEqual(['implementer', 'reviewer', 'planner', 'reviewer'])
  expect(ask).not.toHaveBeenCalled()
})

it('shares saved-role reuse with manual spawning and leaves missing or ambiguous roles unresolved', async () => {
  const settings = { requireTaskBrief: false, defaultWorkerProfile: 'implementer', workerProfiles: {
    implementer: { provider: 'mock', model: 'coder' }, reviewer: { provider: 'mock', model: 'reviewer' },
  }, decisions: { ...decisionDefaults, reuseWorkerProfiles: true } }
  const ask = vi.fn<DecisionAdvisor['ask']>()
  const advisor: DecisionAdvisor = Object.assign(() => undefined, { ask })
  expect(await routeDecisionWorkers(advisor, settings, ['Review the change', 'Implement the change'], SIGNAL))
    .toEqual([{ profileName: 'reviewer' }, { profileName: 'implementer' }])
  expect(ask).not.toHaveBeenCalled()
  expect(savedWorkerProfile('Plan a migration', settings)).toBeUndefined()
  expect(savedWorkerProfile('Investigate the unexplained failure', settings)).toBeUndefined()
  expect(savedWorkerProfile('Review the change', { ...settings, decisions: { ...settings.decisions, reuseWorkerProfiles: false } })).toBeUndefined()
})

it('routes a six-section read-only lookup to the reader without a Jev call or the implementation default', async () => {
  const { ctx, lead } = await setup([])
  const ask = vi.fn<DecisionAdvisor['ask']>()
  const advisor: DecisionAdvisor = Object.assign(() => undefined, { ask })
  const routes = await routeWorkerAssignments(ctx, lead, [{
    task: '## Objective\nRead src/config.ts and list its exports.\n## Inputs\nsrc/config.ts\n## Scope\nNone; read-only.\n## Acceptance\nExact export names.\n## Verification\nCheck the declaration lines.\n## Stop conditions\nReport a missing file.',
    skills: undefined, profileName: undefined, supervisor: false,
  }], advisor, { requireTaskBrief: true, defaultWorkerProfile: 'implementer', workerProfiles: {
    reader: { provider: 'mock', model: 'cheap' }, implementer: { provider: 'mock', model: 'capable' },
  }, decisions: { ...decisionDefaults, enabled: true, autoRouteWorkers: true, autoSelectSkills: true } }, SIGNAL)
  expect(routes).toEqual([{ profileName: 'reader', skills: [] }])
  expect(ask).not.toHaveBeenCalled()
})
