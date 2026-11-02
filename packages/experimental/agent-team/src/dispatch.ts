/** Durable ready-task dispatch; the Lead retains review, integration and retry authority. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import type { TeamJournal } from './journal.ts'
import type { TeamRoster } from './roster.ts'
import type { TeamRuntimeLifecycle } from './lifecycle.ts'
import { TeamError, errorMessage } from './error.ts'
import { TeamId } from './types.ts'
import type { QueueTeamTaskRequest, TeamDispatchSnapshot, TeamTaskReport, TeamTaskId } from './types.ts'
import { projectTaskView } from './task-view.ts'
import { requiredText } from './validation.ts'

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
    if (!sections.get(heading.toLowerCase())) throw new TeamError(`Task brief requires a ${heading} section with actionable content`, 'TEAM_INVALID_ARGUMENT')
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
    if (membership.role !== 'lead') throw new TeamError('Only the supervisor may dispatch work', 'TEAM_LEAD_REQUIRED')
    if (this.lifecycle.disposed || this.halted.has(caller)) throw new TeamError('Dispatch is stopped; inspect the runtime error before resuming', 'TEAM_DISPATCH_STOPPED')
    if (requests.length === 0) throw new TeamError('Provide at least one task assignment', 'TEAM_INVALID_ARGUMENT')
    await this.journal.transact(caller.id, async () => {
      const state = this.journal.state(caller)
      const ids = new Set<TeamTaskId>()
      const names = new Set(state.members.map(member => member.name))
      for (const item of state.dispatches) names.add(item.name)
      for (const request of requests) {
        const task = state.tasks.find(item => item.id === request.taskId)
        if (task === undefined || task.revision !== request.expectedRevision || task.status !== 'pending' || task.ownerId !== undefined) {
          throw new TeamError('Dispatch requires an unowned pending task at its current revision', 'TEAM_TASK_STALE_REVISION')
        }
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
        await this.save(caller, { ...worker, taskRevision: expectedRevision, phase: 'queued' })
      }
    })
    this.schedule(caller)
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
        || !['starting', 'running'].includes(assignment.phase)) throw new TeamError('Only the current assigned worker can report an active assignment', 'TEAM_TASK_UNAUTHORIZED')
      requiredText(report.summary, 'summary', 4_000)
      requiredText(report.risks, 'risks', 4_000)
      if (outcome === 'ready' && report.checks.length === 0) throw new TeamError('A ready report requires checks actually run', 'TEAM_INVALID_ARGUMENT')
      for (const path of report.changedFiles) requiredText(path, 'changed file', 1_000)
      for (const check of report.checks) requiredText(check, 'check result', 2_000)
      if (Buffer.byteLength(JSON.stringify(report)) > 16_384) throw new TeamError('Worker report exceeds 16384 bytes', 'TEAM_INVALID_ARGUMENT')
      await this.save(root, { ...assignment, phase: outcome === 'ready' ? 'review' : 'blocked', report: structuredClone(report) })
    })
    this.notify(root, `${taskId}: ${outcome === 'ready' ? 'awaiting supervisor review and integration' : 'blocked; inspect before retrying'}. Read team_dispatch_status with task_id for the current revision and full report; verify the actual diff and checks. The task remains incomplete.`)
    this.schedule(root)
  }

  /**
   * Cancel an assignment and await its worker branch before releasing ownership.
   * @param caller - exact live Lead.
   * @param taskId - assignment to cancel; retained worktree files are preserved.
   */
  async cancel(caller: Agent, taskId: TeamTaskId): Promise<void> {
    if (this.roster.membership(caller).role !== 'lead') throw new TeamError('Only the supervisor may cancel dispatched work', 'TEAM_LEAD_REQUIRED')
    await this.journal.transact(caller.id, async () => {
      const assignment = this.journal.state(caller).dispatches.find(item => item.taskId === taskId)
      if (assignment === undefined) throw new TeamError('Dispatched task not found', 'TEAM_TASK_NOT_FOUND')
      if (this.journal.state(caller).tasks.some(task => task.id === taskId && task.status === 'completed')) throw new TeamError('Accepted work cannot be cancelled; explicitly reopen the task first', 'TEAM_TASK_INVALID_TRANSITION')
      await this.save(caller, { ...assignment, phase: 'cancelled' })
    })
    // The scheduler may still be preparing this assignment. It observes cancelled
    // before starting; cancellation also waits for that preparation to settle.
    await this.pending.get(caller)?.promise
    const assignment = this.journal.state(caller).dispatches.find(item => item.taskId === taskId)
    const member = this.journal.state(caller).members.find(item => item.name === assignment?.name)
    if (member !== undefined) await this.roster.stopTeammates(caller, [member.id])
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
    const state = this.journal.state(root)
    for (const item of state.dispatches) {
      const task = state.tasks.find(task => task.id === item.taskId)
      if (task?.status === 'completed' || task?.status === 'deleted') continue
      const member = this.roster.list(this.roster.membership(root)).find(member => member.name === item.name)
      if (item.phase === 'starting' || (item.phase === 'running' && member?.status !== 'running')) {
        await this.journal.transact(root.id, async () => {
          const current = this.journal.state(root).dispatches.find(next => next.taskId === item.taskId)
          if (current !== item) return
          await this.save(root, { ...item, phase: 'blocked', error: 'Worker stopped or execution was interrupted without a final report. Inspect changes; cancel before replacing it.' })
        })
        this.notify(root, `${item.taskId}: worker stopped without a reviewable result. Inspect team_dispatch_status and cancel before replacing the assignment.`)
      }
    }
    let occupied = this.journal.state(root).dispatches.filter((item) => {
      const task = this.journal.state(root).tasks.find(task => task.id === item.taskId)
      const member = this.roster.list(this.roster.membership(root)).find(member => member.name === item.name)
      return item.phase === 'starting' || item.phase === 'running' || member?.status === 'running'
        || (item.phase === 'blocked' && task?.status === 'in_progress')
    }).length
    for (const assignment of this.journal.state(root).dispatches) {
      if (occupied >= this.concurrency || this.lifecycle.disposed) break
      if (assignment.phase !== 'queued') continue
      const task = this.journal.state(root).tasks.find(task => task.id === assignment.taskId)
      if (task === undefined) continue
      if (task.revision !== assignment.taskRevision || task.status !== 'pending' || task.ownerId !== undefined) {
        await this.journal.transact(root.id, () => this.save(root, { ...assignment, phase: 'blocked', error: 'Task changed after dispatch authorization; inspect and create a revised assignment.' }))
        this.notify(root, `${assignment.taskId}: authorization is stale; no worker started.`)
        continue
      }
      const view = projectTaskView(this.journal.state(root), task)
      if (!view.ready || (assignment.isolation === 'shared' && view.writeScopeWarnings.length > 0)) continue
      occupied++
      await this.start(root, assignment, task.description)
    }
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
        name: assignment.name, description: `Assignment ${assignment.taskId}`,
        assignment: { taskId: assignment.taskId, expectedRevision: assignment.taskRevision },
        prompt: [{ type: 'text', text: `You own ${assignment.taskId}; it has already been claimed for you.\n${brief}\n\nReuse the project's established patterns. Read relevant code and instructions before editing. Verify requirements and meaningful failure cases. Avoid speculative abstractions or unrelated changes. ${assignment.checkout === undefined ? 'Respect the declared write scopes.' : `Work only in your isolated checkout ${assignment.checkout.path}. Commit your scoped changes there and include the branch in your report; the Lead integrates them.`}\nReport with team_task_report: changed files, checks actually run with results, and remaining risks. A ready report is not acceptance. Do not complete the shared task yourself. If blocked, report the evidence instead of retrying blindly. Finish all owned background work before reporting.` }],
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
      this.notify(root, `${assignment.taskId}: dispatch failed. Inspect the error and any retained checkout before replacing the assignment.`)
    }
  }

  /** Checkpoint assignment effects before exposing the new status. */
  private async save(root: Agent, dispatch: TeamDispatchSnapshot): Promise<void> {
    await this.journal.appendAndFlush(root, 'team/dispatch', { version: 2, teamId: TeamId(root.id), dispatch })
  }

  /** Wake the supervisor with an actionable report, without requiring another worker model. */
  private notify(root: Agent, text: string): void {
    root.steer(createUserMessage({ source: { kind: 'agent-message', form: 'relay', senderSessionId: root.id }, content: [{ type: 'text', text: `Coding supervisor: ${text}` }] }))
  }
}
