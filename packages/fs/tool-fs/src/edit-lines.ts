/** Optional anchored editing over the existing filesystem policy and atomic provider. */
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolResult, DiffResultView } from '@deepseek-ai/dsh-tools'
import { lineAnchorSeed, planAnchoredEdits, type AnchoredLineEdit } from './line-anchors.ts'
import { buildWindow } from './read-render.ts'
import { computeHunkDiffs, diffsFromMeta } from './diff.ts'
import { remediateFsError } from './error.ts'
import { mutationResult } from './mutation-result.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'

const MAX_ANCHORED_FILE_BYTES = 2 * 1024 * 1024

interface AnchoredEditArgs {
  file_path: string
  edits: AnchoredLineEdit[]
  sandbox_permissions?: string
  justification?: string
}

/**
 * Register the optional edit_lines tool with existing read-before-edit and sandbox enforcement.
 * @param ctx - Scope owning the tools and filesystem capabilities.
 * @param sandbox - Shared permission and denial handling used by the other mutation tools.
 */
export function applyAnchoredEditTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:edit_lines',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT'),
    text: ({ scope }) => ctx.tools.get('edit_lines', scope) === undefined ? ''
      : 'Use edit_lines for batched changes, repeated code, or replacing large ranges: copy number:hash anchors from read; emit only new code. '
        + 'All ranges address the same original file. Successful edits return fresh anchors near the change. '
        + 'For a tiny unique literal change, edit is also available. Never guess anchors; re-read after a stale result. '
        + 'Lines clipped by read have no anchor. Use write to fill an empty file.',
  })
  ctx.tools.register(defineTool({
    name: 'edit_lines',
    description: 'Atomically edit existing text using exact read anchors, without repeating old code. Up to 32 disjoint operations per file.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Existing UTF-8 file, resolved by the same backend as read.' },
      edits: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            op: { type: 'string', required: true, enum: ['replace', 'insert_before', 'insert_after'] },
            start: { type: 'string', required: true, description: 'Exact number:hash copied from the latest read or edit result.' },
            end: { type: 'string', description: 'Last inclusive anchor for replace. Omit for a single line or an insertion.' },
            text: { type: 'string', required: true, description: 'New complete lines. Empty text deletes a replacement range. Original EOF newline is retained.' },
          },
        },
      },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
          preview: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Updated ${value.path}. Fresh anchors near the change:\n${value.preview}` }],
      presentationMeta: (_args, value) => ({
        path: value.path,
        diffs: computeHunkDiffs(value.path, value.before, value.after).map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args: AnchoredEditArgs, exec) {
      if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
      if (args.edits.length === 0 || args.edits.length > 32) throw new Error('edits must contain between 1 and 32 operations')
      const policy = await sandbox.resolvePolicy('edit_lines', args, exec)
      const target = await ctx.fs.resolve(args.file_path, await sessionResolveOptions(ctx, exec))
      try {
        // Authorization precedes the internal read, so it cannot manufacture a caller observation.
        const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        if (info.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        const sizeError = () => new Error('edit_lines supports files up to 2 MiB; use edit or apply_patch for larger files')
        if (info.size !== undefined && info.size > MAX_ANCHORED_FILE_BYTES) throw sizeError()
        const chunks: string[] = []
        let bytes = 0
        for await (const chunk of await ctx.fs.streamText(target, exec.signal)) {
          exec.signal.throwIfAborted()
          bytes += Buffer.byteLength(chunk, 'utf8')
          if (bytes > MAX_ANCHORED_FILE_BYTES) throw sizeError()
          chunks.push(chunk)
        }
        const before = chunks.join('')
        const plan = planAnchoredEdits(before, lineAnchorSeed(target, info.version), args.edits)
        // The full opaque version is checked under the provider lock even without an observation policy.
        // Replacing the complete current basis avoids duplicate-snippet ambiguity; no old text crosses the model boundary.
        const outcome = await ctx.fs.editText(target, {
          oldString: before, newString: plan.after, replaceAll: false,
        }, intent ?? { version: info.version }, exec.signal, policy)
        const result = mutationResult(ctx, target, outcome, exec)
        const window = await buildWindow([outcome.after], {
          offset: plan.firstLine, limit: plan.previewLines, maxLineLength: 2000, maxBytes: 2048,
          anchorSeed: lineAnchorSeed(target, outcome.version),
        }, target.displayPath)
        const preview = window.lines.map(line => line.anchor === undefined ? `${line.number}: ${line.text}` : `${line.anchor}|${line.text}`).join('\n')
        return { ...result, preview }
      } catch (error: unknown) {
        throw remediateFsError(sandbox.mapError(error, policy), target.displayPath)
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Edit ${args.file_path} by anchors`, kind: 'edit', rawInput: JSON.stringify(args.edits) }
    },
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      return diffs === undefined ? undefined : { card: 'diff', title: `Edit ${args.file_path}`, diffs }
    },
  }))
}
