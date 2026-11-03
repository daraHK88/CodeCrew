/** Complete dependency validation for current Team task snapshots. */

import type { TeamTaskId, TeamTaskSnapshot } from './types.ts'
import { scopesContained } from './task-authority.ts'

/** Task dependency relation rejected by the shared graph validator. */
export type TeamTaskGraphViolation = 'missing' | 'duplicate' | 'cycle'

/** Package-private task dependency failure retained for command error mapping. */
export class TeamTaskGraphError extends Error {
  /**
   * @param message - concrete invalid dependency relation.
   * @param violation - stable relation category used by Team commands.
   */
  constructor(message: string, readonly violation: TeamTaskGraphViolation) {
    super(message)
    this.name = 'TeamTaskGraphError'
  }
}

/**
 * Validate the complete active task graph after replacing one candidate snapshot.
 * @param current - current task snapshots before the candidate event.
 * @param candidate - new or next-revision task snapshot.
 * @throws {TeamTaskGraphError} when an active dependency is missing, duplicated, self-referential, or cyclic.
 */
export function assertTaskGraphCandidate(
  current: readonly TeamTaskSnapshot[],
  candidate: TeamTaskSnapshot,
): void {
  const tasks = new Map(current.map(task => [task.id, task]))
  tasks.set(candidate.id, candidate)

  for (const task of tasks.values()) {
    if (task.status === 'deleted') continue
    if (task.parentTaskId !== undefined) {
      const parent = tasks.get(task.parentTaskId)
      if (parent === undefined || parent.status === 'deleted') throw new TeamTaskGraphError('Parent task is missing or deleted', 'missing')
      if (!scopesContained(task.writeScopes, parent.writeScopes)) throw new TeamTaskGraphError('Child write scopes exceed parent package', 'missing')
    }
    const seen = new Set<TeamTaskId>()
    for (const blockerId of task.blockedBy) {
      if (blockerId === task.id) {
        throw new TeamTaskGraphError(`team task "${task.id}" cannot block itself`, 'cycle')
      }
      if (seen.has(blockerId)) {
        throw new TeamTaskGraphError(`team task "${task.id}" repeats blocker "${blockerId}"`, 'duplicate')
      }
      const blocker = tasks.get(blockerId)
      if (blocker === undefined || blocker.status === 'deleted') {
        throw new TeamTaskGraphError(
          `blocker task "${blockerId}" for "${task.id}" is missing or deleted`,
          'missing',
        )
      }
      seen.add(blockerId)
    }
  }

  const visiting = new Set<TeamTaskId>()
  const visited = new Set<TeamTaskId>()
  const visit = (id: TeamTaskId): void => {
    if (visiting.has(id)) {
      throw new TeamTaskGraphError(`task dependency cycle includes "${id}"`, 'cycle')
    }
    if (visited.has(id)) return
    const task = tasks.get(id)
    if (task === undefined || task.status === 'deleted') return
    visiting.add(id)
    for (const blockerId of task.blockedBy) visit(blockerId)
    // Parent completion depends on child acceptance, even without an explicit blocker edge.
    for (const child of tasks.values()) if (child.parentTaskId === id) visit(child.id)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks.values()) visit(task.id)
}
