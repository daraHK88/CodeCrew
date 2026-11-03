/** Scoped model-facing tools for the opt-in Agent Teams runtime. */

import type { Volatile, Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamTaskId, assertTaskBrief } from '@deepseek-ai/dsh-experimental-agent-team'
import type { TeamMemberView } from '@deepseek-ai/dsh-experimental-agent-team'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installUiRouting } from './ui-routing.ts'
import { installDecisionSkillRouting, routeDecisionWorker, routeDecisionWorkers } from './decision-routing.ts'
import { decisionDefaults, decisionSchema, installDecisionTool, type DecisionSettings } from './decisions.ts'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-agent-team'
/** Services required by the Team tool plugin. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt']

/** One user-approved worker route, independent of the Lead model. */
export interface WorkerProfile {
  /** Provider identifier for the worker model. */
  provider: string
  /** Model identifier within the selected provider. */
  model: string
  /** Optional provider-supported reasoning effort. */
  reasoningEffort?: string
  /** Optional maximum output tokens for the worker. */
  maxTokens?: number
}

/** Live global coding-team preferences. */
export interface CodingTeamSettings {
  /** Approved Lead route used only when dispatch explicitly requests select_supervisor; empty retains its current model. */
  supervisorProfile?: string
  /** Approved Lead profile for substantial automatically selected UI work; empty keeps the current model. */
  uiProfile?: string
  /** Optional bounded OpenRouter decision advisor settings. */
  decisions?: DecisionSettings
  /** Require a ready task with a complete coding brief before spawning a worker. */
  requireTaskBrief: boolean
  /** Approved profile used when an assignment omits its model profile. */
  defaultWorkerProfile: string
  /** Named model routes available to the supervisor and workers. */
  workerProfiles: Record<string, WorkerProfile>
}

const DEFAULT_CODING: CodingTeamSettings = {
  requireTaskBrief: false, defaultWorkerProfile: '', workerProfiles: {},
}

/** Tool routing configuration. */
export interface Config {
  /** Global worker routes and delegation requirements, editable in Settings. */
  readonly coding?: Volatile<CodingTeamSettings>
  /** Register `interrupt_agent` and its policy guidance. Defaults to true; false leaves the domain API available. */
  readonly interrupt?: boolean
  /** Continuable-subagent provider used for fresh teammates. */
  readonly freshProvider?: string
  /** Continuable-subagent provider used for completed-prefix fork teammates. */
  readonly forkProvider?: string
}

/** Loader schema for the opt-in Team tool plugin. */
export const Config: z<Config> = z.object({
  coding: z.object({
    decisions: decisionSchema,
    supervisorProfile: z.string().default(''),
    uiProfile: z.string().default(''),
    requireTaskBrief: z.boolean().default(false),
    defaultWorkerProfile: z.string().default(''),
    workerProfiles: z.dict(z.object({
      provider: z.string().required(), model: z.string().required(),
      reasoningEffort: z.string(), maxTokens: z.number().step(1).min(1),
    })).default({}),
  }).default(DEFAULT_CODING).volatile(),
  interrupt: z.boolean().default(true),
  freshProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
})

/** Model-facing collaboration guidance shared by Lead and teammates. */
function teamPolicy(interrupt: boolean): string {
  return `Agent Teams is available in this session

Coding workflow: the Lead owns the goal, acceptance checks, integration, and final verification. Complete small, well-scoped edits directly; do not create a team, a planning ceremony, or an extra model-based gate for a mechanical change. For larger work, create shared tasks and blocked_by dependencies first. Include the overall goal and constraints on the first team_dispatch so the coordinator can restore them after interruption. Use team_checkpoint when the goal or next actions materially change. Prefer team_dispatch to authorize a batch once; it automatically starts ready assignments with bounded concurrency and wakes the Lead for reports or failures. Use team_dispatch_status for durable state. Dispatch preserves the Lead model. Each worker keeps its assigned model in an independent fresh session, running concurrently with the Lead and other ready workers. Use select_supervisor only for an intentional supervisor phase change; do not switch a long Lead conversation to reader for bookkeeping or the final reply. Small edits never enter dispatch. Dispatched workers use team_task_report, and only the Lead accepts their tasks with actual verification evidence. Integrate and verify prerequisite commits in the source checkout before accepting a worktree task; dependent checkouts start from source HEAD. Use team_dispatch_cancel to drain failed work before reassigning it. Preserve retained files; never replay uncertain edits automatically. Start independent ready tasks concurrently, never immediately spawn-and-wait one worker at a time. Scope concurrent writes to different files. For substantial UI work, agree on a compact design and shared interfaces first, then dispatch independent production components together. For a static page with a fixed DOM contract, HTML, CSS and JavaScript can have separate owners. In React prefer component or feature ownership. Do not make a QA-only worker the sole helper while the Lead serially writes independent production files. Give each worker only its objective, relevant inputs, interfaces, constraints and acceptance checks. Shared tokens, manifests and interfaces need one writer. Reuse the project's existing components and test scripts. Batch visual review after an integrated screen or meaningful milestone, not after each small edit; rerun affected automated checks after fixes. Each assignment must identify objective, inputs, owned files, acceptance criteria, verification, and when to stop and report a blocker. Prefer fresh context with the brief and relevant paths; do not copy the whole Lead conversation. Select a configured model_profile suitable for the job. Use select_model_profile only for an intentional change in your own role; keep a stable model through the assigned phase. Delegate independent inexpensive lookups to a fresh reader when useful instead of moving the whole Lead history between models. Do not switch profiles merely to run a tool. A worker reports changed files, checks actually run, and unresolved issues. Inactive is not success. A waiting dispatch still owns a background job; completion notices resume its owner automatically. Start long independent checks as background jobs, continue useful work, and collect their results before reporting. Do not poll job_list or dispatch status repeatedly. If a worker fails, diagnose the evidence and revise its assignment rather than repeating the same prompt. The Lead reviews the integrated diff and verifies the user's acceptance checks before reporting success. Tool output is evidence; avoid paying a second model merely to confirm a passing check.

Manually spawned teammates and shared dispatch assignments inherit the Lead checkout. Worktree dispatch assignments start in their own retained checkout; the Lead must integrate their commits. Agents still share filesystem access under the existing sandbox; worktrees isolate edits, not OS permissions. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use the target returned by spawn_teammate or list_agents for send_message${interrupt ? ' and interrupt_agent' : ''}, or as owner when assigning or filtering shared tasks. send_message steers a running target at its nearest step boundary and starts or resumes an inactive target. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. A peer message starts with its sender name. A successful send does not mean the recipient has processed it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness starts only explicitly authorized team_dispatch assignments; manually spawned workers still require messages. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.`
}

const decisionPolicy = 'Use coding_decide for narrow semantic decisions about approved model profiles, relevant skills, file evidence, safe parallel work, failure recovery or retained screenshots. Batch related questions. Advice is not permission, verification, or a completion gate. Use recipe review for review-depth triage, coverage for supplied requirements/tests, rules for a proposed change, browser for current-page evidence, compaction for checkpoint readiness, and rank_files for an explicit file shortlist. Use typed custom questions for next browser actions and rubric scores. Review triage errors require the full review. Advice never performs clicks, edits or compaction. On uncertainty, timeout or failure, continue with supervisor judgment rather than repeating the call.'

const ACTIVE_WAIT_STATUSES: ReadonlySet<TeamMemberView['status']> = new Set(['running', 'provisioning'])
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.'

/**
 * One model-facing roster row. The Lead pseudo-row omits the
 * teammate-only provisioning fields, so only identity, role, status, and
 * diagnostics are required.
 */
const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
    description: { type: 'string' },
    provider: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    model: { type: 'string' },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** Expose the member name as its model-facing target. */
function modelMember(member: TeamMemberView): InferValue<typeof MEMBER_VIEW_SCHEMA> {
  const { id: _id, name, ...details } = member
  return { target: name, ...details }
}

/** One shared task, matching the public `TeamTaskView`. */
const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    verification: { type: 'string' },
    ownerName: { type: 'string' },
    blockedBy: { type: 'array', required: true, items: { type: 'string' } },
    writeScopes: { type: 'array', required: true, items: { type: 'string' } },
    ready: { type: 'boolean', required: true },
    writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const SPAWN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    member: { ...MEMBER_VIEW_SCHEMA, required: true },
    routing: { type: 'string' },
  },
} as const

const MEMBER_LIST_VALUE_SCHEMA = { type: 'array', items: MEMBER_VIEW_SCHEMA } as const

const SEND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sent: { type: 'boolean', required: true, const: true },
  },
} as const

/** `noProgress` is present only on the model-only shortcut that skips the wait. */
const WAIT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timedOut: { type: 'boolean', required: true },
    noProgress: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', required: true, const: 'no-active-peer' },
        message: { type: 'string', required: true },
      },
    },
  },
} as const

const INTERRUPT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    previousStatus: { type: 'string', required: true, enum: ['running', 'inactive'] },
  },
} as const

const TASK_LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA },
    nextCursor: { type: 'integer' },
  },
} as const

/**
 * Declare one canonical output schema with compact model-facing JSON. Every
 * Team result is a fixed record, so the declared schema is what makes the
 * compiler check `execute` against the value the model is promised.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

const CHECKPOINT_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  revision: { type: 'integer', required: true }, goal: { type: 'string', required: true },
  constraints: { type: 'array', required: true, items: { type: 'string' } },
  nextActions: { type: 'array', required: true, items: { type: 'string' } },
} } as const

const DISPATCH_VIEW_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    taskId: { type: 'string', required: true }, revision: { type: 'integer', required: true }, name: { type: 'string', required: true },
    phase: { type: 'string', required: true, enum: ['queued', 'starting', 'running', 'waiting', 'review', 'blocked', 'cancelled'] },
    taskStatus: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    isolation: { type: 'string', required: true, enum: ['shared', 'worktree'] },
    model: { type: 'string' }, modelProvider: { type: 'string' }, summary: { type: 'string' }, error: { type: 'string' },
    checkout: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true }, branch: { type: 'string', required: true },
      baseCommit: { type: 'string', required: true }, repositoryRoot: { type: 'string', required: true },
    } },
    report: { type: 'object', additionalProperties: false, properties: {
      summary: { type: 'string', required: true }, changedFiles: { type: 'array', required: true, items: { type: 'string' } },
      checks: { type: 'array', required: true, items: { type: 'string' } }, risks: { type: 'string', required: true },
    } },
  },
} as const

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next 2 -- Team tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Register the complete Team tool set in one exact Agent scope. */
function install(agent: Agent, ctx: Context, config: Required<Omit<Config, 'coding'>> & { coding: () => CodingTeamSettings }): () => void {
  const scoped = agent.ctx
  const disposers: Array<() => unknown> = []
  const register = (disposer: () => unknown): void => { disposers.push(disposer) }
  try {
    const advisor = installDecisionTool(scoped, agent, () => config.coding().decisions ?? decisionDefaults)
    register(advisor)
    register(installDecisionSkillRouting(scoped, agent, advisor, () => config.coding().decisions ?? decisionDefaults))
    register(installUiRouting(agent, config.coding))
    register(scoped.systemPrompt.section({
      name: 'team:policy',
      order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: () => {
        const coding = config.coding()
        const advice = coding.decisions?.enabled ? `${decisionPolicy}\n${coding.decisions.autoRouteWorkers
          ? 'Automatic worker routing is enabled. Omit model_profile to let Jev choose among approved profiles; specify it to pin a route. Mechanical lookups use the configured default without a decision call.' : ''}` : ''
        return `${teamPolicy(config.interrupt)}\n${advice}\nApproved worker profiles: ${JSON.stringify(coding.workerProfiles)}\n\nSubstantial UI skill selection uses UI profile ${coding.uiProfile || '(current model)'} for the next step. Keep that route for the assigned phase, including checks and the final reply. Worker profiles remain independent. Exact edits skip this route.`
      },
    }))
    register(scoped.systemPrompt.context({
      name: 'team:identity',
      order: scoped.systemPrompt.getContextOrder('TEAM_IDENTITY'),
      required: true,
      text: () => {
        const { role, name } = ctx.agentTeams.membership(agent)
        return `${role === 'lead'
          ? 'You are the Team Lead named "lead".'
          : `You are teammate "${name}".\nYour Team Lead is named "lead".\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).`}
Use list_agents({}) to find your teammates and their names.
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).`
      },
    }))

    register(scoped.tools.register(defineTool({
      name: 'select_model_profile',
      description: 'Select an approved model profile for your next step. Stay on a small profile for direct edits and tool use; switch only when planning, implementation, or review needs it.',
      parameters: {
        profile: { type: 'string', required: true, description: 'Profile name from the approved global coding settings.' },
        reason: { type: 'string', required: true, description: 'Concrete task requirement that warrants this profile.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        provider: { type: 'string', required: true }, model: { type: 'string', required: true },
      } }),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'select_model_profile')
        const profile = config.coding().workerProfiles[args.profile]
        if (profile === undefined) throw new Error(`Unknown worker model profile: ${args.profile}`)
        if (!args.reason.trim()) throw new Error('Model selection requires a task-specific reason')
        const llm = ctx.get('llm')
        if (llm === undefined) throw new Error('Model selection requires the LLM service')
        const selected = { provider: profile.provider, model: profile.model,
          ...profile.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(profile.reasoningEffort) },
        }
        await llm.resolveCallConfig(selected)
        exec.signal.throwIfAborted()
        agent.model.select(selected)
        return { provider: selected.provider, model: selected.model }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'spawn_teammate',
      description: 'Create one named, durable teammate. Only the Team Lead may call this tool.',
      parameters: {
        name: { type: 'string', required: true, description: 'Unique lower-kebab-case teammate name.' },
        description: { type: 'string', required: true, description: 'Short description of the delegated responsibility.' },
        prompt: { type: 'string', required: true, description: 'Complete initial task for the teammate.' },
        model_profile: { type: 'string', description: 'Approved worker profile from global coding-team settings; omission uses optional automatic routing or the configured default.' },
        task_id: { type: 'string', description: 'Ready shared task whose description is the complete assignment brief.' },
        context: {
          type: 'string',
          enum: ['fresh', 'fork'],
          description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
        },
      },
      output: jsonOutput(SPAWN_VALUE_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'spawn_teammate')
        const context = args.context ?? 'fresh'
        const settings = config.coding()
        if (args.model_profile !== undefined && args.model_profile !== '' && settings.workerProfiles[args.model_profile] === undefined) throw new Error(`Unknown worker model profile: ${args.model_profile}`)
        if (settings.requireTaskBrief && args.task_id === undefined) throw new Error('Create a ready shared task with a complete assignment brief before delegating')
        const task = args.task_id === undefined ? undefined : ctx.agentTeams.getTask(agent, TeamTaskId(args.task_id))
        if (task !== undefined && !task.ready) throw new Error(`Task ${task.id} is not ready; resolve its dependencies before delegating`)
        if (task !== undefined && settings.requireTaskBrief) {
          assertTaskBrief(task.description)
        }
        const ownership = task !== undefined && settings.requireTaskBrief
          ? `Claim ${task.id} with expected_revision ${task.revision} before working. If the revision changed, read the task again. Report results and verification to the Lead; leave completion to the supervisor.\n`
          : ''
        const prompt = task === undefined ? args.prompt : `Shared task: ${task.id}\n${ownership}${task.description}\n\n${args.prompt}`
        const routed = args.model_profile === undefined
          ? await routeDecisionWorker(advisor, settings, prompt, exec.signal) : { profileName: args.model_profile }
        const profile = routed.profileName === '' ? undefined : config.coding().workerProfiles[routed.profileName]
        if (routed.profileName !== '' && profile === undefined) throw new Error(`Unknown worker model profile: ${routed.profileName}`)
        if (profile !== undefined && (!profile.provider.trim() || !profile.model.trim())) throw new Error('Worker profile requires a provider and model')
        const result = await ctx.agentTeams.spawnTeammate(agent, {
          name: args.name,
          description: args.description,
          prompt: [{ type: 'text', text: prompt }],
          ...profile === undefined ? {} : { agentOptions: {
            provider: profile.provider, model: profile.model,
            ...profile.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(profile.reasoningEffort) },
            ...profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens },
          } },
          context,
          provider: context === 'fork' ? config.forkProvider : config.freshProvider,
          signal: exec.signal,
        })
        return { member: modelMember(result.member), ...routed.receipt === undefined ? {} : { routing: routed.receipt } }
      },
    })))

    register(scoped.systemPrompt.context({
      name: 'team:checkpoint', required: true, order: scoped.systemPrompt.getContextOrder('TEAM_IDENTITY'),
      text: () => {
        const checkpoint = ctx.agentTeams.getCheckpoint(agent)
        return checkpoint === undefined ? '' : `Project coordinator checkpoint: ${JSON.stringify(checkpoint)}\nTask dependencies and accepted verification remain on the shared task board. Read current revisions before changes. Use this checkpoint to recover relevant work; the current user request takes precedence. Check task status before resuming next actions.`
      },
    }))
    register(scoped.tools.register(defineTool({
      name: 'team_checkpoint',
      description: 'Persist the supervisor project goal, constraints and next actions across interruption and compaction. Update only when those facts change; read the current checkpoint from team_dispatch_status.',
      parameters: {
        expected_revision: { type: 'integer', required: true, description: 'Current checkpoint revision; 0 before the first checkpoint.' },
        goal: { type: 'string', required: true },
        constraints: { type: 'array', required: true, items: { type: 'string' } },
        next_actions: { type: 'array', required: true, items: { type: 'string' } },
      },
      output: jsonOutput(CHECKPOINT_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.updateCheckpoint(callingAgent(exec.agent, 'team_checkpoint'), {
          expectedRevision: args.expected_revision, goal: args.goal, constraints: args.constraints, nextActions: args.next_actions,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_dispatch',
      description: 'Authorize a batch of complete coding assignments. Ready tasks start automatically within the concurrency limit; dependencies wait for supervisor acceptance. Use direct editing for small changes.',
      parameters: {
        select_supervisor: { type: 'boolean', description: 'Explicitly switch the Lead to the configured supervisor profile. Omit to preserve its current model and context cache; worker model profiles never change the Lead.' },
        goal: { type: 'string', description: 'Overall user goal; required for the first coding dispatch, saved without an extra checkpoint call.' },
        constraints: { type: 'array', items: { type: 'string' } },
        next_actions: { type: 'array', items: { type: 'string' } },
        checkpoint_revision: { type: 'integer', description: 'Current checkpoint revision when replacing its goal; 0 initially.' },
        assignments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          task_id: { type: 'string', required: true }, expected_revision: { type: 'integer', required: true },
          name: { type: 'string', required: true, description: 'Unique lower-kebab-case worker name.' },
          model_profile: { type: 'string', description: 'Approved route; omission uses bounded automatic routing or the configured default.' },
          isolation: { type: 'string', enum: ['shared', 'worktree'], description: 'Defaults to worktree for writes and shared for explicitly read-only assignments. Worktrees start from HEAD when ready; the supervisor integrates prerequisite commits before acceptance.' },
        } } },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { queued: { type: 'integer', required: true } } }),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_dispatch')
        if (ctx.agentTeams.membership(caller).role !== 'lead') throw new Error('Only the supervisor may dispatch work')
        const checkpoint = ctx.agentTeams.getCheckpoint(caller)
        if (config.coding().requireTaskBrief && checkpoint === undefined && !args.goal?.trim()) {
          throw new Error('Include the overall goal in the first coding dispatch so it survives interruptions')
        }
        const supervisorName = args.select_supervisor === true ? config.coding().supervisorProfile ?? '' : ''
        const supervisor = supervisorName === '' ? undefined : config.coding().workerProfiles[supervisorName]
        if (supervisorName !== '' && supervisor === undefined) {
          throw new Error(`Unknown supervisor model profile: ${supervisorName}`)
        }
        const selection = supervisor === undefined ? undefined : { provider: supervisor.provider, model: supervisor.model,
          ...supervisor.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(supervisor.reasoningEffort) } }
        if (selection !== undefined) {
          const llm = ctx.get('llm')
          if (llm === undefined) throw new Error('Supervisor selection requires the LLM service')
          await llm.resolveCallConfig(selection)
        }
        const settings = config.coding()
        const tasks = args.assignments.map((assignment) => {
          const task = ctx.agentTeams.getTask(caller, TeamTaskId(assignment.task_id))
          assertTaskBrief(task.description)
          if (assignment.model_profile !== undefined && assignment.model_profile !== ''
            && settings.workerProfiles[assignment.model_profile] === undefined) throw new Error(`Unknown worker model profile: ${assignment.model_profile}`)
          return { assignment, task }
        })
        const inferred = await routeDecisionWorkers(advisor, settings,
          tasks.flatMap(({ assignment, task }) => assignment.model_profile === undefined ? [task.description] : []), exec.signal)
        let inference = 0
        const requests = []
        for (const { assignment, task } of tasks) {
          const routed = assignment.model_profile === undefined
            ? inferred[inference++] ?? { profileName: settings.defaultWorkerProfile } : { profileName: assignment.model_profile }
          const profile = routed.profileName === '' ? undefined : settings.workerProfiles[routed.profileName]
          if (routed.profileName !== '' && profile === undefined) throw new Error(`Unknown worker model profile: ${routed.profileName}`)
          exec.signal.throwIfAborted()
          requests.push({ taskId: task.id, expectedRevision: assignment.expected_revision, name: assignment.name,
            isolation: assignment.isolation ?? (task.writeScopes.length > 0 ? 'worktree' as const : 'shared' as const),
            provider: config.freshProvider,
            ...profile === undefined ? {} : { agentOptions: {
              provider: profile.provider, model: profile.model,
              ...profile.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(profile.reasoningEffort) },
              ...profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens },
            } },
          })
        }
        exec.signal.throwIfAborted()
        if (args.goal !== undefined) await ctx.agentTeams.updateCheckpoint(caller, {
          expectedRevision: args.checkpoint_revision ?? 0, goal: args.goal,
          constraints: args.constraints ?? [], nextActions: args.next_actions ?? [],
        })
        await ctx.agentTeams.queueTasks(caller, requests)
        if (selection !== undefined) caller.model.select(selection)
        return { queued: requests.length }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_dispatch_status',
      description: 'Read compact durable dispatch status. Supply task_id for its full worker report, current task revision and retained worktree details. Review, integrate and verify actual changes before acceptance.',
      parameters: {
        task_id: { type: 'string', description: 'Select one assignment and include its full report.' },
        cursor: { type: 'integer', description: 'Zero-based offset, defaults to 0.' },
        limit: { type: 'integer', description: 'Rows from 1 through 20, defaults to 10.' },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
        checkpoint: CHECKPOINT_SCHEMA,
        assignments: { type: 'array', required: true, items: DISPATCH_VIEW_SCHEMA }, nextCursor: { type: 'integer' },
      } }),
      execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_dispatch_status')
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? 10
        if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
          throw new Error('Use a non-negative cursor and limit from 1 through 20')
        }
        const filtered = ctx.agentTeams.listDispatches(caller).filter(item => args.task_id === undefined || item.taskId === args.task_id)
        const checkpoint = ctx.agentTeams.getCheckpoint(caller)
        return Promise.resolve({ ...checkpoint === undefined ? {} : { checkpoint },
          assignments: filtered.slice(cursor, cursor + limit).map(item => ({
            taskId: item.taskId, revision: ctx.agentTeams.getTask(caller, item.taskId).revision,
            name: item.name, phase: item.phase, isolation: item.isolation,
            taskStatus: ctx.agentTeams.getTask(caller, item.taskId).status,
            ...item.agentOptions === undefined ? {} : { model: item.agentOptions.model, modelProvider: item.agentOptions.provider },
            ...item.report === undefined ? {} : { summary: item.report.summary.slice(0, 500) },
            ...item.error === undefined ? {} : { error: item.error },
            ...item.checkout === undefined ? {} : { checkout: item.checkout },
            ...args.task_id === undefined || item.report === undefined ? {} : { report: item.report },
          })), ...cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {} })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_report',
      description: 'Report your assigned coding result or blocker. Include actual changed files, executed checks with results and remaining risks. This does not accept or complete the task. Finish owned background work first.',
      parameters: {
        task_id: { type: 'string', required: true }, outcome: { type: 'string', required: true, enum: ['ready', 'blocked'] },
        summary: { type: 'string', required: true }, changed_files: { type: 'array', required: true, items: { type: 'string' } },
        checks: { type: 'array', required: true, items: { type: 'string' } }, risks: { type: 'string', required: true },
      },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { reported: { type: 'boolean', required: true } } }),
      async execute(args, exec) {
        await ctx.agentTeams.reportTask(callingAgent(exec.agent, 'team_task_report'), TeamTaskId(args.task_id), args.outcome,
          { summary: args.summary, changedFiles: args.changed_files, checks: args.checks, risks: args.risks })
        return { reported: true }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_dispatch_cancel',
      description: 'Cancel and drain a dispatched worker before releasing task ownership. Retain worktree files and commits for inspection; never assume cancellation undoes edits.',
      parameters: { task_id: { type: 'string', required: true } },
      output: jsonOutput({ type: 'object', additionalProperties: false, properties: { cancelled: { type: 'boolean', required: true } } }),
      async execute(args, exec) {
        await ctx.agentTeams.cancelDispatch(callingAgent(exec.agent, 'team_dispatch_cancel'), TeamTaskId(args.task_id))
        return { cancelled: true }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'send_message',
      description: 'Send one message to another Team member. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member target returned by spawn_teammate or list_agents, including lead.' },
        message: { type: 'string', required: true, description: 'Self-contained message for the target.' },
      },
      output: jsonOutput(SEND_VALUE_SCHEMA),
      async execute(args, exec) {
        await ctx.agentTeams.sendMessage(callingAgent(exec.agent, 'send_message'), {
          target: args.target,
          content: [{ type: 'text', text: args.message }],
          signal: exec.signal,
        })
        return { sent: true }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'list_agents',
      description: 'List the Lead and every durable teammate with an addressable target and current availability. inactive means no turn is executing, not a task result. provisioning and failed describe member creation.',
      parameters: {},
      output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
      execute(_args, exec) {
        return Promise.resolve(ctx.agentTeams.listMembers(callingAgent(exec.agent, 'list_agents')).map(modelMember))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'wait_agent',
      description: 'Wait for the next teammate status, message, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.',
      parameters: {
        timeout_ms: {
          type: 'integer',
          description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.',
        },
      },
      output: jsonOutput(WAIT_VALUE_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'wait_agent')
        const timeoutMs = args.timeout_ms ?? 30_000
        // Preserve TeamService's authoritative timeout validation before the
        // model-only no-progress shortcut.
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
          return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
        }
        // The active-peer read and waiter registration must remain one synchronous
        // span; awaiting between them can lose the only peer-status edge.
        const hasActivePeer = ctx.agentTeams.listMembers(caller).some(member =>
          member.id !== caller.id && ACTIVE_WAIT_STATUSES.has(member.status))
        if (!hasActivePeer) {
          return {
            timedOut: false,
            noProgress: {
              reason: 'no-active-peer' as const,
              message: NO_ACTIVE_PEER_MESSAGE,
            },
          }
        }
        return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
      },
    })))

    if (config.interrupt) {
      register(scoped.tools.register(defineTool({
        name: 'interrupt_agent',
        description: 'Interrupt one teammate\'s current turn while preserving its pending inbox. Team Lead only.',
        parameters: {
          target: { type: 'string', required: true, description: 'Teammate target returned by spawn_teammate or list_agents.' },
        },
        output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
        execute(args, exec) {
          return Promise.resolve(ctx.agentTeams.interrupt(callingAgent(exec.agent, 'interrupt_agent'), args.target))
        },
      })))
    }

    register(scoped.tools.register(defineTool({
      name: 'team_task_create',
      description: 'Create one unowned pending task on the shared Team task board.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise task title.' },
        description: { type: 'string', required: true, description: 'Complete task details. For dispatched coding work, use nonempty Markdown sections: ## Objective, ## Inputs, ## Scope, ## Acceptance, ## Verification, ## Stop conditions.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
        write_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Advisory workspace-relative file or directory prefixes this task expects to modify.',
        },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.createTask(callingAgent(exec.agent, 'team_task_create'), {
          subject: args.subject,
          description: args.description,
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_list',
      description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
      parameters: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'Optional exact status filter.',
        },
        owner: { type: 'string', description: 'Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner.' },
        ready: { type: 'boolean', description: 'Optional readiness filter.' },
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
      },
      output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
      execute(args, exec) {
        const status = args.status
        const filtered = ctx.agentTeams.listTasks(callingAgent(exec.agent, 'team_task_list')).filter(task =>
          (status === undefined || task.status === status)
          && (args.owner === undefined || (args.owner === 'unowned' ? task.ownerName === undefined : task.ownerName === args.owner))
          && (args.ready === undefined || task.ready === args.ready))
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? 50
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
        return Promise.resolve({
          tasks: filtered.slice(cursor, cursor + limit),
          ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_get',
      description: 'Read the complete latest value of one shared task before changing or executing it.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.getTask(
          callingAgent(exec.agent, 'team_task_get'),
          TeamTaskId(args.task_id),
        ))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_update',
      description: 'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision used as the CAS precondition.' },
        action: {
          type: 'string',
          required: true,
          enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'],
          description: 'Task transition to apply.',
        },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details. Dispatched coding briefs require nonempty Markdown sections: ## Objective, ## Inputs, ## Scope, ## Acceptance, ## Verification, ## Stop conditions.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement advisory write scopes for edit.' },
        evidence: { type: 'string', description: 'Checks actually run and their results, required for supervisor completion in coding mode.' },
        owner: { type: 'string', description: 'Member target from spawn_teammate or list_agents for Lead-only reassign; omit to unassign.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_task_update')
        if (config.coding().requireTaskBrief && args.action === 'complete') {
          if (ctx.agentTeams.membership(caller).role !== 'lead') throw new Error('Only the supervisor may accept and complete coding tasks; report your result to the Lead')
          if (!args.evidence?.trim()) throw new Error('Task completion requires verification evidence')
        }
        return await ctx.agentTeams.updateTask(caller, {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: args.expected_revision,
          action: args.action,
          ...args.evidence === undefined ? {} : { evidence: args.evidence },
          ...args.subject === undefined ? {} : { subject: args.subject },
          ...args.description === undefined ? {} : { description: args.description },
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
          ...args.owner === undefined ? {} : { owner: args.owner },
        })
      },
    })))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/** Install Team tools in every live or subsequently published Team member scope. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = {
    coding: () => config.coding?.get() ?? DEFAULT_CODING,
    interrupt: config.interrupt ?? true,
    freshProvider: config.freshProvider ?? 'spawn',
    forkProvider: config.forkProvider ?? 'fork',
  }
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return
    installed.set(agent, install(agent, ctx, resolved))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-team.scopedTools()')
}
