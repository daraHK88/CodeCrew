/** Durable ready-task dispatch; the Lead retains review, integration and retry authority. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import type {} from '@deepseek-ai/dsh-jobs'
import type { TeamJournal } from './journal.ts'
import type { TeamRoster } from './roster.ts'
import type { TeamRuntimeLifecycle } from './lifecycle.ts'
import { TeamError, errorMessage } from './error.ts'
import { TeamId } from './types.ts'
import type { QueueTeamTaskRequest, TeamDispatchSnapshot, TeamTaskReport, TeamTaskId } from './types.ts'
import { projectTaskView } from './task-view.ts'
import { requiredText } from './validation.ts'
import { canManageTask } from './task-authority.ts'

/**
 * Reject incomplete coding assignments before any worker starts.
 * @param description - full shared-task brief.
 */
export function assertTaskBrief(description: string): void {
  const sections = new Map(description.split(/^#{1,6}\s+/m).slice(1).map((section) => {
    const [heading = '', ...body] = section.split(/\r?\n/)
    return [heading.trim().toLowerCase(), body.join('\n').trim()]
  }))
  for (const heading of ['Objective', 'Inputs', 'Scope', 'Acceptance', 'Verification', 'Stop conditions']) {
    if (!sections.get(heading.toLowerCase())) throw new TeamError(`Task brief requires a complete ${heading} section with actionable content. Use six nonempty Markdown sections: ## Objective, ## Inputs, ## Scope, ## Acceptance, ## Verification, ## Stop conditions. Inline labels are not sections.`, 'TEAM_INVALID_ARGUMENT')
  }
}

/** Owns queued assignment admission, bounded execution, reports and uncertain-outcome containment. */
export class TeamDispatcher {
  private readonly pending = new Map<Agent, { dirty: boolean; promise?: Promise<void> }>()
  private readonly halted = new Set<Agent>()

  /**
   * @param ctx - runtime services, including optional worktree preparation.
   * @param journal - serialized durable Team state owner.
   * @param roster - exact membership and child lifecycle owner.
   * @param lifecycle - shared cancellation and settlement owner.
   * @param concurrency - maximum occupied worker slots per Team.
   */
  constructor(private readonly ctx: Context, private readonly journal: TeamJournal,
    private readonly roster: TeamRoster, private readonly lifecycle: TeamRuntimeLifecycle,
    private readonly concurrency: number) {}

  /**
   * Record supervisor authorization without waiting for worker results.
   * @param caller - exact live Lead.
   * @param requests - current task revisions and approved worker routes.
   * @returns current durable assignments after admission.
   */
  async queue(caller: Agent, requests: readonly QueueTeamTaskRequest[]): Promise<readonly TeamDispatchSnapshot[]> {
    const membership = this.roster.membership(caller)
    const root = membership.root
    if (this.lifecycle.disposed || this.halted.has(root)) throw new TeamError('Dispatch is stopped; inspect the runtime error before resuming', 'TEAM_DISPATCH_STOPPED')
    if (requests.length === 0) throw new TeamError('Provide at least one task assignment', 'TEAM_INVALID_ARGUMENT')
    await this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const ids = new Set<TeamTaskId>()
      const names = new Set(state.members.map(member => member.name))
      for (const item of state.dispatches) names.add(item.name)
      for (const request of requests) {
        const task = state.tasks.find(item => item.id === request.taskId)
        if (task === undefined || task.revision !== request.expectedRevision || task.status !== 'pending' || task.ownerId !== undefined) {
          throw new TeamError('Dispatch requires an unowned pending task at its current revision', 'TEAM_TASK_STALE_REVISION')
        }
        if (!canManageTask(state, caller.id, task)) throw new TeamError('Only the assigned supervisor may dispatch this task', 'TEAM_LEAD_REQUIRED')
        if (request.role === 'supervisor' && request.isolation !== 'shared') throw new TeamError('Supervisors coordinate shared packages; isolate leaf writers instead', 'TEAM_INVALID_ARGUMENT')
        if ((request.skills?.length ?? 0) > 4) throw new TeamError('Assign at most four relevant skills', 'TEAM_INVALID_ARGUMENT')
        for (const skill of request.skills ?? []) requiredText(skill, 'skill', 200)
        if (ids.has(task.id) || state.dispatches.some(item => item.taskId === task.id && item.phase !== 'cancelled')) throw new TeamError('Task already has a dispatch; inspect or cancel it', 'TEAM_DISPATCH_EXISTS')
        if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(request.name) || names.has(request.name)) throw new TeamError('Dispatch requires a unique lower-kebab-case worker name', 'TEAM_MEMBER_NAME_TAKEN')
        requiredText(request.provider, 'provider', 200)
        assertTaskBrief(task.description)
        if (request.isolation === 'shared' && task.writeScopes.length === 0 && !/^none\b/im.test(task.description.split(/^#{1,6}\s+Scope\s*$/im)[1]?.split(/^#/m)[0]?.trim() ?? '')) {
          throw new TeamError('Shared assignments require explicit write_scopes, or Scope: None for read-only work', 'TEAM_INVALID_ARGUMENT')
        }
        if (request.isolation === 'worktree' && this.ctx.get('worktrees') === undefined) throw new TeamError('Worktree isolation requires the worktree service', 'TEAM_INVALID_CONFIG')
        ids.add(task.id)
        names.add(request.name)
      }
      // Every request is validated before the first checkpoint. A storage failure
      // can retain an admitted prefix; callers must inspect before resubmitting.
      for (const request of requests) {
        const { expectedRevision, ...worker } = request
        await this.save(root, { ...worker, taskRevision: expectedRevision, phase: 'queued' })
      }
    })
    this.schedule(root)
    return this.list(caller)
  }

  /**
   * Read assignment status through the authoritative Team projection.
   * @param caller - exact live Team member.
   * @returns detached durable assignments.
   */
  list(caller: Agent): readonly TeamDispatchSnapshot[] {
    return structuredClone(this.journal.state(this.roster.membership(caller).root).dispatches)
  }

  /**
   * Record a worker's outcome for supervisor review, without completing its task.
   * @param caller - exact live assigned worker.
   * @param taskId - owned dispatched task.
   * @param outcome - reviewable result or blocker.
   * @param report - bounded changed-file, check and risk evidence.
   */
  async report(caller: Agent, taskId: TeamTaskId, outcome: 'ready' | 'blocked', report: TeamTaskReport): Promise<void> {
    if (this.lifecycle.disposed) throw new TeamError('Dispatch runtime is disposing', 'TEAM_DISPOSED')
    const { root, name, role } = this.roster.membership(caller)
    await this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const assignment = state.dispatches.find(item => item.taskId === taskId)
      const task = state.tasks.find(item => item.id === taskId)
      if (role !== 'teammate' || assignment?.name !== name || task?.ownerId !== caller.id
        || !['starting', 'running', 'waiting'].includes(assignment.phase)) throw new TeamError('Only the current assigned worker can report an active assignment', 'TEAM_TASK_UNAUTHORIZED')
      requiredText(report.summary, 'summary', 4_000)
      requiredText(report.risks, 'risks', 4_000)
      if (outcome === 'ready' && this.hasJobs(caller)) throw new TeamError('Finish owned background checks before reporting ready', 'TEAM_TASK_JOBS_RUNNING')
      if (outcome === 'ready' && state.tasks.some(child => child.parentTaskId === taskId && child.status !== 'completed' && child.status !== 'deleted')) {
        throw new TeamError('Accept all child tasks before reporting the package ready', 'TEAM_TASK_BLOCKED')
      }
      if (outcome === 'ready' && report.checks.length === 0) throw new TeamError('A ready report requires checks actually run', 'TEAM_INVALID_ARGUMENT')
      for (const path of report.changedFiles) requiredText(path, 'changed file', 1_000)
      for (const check of report.checks) requiredText(check, 'check result', 2_000)
      if (Buffer.byteLength(JSON.stringify(report)) > 16_384) throw new TeamError('Worker report exceeds 16384 bytes', 'TEAM_INVALID_ARGUMENT')
      await this.save(root, { ...assignment, phase: outcome === 'ready' ? 'review' : 'blocked', report: structuredClone(report) })
    })
    await this.notifySupervisor(root, taskId, `${taskId}: ${outcome === 'ready' ? 'awaiting supervisor review and integration' : 'blocked; inspect before retrying'}. Read team_dispatch_status with task_id for the current revision and full report; verify the actual diff and checks. The task remains incomplete.`)
    this.schedule(root)
  }

  /**
   * Keep a dispatched worker resident while its owned background checks finish.
   * The existing job controller delivers the completion; this wait never consumes output or polls.
   * @param agent - exact worker whose otherwise completed turn is stopping.
   * @param turnSignal - cancellation of that turn.
   */
  async waitForJobs(agent: Agent, turnSignal: AbortSignal): Promise<void> {
    const membership = this.roster.tryMembership(agent)
    if (membership?.role !== 'teammate' || !this.hasJobs(agent)) return
    const root = membership.root
    const assignment = this.journal.state(root).dispatches.find(item => item.name === membership.name)
    if (assignment === undefined || !['starting', 'running', 'waiting'].includes(assignment.phase)) return
    const jobs = this.ctx.get('jobs')
    if (jobs === undefined) return
    const signal = AbortSignal.any([turnSignal, this.lifecycle.signal])
    await this.journal.transact(root.id, async () => {
      const current = this.journal.state(root).dispatches.find(item => item.taskId === assignment.taskId)
      if (current !== undefined && (current.phase === 'running' || current.phase === 'starting')) {
        await this.save(root, { ...current, phase: 'waiting' })
      }
    })
    let stop = (): void => undefined
    let onAbort = (): void => undefined
    try {
      await new Promise<void>((resolve, reject) => {
        const inspect = (): void => { if (!this.hasJobs(agent)) resolve() }
        stop = jobs.events.subscribe({ owner: agent.id }, (event) => {
          if (event.type !== 'output') inspect()
        })
        onAbort = () => { reject(new TeamError('Background check wait cancelled', 'TEAM_DISPOSED', { cause: signal.reason })) }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        else inspect()
      })
    } finally {
      signal.removeEventListener('abort', onAbort)
      stop()
    }
  }

  /** Whether this exact worker still owns a running or stopping job. */
  private hasJobs(agent: Agent): boolean {
    return this.ctx.get('jobs')?.list(agent.id).some(job => job.owner === agent.id
      && (job.status === 'running' || job.status === 'stopping')) ?? false
  }

  /**
   * Cancel an assignment and await its worker branch before releasing ownership.
   * @param caller - exact live Lead.
   * @param taskId - assignment to cancel; retained worktree files are preserved.
   */
  async cancel(caller: Agent, taskId: TeamTaskId): Promise<void> {
    const root = this.roster.membership(caller).root
    const state = this.journal.state(root)
    const task = state.tasks.find(item => item.id === taskId)
    if (task === undefined || !canManageTask(state, caller.id, task)) throw new TeamError('Only the assigned supervisor may cancel dispatched work', 'TEAM_LEAD_REQUIRED')
    for (const child of state.tasks.filter(item => item.parentTaskId === taskId && item.status !== 'completed' && item.status !== 'deleted')) {
      if (state.dispatches.some(item => item.taskId === child.id && item.phase !== 'cancelled')) await this.ctx.agentTeams.cancelDispatch(caller, child.id)
    }
    await this.journal.transact(root.id, async () => {
      const assignment = this.journal.state(root).dispatches.find(item => item.taskId === taskId)
      if (assignment === undefined) throw new TeamError('Dispatched task not found', 'TEAM_TASK_NOT_FOUND')
      if (this.journal.state(root).tasks.some(task => task.id === taskId && task.status === 'completed')) throw new TeamError('Accepted work cannot be cancelled; explicitly reopen the task first', 'TEAM_TASK_INVALID_TRANSITION')
      await this.save(root, { ...assignment, phase: 'cancelled' })
    })
    // The scheduler may still be preparing this assignment. It observes cancelled
    // before starting; cancellation also waits for that preparation to settle.
    await this.pending.get(root)?.promise
    const assignment = this.journal.state(root).dispatches.find(item => item.taskId === taskId)
    const member = this.journal.state(root).members.find(item => item.name === assignment?.name)
    if (member !== undefined) await this.roster.stopTeammates(root, [member.id])
  }

  /**
   * Coalesce event-driven dispatch and keep every admitted operation lifecycle-owned.
   * @param root - exact live Lead with committed task or worker activity.
   */
  schedule(root: Agent): void {
    if (this.lifecycle.disposed || this.halted.has(root)) return
    const running = this.pending.get(root)
    if (running !== undefined) { running.dirty = true; return }
    const work: { dirty: boolean; promise?: Promise<void> } = { dirty: true }
    this.pending.set(root, work)
    const operation = Promise.resolve().then(async () => {
      try {
        while (work.dirty && !this.lifecycle.disposed && this.ctx.agents.get(root.id) === root) {
          work.dirty = false
          await this.tick(root)
        }
      } catch (error: unknown) {
        if (this.lifecycle.disposed) return
        this.halted.add(root)
        this.ctx.logger.error(`Team dispatch stopped for ${root.id}: ${errorMessage(error)}`)
        this.notify(root, 'Dispatch stopped after a runtime or storage failure. Some actions may already have taken effect. Inspect task state and retained worktrees before restarting; no automatic retry will run.')
      } finally { this.pending.delete(root) }
    })
    work.promise = this.lifecycle.track(operation)
  }

  /** Reconcile disappeared or inactive workers without treating inactivity as success. */
  private async tick(root: Agent): Promise<void> {
    // Wait for the complete authorization transaction, not its first flushed row.
    const state = await this.journal.transact(root.id, () => Promise.resolve(this.journal.state(root)))
    for (const item of state.dispatches) {
      const task = state.tasks.find(task => task.id === item.taskId)
      if (task?.status === 'completed' || task?.status === 'deleted') continue
      const member = this.roster.list(this.roster.membership(root)).find(member => member.name === item.name)
      const worker = member === undefined ? undefined : this.ctx.agents.get(member.id)
      const liveJobs = member !== undefined && (this.ctx.get('jobs')?.list(member.id).some(job =>
        job.owner === member.id && (job.status === 'running' || job.status === 'stopping')) ?? false)
      const pendingInput = worker !== undefined && (worker.inbox.nextStep.length > 0 || worker.inbox.nextTurn.length > 0)
      const childrenPending = item.role === 'supervisor' && state.tasks.some(child => child.parentTaskId === item.taskId
        && child.status !== 'completed' && child.status !== 'deleted' && state.dispatches.some(assignment => assignment.taskId === child.id
          && ['queued', 'starting', 'running', 'waiting'].includes(assignment.phase)))
      const waiting = (item.phase === 'running' || item.phase === 'waiting') && member?.status !== 'running' && (liveJobs || childrenPending)
      const resumed = item.phase === 'waiting' && member?.status === 'running' && !liveJobs
      if ((waiting && item.phase !== 'waiting') || resumed) {
        await this.journal.transact(root.id, async () => {
          const current = this.journal.state(root).dispatches.find(next => next.taskId === item.taskId)
          if (current === item) await this.save(root, { ...item, phase: waiting ? 'waiting' : 'running' })
        })
        continue
      }
      if (waiting || (pendingInput && item.phase !== 'starting')) continue
      if (item.phase === 'starting' || ((item.phase === 'running' || item.phase === 'waiting') && member?.status !== 'running')) {
        await this.journal.transact(root.id, async () => {
          const current = this.journal.state(root).dispatches.find(next => next.taskId === item.taskId)
          if (current !== item) return
          await this.save(root, { ...item, phase: 'blocked', error: 'Worker stopped or execution was interrupted without a final report. Inspect changes; cancel before replacing it.' })
        })
        await this.notifySupervisor(root, item.taskId, `${item.taskId}: worker stopped without a reviewable result. Inspect team_dispatch_status and cancel before replacing the assignment.`)
      }
    }
    let occupied = this.journal.state(root).dispatches.filter((item) => {
      const member = this.roster.list(this.roster.membership(root)).find(member => member.name === item.name)
      const worker = member === undefined ? undefined : this.ctx.agents.get(member.id)
      return item.phase === 'starting' || item.phase === 'running'
        || (item.phase === 'waiting' && (item.role !== 'supervisor' || (worker !== undefined && this.hasJobs(worker))))
        || member?.status === 'running'
    }).length
    const ready: { assignment: TeamDispatchSnapshot; brief: string; scopes: readonly string[] }[] = []
    for (const assignment of this.journal.state(root).dispatches) {
      if (occupied >= this.concurrency || this.lifecycle.disposed) break
      if (assignment.phase !== 'queued') continue
      const task = this.journal.state(root).tasks.find(task => task.id === assignment.taskId)
      if (task === undefined) continue
      if (task.parentTaskId !== undefined && !this.journal.state(root).dispatches.some(parent => parent.taskId === task.parentTaskId
        && parent.role === 'supervisor' && ['starting', 'running', 'waiting'].includes(parent.phase))) {
        await this.journal.transact(root.id, () => this.save(root, { ...assignment, phase: 'blocked', error: 'Parent supervisor is unavailable; inspect before reauthorizing child work.' }))
        this.notify(root, `${assignment.taskId}: parent supervisor unavailable; no worker started.`)
        continue
      }
      if (task.revision !== assignment.taskRevision || task.status !== 'pending' || task.ownerId !== undefined) {
        await this.journal.transact(root.id, () => this.save(root, { ...assignment, phase: 'blocked', error: 'Task changed after dispatch authorization; inspect and create a revised assignment.' }))
        this.notify(root, `${assignment.taskId}: authorization is stale; no worker started.`)
        continue
      }
      const view = projectTaskView(this.journal.state(root), task)
      if (!view.ready || (assignment.isolation === 'shared' && (view.writeScopeWarnings.length > 0
        || ready.some(item => item.assignment.isolation === 'shared' && item.scopes.some(left => task.writeScopes.some(right =>
          left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`))))))) continue
      occupied++
      ready.push({ assignment, brief: task.description, scopes: task.writeScopes })
    }
    const outcomes = await Promise.allSettled(ready.map(item => this.start(root, item.assignment, item.brief)))
    const failures: unknown[] = []
    for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Ready assignment startup failed')
  }

  /** Reserve a slot before preparing the checkout or publishing a child. */
  private async start(root: Agent, queued: TeamDispatchSnapshot, brief: string): Promise<void> {
    let assignment: TeamDispatchSnapshot = { ...queued, phase: 'starting' }
    await this.journal.transact(root.id, () => this.save(root, assignment))
    try {
      if (assignment.isolation === 'worktree') {
        const worktrees = this.ctx.get('worktrees')
        if (worktrees === undefined) throw new TeamError('Worktree service unavailable', 'TEAM_INVALID_CONFIG')
        const checkout = await worktrees.create(root, { enter: false }, this.lifecycle.signal)
        assignment = { ...assignment, checkout }
        await this.journal.transact(root.id, async () => {
          const current = this.journal.state(root).dispatches.find(item => item.taskId === assignment.taskId)
          await this.save(root, { ...assignment, phase: current?.phase === 'cancelled' ? 'cancelled' : 'starting' })
        })
      }
      if (this.journal.state(root).dispatches.find(item => item.taskId === assignment.taskId)?.phase === 'cancelled') return
      await this.roster.spawn(root, {
        name: assignment.name, description: `${assignment.role === 'supervisor' ? 'Supervisor package' : 'Assignment'} ${assignment.taskId}`,
        assignment: { taskId: assignment.taskId, expectedRevision: assignment.taskRevision },
        prompt: [{ type: 'text', text: `You own ${assignment.taskId}; it has already been claimed for you.\n${assignment.role === 'supervisor' ? 'You supervise this work package. Create small child tasks with parent_task_id pointing to your task. Delegate each independent component to a fresh specialist; coordinate interfaces, inspect reports and accept children with evidence. Do not edit files while your children own them. Report only after every child is accepted. ' : ''}${brief}\n\nReuse the project's established patterns. Read relevant code and instructions before editing. Verify requirements and meaningful failure cases. Avoid speculative abstractions or unrelated changes. ${assignment.checkout === undefined ? 'Respect the declared write scopes.' : `Work only in your isolated checkout ${assignment.checkout.path}. Commit your scoped changes there and include the branch in your report; the Lead integrates them.`}\nReport with team_task_report: changed files, checks actually run with results, and remaining risks. A ready report is not acceptance. Do not complete the shared task yourself. If blocked, report the evidence instead of retrying blindly. Finish all owned background work before reporting.` }],
        ...assignment.checkout === undefined ? {} : { cwd: assignment.checkout.path },
        ...assignment.agentOptions === undefined ? {} : { agentOptions: assignment.agentOptions },
        context: 'fresh', provider: assignment.provider, signal: this.lifecycle.signal,
      })
      await this.journal.transact(root.id, async () => {
        const current = this.journal.state(root).dispatches.find(item => item.taskId === assignment.taskId)
        if (current?.phase === 'starting') await this.save(root, { ...current, phase: 'running' })
      })
    } catch (error: unknown) {
      if (this.lifecycle.disposed) throw error
      await this.journal.transact(root.id, async () => {
        const current = this.journal.state(root).dispatches.find(item => item.taskId === assignment.taskId)
        if (current?.phase !== 'cancelled') await this.save(root, { ...assignment, phase: 'blocked', error: errorMessage(error).slice(0, 4_000) })
      })
      await this.notifySupervisor(root, assignment.taskId, `${assignment.taskId}: dispatch failed. Inspect the error and any retained checkout before replacing the assignment.`)
    }
  }

  /** Checkpoint assignment effects before exposing the new status. */
  private async save(root: Agent, dispatch: TeamDispatchSnapshot): Promise<void> {
    await this.journal.appendAndFlush(root, 'team/dispatch', { version: 2, teamId: TeamId(root.id), dispatch })
  }

  /** Notify the responsible package supervisor; retain root visibility if it cannot resume. */
  private async notifySupervisor(root: Agent, taskId: TeamTaskId, text: string): Promise<void> {
    const state = this.journal.state(root)
    const parentId = state.tasks.find(task => task.id === taskId)?.parentTaskId
    const parent = state.dispatches.find(item => item.taskId === parentId && item.role === 'supervisor'
      && ['starting', 'running', 'waiting'].includes(item.phase))
    if (parent !== undefined) {
      try {
        await this.ctx.agentTeams.sendMessage(root, { target: parent.name,
          content: [{ type: 'text', text }], signal: this.lifecycle.signal })
        return
      } catch (error: unknown) {
        this.ctx.logger.warn(error)
      }
    }
    this.notify(root, text)
  }

  /** Wake the supervisor with an actionable report, without requiring another worker model. */
  private notify(root: Agent, text: string): void {
    root.steer(createUserMessage({ source: { kind: 'agent-message', form: 'relay', senderSessionId: root.id }, content: [{ type: 'text', text: `Coding supervisor: ${text}` }] }))
  }
}
