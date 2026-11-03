/** Delegated review authority stays on the durable task tree, with one lifecycle root. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamState } from './projection.ts'
import type { TeamDispatchSnapshot, TeamTaskSnapshot } from './types.ts'

/**
 * Find the current active supervisor work package owned by an exact member.
 * @param state - committed Team task and dispatch state.
 * @param memberId - exact member Session identity.
 * @returns its active supervisor assignment, if any.
 */
export function supervisorAssignment(state: TeamState, memberId: SessionId): TeamDispatchSnapshot | undefined {
  return state.dispatches.find(assignment => assignment.role === 'supervisor'
    && ['starting', 'running', 'waiting'].includes(assignment.phase)
    && state.tasks.some(task => task.id === assignment.taskId && task.ownerId === memberId && task.status === 'in_progress'))
}

/**
 * Whether a task belongs below one work package. The package cannot accept itself.
 * @param state - committed Team tasks.
 * @param task - descendant candidate.
 * @param ancestor - owning work-package task id.
 * @returns whether the candidate is below that package.
 */
export function taskDescendsFrom(state: TeamState, task: TeamTaskSnapshot, ancestor: TeamTaskSnapshot['id']): boolean {
  let parent = task.parentTaskId
  const seen = new Set<string>()
  while (parent !== undefined && !seen.has(parent)) {
    if (parent === ancestor) return true
    seen.add(parent)
    parent = state.tasks.find(item => item.id === parent)?.parentTaskId
  }
  return false
}

/**
 * Root authority or a live supervisor's own descendant, never an unrelated task.
 * @param state - committed Team authority and task state.
 * @param memberId - exact caller Session identity.
 * @param task - task being managed.
 * @returns whether the caller has management authority over that task.
 */
export function canManageTask(state: TeamState, memberId: SessionId, task: TeamTaskSnapshot): boolean {
  if (String(memberId) === String(state.id)) return true
  const assignment = supervisorAssignment(state, memberId)
  return assignment !== undefined && taskDescendsFrom(state, task, assignment.taskId)
}

/**
 * Every delegated writer remains inside the parent package's declared paths.
 * @param scopes - normalized child write paths.
 * @param parentScopes - normalized owning package paths.
 * @returns whether every child path is contained.
 */
export function scopesContained(scopes: readonly string[], parentScopes: readonly string[]): boolean {
  return scopes.every(scope => parentScopes.some(parent => scope === parent || scope.startsWith(`${parent}/`)))
}
