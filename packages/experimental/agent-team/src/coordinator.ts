/** Durable project-goal checkpoints, independent of model history retention. */

import type { TeamMembership } from './roster.ts'
import type { TeamJournal } from './journal.ts'
import { TeamId } from './types.ts'
import type { TeamCheckpoint, UpdateTeamCheckpointRequest } from './types.ts'
import { TeamError } from './error.ts'
import { requiredText } from './validation.ts'

/** Owns bounded supervisor checkpoints in the Lead Session log. */
export class TeamCoordinator {
  /** @param journal - authoritative serialized Team event owner. */
  constructor(private readonly journal: TeamJournal) {}

  /**
   * Read the latest checkpoint without starting work or inferring a new goal.
   * @param membership - exact caller's Team membership.
   * @returns a detached checkpoint, or undefined before the first update.
   */
  get(membership: TeamMembership): TeamCheckpoint | undefined {
    const checkpoint = this.journal.state(membership.root).checkpoint
    return checkpoint === undefined ? undefined : structuredClone(checkpoint)
  }

  /**
   * Preserve the supervisor's goal, constraints and next actions before interruption or compaction.
   * @param membership - exact caller membership; only the Lead may write.
   * @param request - current revision and complete replacement checkpoint.
   * @returns the checkpoint after its durable flush.
   */
  async update(membership: TeamMembership, request: UpdateTeamCheckpointRequest): Promise<TeamCheckpoint> {
    if (membership.role !== 'lead') throw new TeamError('Only the supervisor may change the project goal', 'TEAM_LEAD_REQUIRED')
    const root = membership.root
    return this.journal.transact(root.id, async () => {
      const current = this.journal.state(root).checkpoint
      if (request.expectedRevision !== (current?.revision ?? 0)) throw new TeamError('Checkpoint revision changed; read the current coordinator state', 'TEAM_CHECKPOINT_STALE')
      if (request.constraints.length > 8 || request.nextActions.length > 8) throw new TeamError('Checkpoint lists are limited to eight entries each', 'TEAM_INVALID_ARGUMENT')
      const checkpoint: TeamCheckpoint = {
        revision: request.expectedRevision + 1,
        goal: requiredText(request.goal, 'project goal', 2_000),
        constraints: request.constraints.map(value => requiredText(value, 'constraint', 500)),
        nextActions: request.nextActions.map(value => requiredText(value, 'next action', 500)),
      }
      if (Buffer.byteLength(JSON.stringify(checkpoint)) > 4_096) throw new TeamError('Complete checkpoint exceeds 4096 bytes', 'TEAM_INVALID_ARGUMENT')
      await this.journal.appendAndFlush(root, 'team/checkpoint', { version: 2, teamId: TeamId(root.id), checkpoint })
      return structuredClone(checkpoint)
    })
  }
}
