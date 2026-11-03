/** Public Agent Teams identities, durable records, and service request values. */

import type { ModelSelection } from '@deepseek-ai/dsh-agent/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies the implicit team rooted at one top-level Session. */
export type TeamId = Branded<'TeamId'>

/**
 * Brand one root Session identity as its implicit Team identity.
 * @param id - Root Session identity.
 * @returns the same string branded as a Team identity.
 */
export function TeamId(id: SessionId | string): TeamId {
  return id as TeamId
}

/** Stable identifier for one task in a Team. */
export type TeamTaskId = Branded<'TeamTaskId'>

/**
 * Brand a validated task id.
 * @param id - Team-local task identity.
 * @returns the same string branded as a Team task identity.
 */
export function TeamTaskId(id: string): TeamTaskId {
  return id as TeamTaskId
}

/** Stable identifier for one durable peer message. */
export type TeamMessageId = Branded<'TeamMessageId'>

/**
 * Brand a generated peer-message id.
 * @param id - Durable mailbox message identity.
 * @returns the same string branded as a Team message identity.
 */
export function TeamMessageId(id: string): TeamMessageId {
  return id as TeamMessageId
}

/** Durable teammate lifecycle. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'

/** Whole durable value written on every teammate lifecycle change. */
export interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/** Current runtime-enriched roster row. */
export interface TeamMemberView {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: 'running' | 'inactive' | 'provisioning' | 'failed'
  readonly description?: string
  readonly provider?: string
  readonly context?: 'fresh' | 'fork'
  readonly model?: string
  readonly diagnostics: string[]
}

/** Durable task lifecycle. */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** Whole durable task snapshot; every mutation increments {@link revision}. */
export interface TeamTaskSnapshot {
  /** Delegated work package whose supervisor owns review of this task. */
  readonly parentTaskId?: TeamTaskId
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  /** Supervisor's actual verification evidence for the completed revision. */
  readonly verification?: string
}

/** Goal and next actions owned by one project coordinator Session. */
export interface TeamCheckpoint {
  readonly revision: number
  readonly goal: string
  readonly constraints: string[]
  readonly nextActions: string[]
}

/** Compare-and-set update of the coordinator's retained project goal. */
export interface UpdateTeamCheckpointRequest {
  readonly expectedRevision: number
  readonly goal: string
  readonly constraints: readonly string[]
  readonly nextActions: readonly string[]
}

/** Worker outcome awaiting supervisor acceptance; checks are reported evidence, not an independent guarantee. */
export interface TeamTaskReport {
  readonly summary: string
  readonly changedFiles: string[]
  readonly checks: string[]
  readonly risks: string
}

/** A durable supervisor-authorized assignment, keyed by its existing shared task. */
export interface TeamDispatchSnapshot {
  /** A supervisor coordinates descendants of its task; omitted means a leaf worker. */
  readonly role?: 'supervisor'
  /** Exact permitted skills selected for this assignment; empty means no automatic skill. */
  readonly skills?: readonly string[]
  readonly taskId: TeamTaskId
  readonly taskRevision: number
  readonly name: string
  readonly provider: string
  readonly agentOptions?: Partial<ModelSelection> & { readonly maxTokens?: number }
  readonly isolation: 'shared' | 'worktree'
  readonly phase: 'queued' | 'starting' | 'running' | 'waiting' | 'review' | 'blocked' | 'cancelled'
  readonly checkout?: { readonly path: string; readonly branch: string; readonly baseCommit: string; readonly repositoryRoot: string }
  readonly report?: TeamTaskReport
  readonly error?: string
}

/** One current task revision the Lead authorizes for bounded automatic dispatch. */
export interface QueueTeamTaskRequest {
  readonly role?: 'supervisor'
  readonly skills?: readonly string[]
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly name: string
  readonly provider: string
  readonly agentOptions?: Partial<ModelSelection> & { readonly maxTokens?: number }
  readonly isolation: 'shared' | 'worktree'
}

/** Runtime-enriched task view returned to tools and hosts. */
export interface TeamTaskView {
  readonly parentTaskId?: TeamTaskId
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  /** Supervisor verification retained for the accepted task revision. */
  readonly verification?: string
  readonly ownerName?: string
  readonly ready: boolean
  readonly writeScopeWarnings: string[]
}

/** One durable roster row published through the `agentTeam` Session projection. */
export interface TeamMemberProjection {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  /** Durable lifecycle; the Lead row is always `active`. Turn activity comes from Session status. */
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/**
 * Durable Team state published to browser clients through the Lead Session's
 * `agentTeam` projection. `failure` names the first rejected persisted Team
 * record; members and tasks then stay at the last valid state.
 */
export interface TeamProjection {
  readonly checkpoint?: TeamCheckpoint
  readonly members: TeamMemberProjection[]
  readonly tasks: TeamTaskView[]
  readonly failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Durable roster and non-deleted task board of the Team rooted at the projected Session. */
    agentTeam: TeamProjection
  }
}

/** One peer message recorded by the historical Team mailbox. */
export interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}

/** Source recorded by a target Session for one historical Team mailbox delivery. */
export interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': TeamMessageSource
  }
}

/** Team-service deployment limits. */
export interface Config {
  /** Maximum concurrent dispatched workers per Team. Review alone does not occupy a model slot. */
  readonly maxConcurrentTasks?: number
  /** Maximum immutable teammate names retained by one Team. */
  readonly maxMembers?: number
  /** Maximum non-deleted tasks retained by one Team. */
  readonly maxTasks?: number
  /** Maximum UTF-8 bytes in one complete sender-framed delivery. */
  readonly maxMessageBytes?: number
  /** Maximum milliseconds for shared operation settlement and for each Team child drain. */
  readonly disposalTimeoutMs?: number
}

/** Input for creating one durable teammate. */
export interface SpawnTeammateRequest {
  /** Atomically reserve this task for the new worker before its first prompt. */
  readonly assignment?: { readonly taskId: TeamTaskId; readonly expectedRevision: number }
  /** Prepared worker checkout; omission inherits the Lead's current directory. */
  readonly cwd?: string
  /** Explicit worker route and output budget; omission inherits the Lead options. */
  readonly agentOptions?: Partial<ModelSelection> & { readonly maxTokens?: number }
  readonly name: string
  readonly description: string
  readonly prompt: ContentBlock[]
  readonly context: 'fresh' | 'fork'
  readonly provider: string
  readonly signal: AbortSignal
}

/** Result after one teammate reaches a durable active or failed edge. */
export interface SpawnTeammateResult {
  readonly member: TeamMemberView
}

/** Input for one direct peer-message attempt. */
export interface SendTeamMessageRequest {
  readonly target: string
  readonly content: ContentBlock[]
  readonly signal: AbortSignal
}

/** Target inbox acceptance under ordinary Agent persistence; no Team retry or deduplication. */
export interface SendTeamMessageResult {
  readonly messageId: MessageId
}

/** Input for creating one shared task. */
export interface CreateTeamTaskRequest {
  readonly parentTaskId?: TeamTaskId
  readonly subject: string
  readonly description: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
}

/** Supported task mutation actions. */
export type TeamTaskAction =
  | 'claim'
  | 'release'
  | 'edit'
  | 'set_dependencies'
  | 'complete'
  | 'reopen'
  | 'reassign'
  | 'delete'

/** Compare-and-set mutation of one shared task. */
export interface UpdateTeamTaskRequest {
  /** Actual supervisor verification, required when accepting a dispatched task. */
  readonly evidence?: string
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly action: TeamTaskAction
  readonly subject?: string
  readonly description?: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
  readonly owner?: string
}

/** Result of waiting for Team activity. */
export interface TeamWaitResult {
  readonly timedOut: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Latest supervisor-owned project goal and next actions. */
    'team/checkpoint': { version: 2; teamId: TeamId; checkpoint: TeamCheckpoint }
    /** Durable assignment authorization, execution status and reported result. */
    'team/dispatch': { version: 2; teamId: TeamId; dispatch: TeamDispatchSnapshot }
    /** Whole teammate lifecycle value, stored only in the Team Lead Session. */
    'team/member': { version: 2; teamId: TeamId; member: TeamMemberSnapshot }
    /** Whole shared-task value, stored only in the Team Lead Session. */
    'team/task': { version: 2; teamId: TeamId; task: TeamTaskSnapshot }
    /** Historical mailbox enqueue; new sends use the target Agent inbox. */
    'team/message/queued': { version: 2; teamId: TeamId; message: TeamMessageSnapshot }
    /** Historical acknowledgement that the target Session recorded a queued message. */
    'team/message/delivered': {
      version: 2
      teamId: TeamId
      messageId: TeamMessageId
      targetId: SessionId
    }
  }
}
