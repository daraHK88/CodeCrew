/** Read explicitly selected files through ctx.fs; return evidence identities, never file text. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-working-directory'
import { DecisionError } from './decision-error.ts'
import type { DecisionInput, DecisionSettings } from './decisions.ts'

/** Provider observation bound to the text actually assessed. It does not authorize editing. */
export interface DecisionFileSource { path: string; version: string; bytes: number }

/**
 * Build bounded decision state without widening filesystem permissions or returning source text.
 * @param ctx - Calling scope with optional filesystem and working-directory services.
 * @param agent - Current workspace owner.
 * @param paths - Explicit files, without globs or directory expansion.
 * @param input - Caller evidence and typed questions.
 * @param policy - Global egress and request limits.
 * @param signal - Caller-owned cancellation.
 * @returns Combined state and version-bound source metadata. Internal reads emit no observations.
 */
export async function inspectDecisionFiles(
  ctx: Context, agent: Agent, paths: readonly string[], input: DecisionInput, policy: DecisionSettings, signal: AbortSignal,
): Promise<{ context: string; sources: DecisionFileSource[] }> {
  if (paths.length === 0) return { context: input.context, sources: [] }
  if (!policy.inspectFiles) throw new DecisionError('DECISION_FILES_DISABLED', 'Enable bounded file assessment in Coding settings first.')
  if (paths.length > Math.min(12, policy.maxOptions - 1)) throw new DecisionError('DECISION_FILE_LIMIT', 'Choose a small explicit file shortlist.')
  const fs = ctx.get('fs'), workingDirectory = ctx.get('workingDirectory')
  if (fs === undefined || workingDirectory === undefined) throw new DecisionError('DECISION_FILES_UNAVAILABLE', 'Workspace filesystem access is unavailable.')
  const cwd = await workingDirectory.ensure(agent, signal)
  const root = await fs.resolve('.', { cwd, signal })
  const files: { path: string; content: string }[] = []
  const sources: DecisionFileSource[] = []
  const seen = new Set<string>()
  let bytes = Buffer.byteLength(JSON.stringify(input), 'utf8')
  for (const path of paths) {
    signal.throwIfAborted()
    const target = await fs.resolve(path, { cwd, signal })
    if (!fs.contains(root, target)) throw new DecisionError('DECISION_FILE_SCOPE', 'File assessment is limited to the current workspace.')
    const canonical = fs.processPath(target).replace(/\\/g, '/')
    if (/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.ssh|\.aws|credentials(?:\.[^/]*)?)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i.test(canonical)) {
      throw new DecisionError('DECISION_FILE_SENSITIVE', 'Credential and private-key files cannot be sent to the decision service.')
    }
    if (seen.has(target.targetKey)) continue
    seen.add(target.targetKey)
    const info = await fs.stat(target, signal)
    if (info?.type !== 'file') throw new DecisionError('DECISION_FILE_INVALID', 'Choose existing regular UTF-8 files.')
    if (info.size !== undefined && bytes + info.size > policy.maxTextBytes) throw new DecisionError('DECISION_INPUT_LIMIT', 'Selected files exceed the decision text budget; narrow the evidence or use grep/read.')
    let content = ''
    for await (const chunk of await fs.streamText(target, signal)) {
      signal.throwIfAborted()
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > policy.maxTextBytes) throw new DecisionError('DECISION_INPUT_LIMIT', 'Selected files exceed the decision text budget; narrow the evidence or use grep/read.')
      content += chunk
    }
    if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:sk-proj-|sk-or-v1-)[a-zA-Z0-9_-]{20,}/.test(content)) {
      throw new DecisionError('DECISION_FILE_SENSITIVE', 'Selected file contains a recognizable private key or API credential.')
    }
    const current = await fs.stat(target, signal)
    if (current?.version !== info.version) throw new DecisionError('DECISION_FILE_STALE', 'A selected file changed while it was being inspected; select current evidence.')
    files.push({ path: target.displayPath, content })
    sources.push({ path: target.displayPath, version: String(info.version), bytes: Buffer.byteLength(content, 'utf8') })
  }
  const context = JSON.stringify({ task: input.context, files })
  if (Buffer.byteLength(JSON.stringify({ ...input, context }), 'utf8') > policy.maxTextBytes) {
    throw new DecisionError('DECISION_INPUT_LIMIT', 'File wrappers and questions exceed the decision text budget; narrow the selected files.')
  }
  return { context, sources }
}
