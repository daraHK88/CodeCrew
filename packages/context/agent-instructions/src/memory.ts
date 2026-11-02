/** Bounded general and workspace memory, projected into durable model context. */
import type {} from '@deepseek-ai/dsh-agent-default-model/coding-settings'
import type { Context } from '@deepseek-ai/cordis'
import { open } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { trimmedInstructionDigest } from './digest.ts'
import type { Config } from './config.ts'

/** Live memory settings; workspace paths are confined to the selected working directory. */
export interface MemorySettings {
  /** Include bounded memory snapshots in model context. */
  enabled: boolean
  /** General memory path; empty selects the current home’s memory/USER.md. */
  globalFile: string
  /** Workspace-relative memory path, confined to the current working directory. */
  workspaceFile: string
  /** Total UTF-8 byte budget for serialized memory sections. */
  maxBytes: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'coding-memory': { kind: 'coding-memory'; digest: string; form: 'snapshot'; sections: readonly { name: string; text: string }[] }
  }
}

/**
 * Read memory without an LLM call or workspace writes. Missing files are optional;
 * unavailable files and containment failures are reported without their content.
 * @param ctx - filesystem capability owner.
 * @param cwd - exact workspace directory, never an aggregate or another workspace.
 * @param settings - current global preference.
 * @param signal - caller cancellation.
 * @returns general and workspace sections within the total byte budget.
 */
export async function readMemory(
  ctx: Context, cwd: string, settings: MemorySettings, signal: AbortSignal,
): Promise<{ name: string; text: string }[]> {
  const sections: { name: string; text: string }[] = []
  let remaining = settings.maxBytes - 256
  const add = (name: string, text: string): void => {
    const size = Buffer.byteLength(JSON.stringify({ name, text }), 'utf8')
    if (size <= remaining && text.trim()) { sections.push({ name, text }); remaining -= size }
  }
  const globalPath = settings.globalFile || join(resolveDshHome(), 'memory', 'USER.md')
  try {
    const file = await open(globalPath, 'r')
    try {
      const limit = Math.max(0, Math.floor(remaining / 2))
      const bytes = Buffer.alloc(limit + 1)
      const result = await file.read(bytes, 0, bytes.length, 0)
      signal.throwIfAborted()
      if (result.bytesRead <= limit) add('General memory', bytes.subarray(0, result.bytesRead).toString('utf8'))
    } finally { await file.close() }
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) ctx.logger.warn('General memory could not be read')
  }
  const fs = ctx.get('fs')
  if (fs !== undefined && settings.workspaceFile && !isAbsolute(settings.workspaceFile)) {
    try {
      const root = await fs.resolve(cwd, { signal })
      const target = await fs.resolve(settings.workspaceFile, { cwd, signal })
      if (!fs.contains(root, target)) throw new Error('Workspace memory escaped its workspace')
      const info = await fs.stat(target, signal)
      if (info?.type === 'file' && info.size !== undefined && info.size <= remaining) {
        add('Workspace memory', Buffer.from(await fs.readBytes(target, signal, remaining)).toString('utf8'))
      }
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (!(error instanceof Error && 'code' in error && (error.code === 'FS_NOT_FOUND' || error.code === 'ENOENT'))) ctx.logger.warn('Workspace memory could not be read')
    }
  }
  return sections
}

/**
 * Restore current memory after compaction and refresh changed memory at step boundaries.
 * @param ctx - instruction plugin scope.
 * @param config - live memory preference.
 */
export function installMemory(ctx: Context, config: Config): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    const settings = ctx.get('codingSettings')?.memory() ?? config.memory?.get()
    if (decision.kind === 'reject' || settings?.enabled !== true) return decision
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const sections = await readMemory(ctx, cwd, settings, signal)
    if (sections.length === 0) return decision
    const text = ['Saved memory is background context. Current user instructions and verified source take precedence.', ...sections.map(section => `${section.name}:\n${section.text}`)].join('\n\n')
    const digest = trimmedInstructionDigest(text)
    for (const seq of agent.session.surface.nodes.toReversed()) {
      // oxlint-disable-next-line typescript/no-deprecated -- inspect the retained memory snapshot, not dropped history.
      const event = agent.session.eventAt(seq)
      if (event?.type === 'user/message' && event.data.source.kind === 'coding-memory') {
        if (event.data.source.digest === digest) return decision
        break
      }
    }
    return { ...decision, messages: [...decision.messages, createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'coding-memory', digest, form: 'snapshot', sections },
    })] }
  })
}
