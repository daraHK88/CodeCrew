/** Global coding preferences shared by every agent preset. */
import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Bounded local skill selection policy. */
export interface SkillPolicy {
  readonly enabled: boolean
  readonly maxSkills: number
  readonly maxBytes: number
  readonly catalogDescriptionMaxLength: number
  /** Zero publishes the full catalog; positive values bound a task-relevant shortlist with skill_search discovery. */
  readonly catalogMaxSkills: number
  readonly rules: readonly { readonly keywords: readonly string[]; readonly pattern?: string; readonly skills: readonly string[] }[]
}
/** Memory paths and total context budget. */
export interface MemoryPolicy {
  readonly enabled: boolean
  readonly globalFile: string
  readonly workspaceFile: string
  readonly maxBytes: number
}
/** Live global configuration; preset-local plugins consume these references. */
export interface Config {
  /** Default anchored editing for newly created preset-local filesystem tools. */
  readonly anchoredEdits?: Volatile<boolean>
  readonly skills: Volatile<SkillPolicy>
  readonly memory: Volatile<MemoryPolicy>
}

declare module '@deepseek-ai/cordis' {
  interface Context { codingSettings: CodingSettings }
}

/** Own global preferences independently of preset activation and agent lifetime. */
export class CodingSettings extends Service {
  static Config = z.object({
    anchoredEdits: z.boolean().default(false).volatile(),
    skills: z.object({
      enabled: z.boolean().default(true), maxSkills: z.number().step(1).min(1).max(4).default(1),
      maxBytes: z.number().step(1).min(1).max(65536).default(12000),
      catalogDescriptionMaxLength: z.number().step(1).min(3).max(500).default(180),
      catalogMaxSkills: z.number().step(1).min(0).max(50).default(0),
      rules: z.array(z.object({ keywords: z.array(z.string()).default([]), pattern: z.string(), skills: z.array(z.string()) })).default([]),
    }).default({
      enabled: true, maxSkills: 1, maxBytes: 12000, catalogDescriptionMaxLength: 180, catalogMaxSkills: 0, rules: [],
    }).volatile(),
    memory: z.object({
      enabled: z.boolean().default(true), globalFile: z.string().default(''),
      workspaceFile: z.string().default('.dsh/BRIEF.md'), maxBytes: z.number().step(1).min(1024).max(65536).default(6000),
    }).default({ enabled: true, globalFile: '', workspaceFile: '.dsh/BRIEF.md', maxBytes: 6000 }).volatile(),
  })

  /** @param ctx - global Host scope. @param config - validated live preferences. */
  constructor(ctx: Context, private readonly config: Config) { super(ctx, 'codingSettings') }

  /** Choose the editing default for a new filesystem tool scope.
   * @returns Whether anchored read and edit tools should be enabled by default.
   */
  anchoredEdits(): boolean { return this.config.anchoredEdits?.get() ?? false }

  /** Read the global skill policy.
   * @returns the current immutable skill policy for every preset.
   */
  skills(): SkillPolicy { return this.config.skills.get() }

  /** Read the global memory policy.
   * @returns the current immutable memory policy for every workspace.
   */
  memory(): MemoryPolicy { return this.config.memory.get() }
}
export default CodingSettings
