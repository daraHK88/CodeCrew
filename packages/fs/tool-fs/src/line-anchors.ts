/** Stateless file-version-bound line anchors and atomic batch planning. */
import { createHash } from 'node:crypto'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'

/** One line-addressed replacement, insertion, or deletion (empty replacement). */
export interface AnchoredLineEdit {
  /** Replace an inclusive range, or insert beside its start anchor. */
  op: 'replace' | 'insert_before' | 'insert_after'
  /** Exact number:hash anchor copied from the latest read or edit result. */
  start: string
  /** Last inclusive anchor for replace; omission replaces only the start line. */
  end?: string
  /** Complete new logical lines; one final newline is ignored and the file's EOF style is retained. */
  text: string
}

/**
 * Bind anchors to a provider's canonical target and complete opaque version.
 * @param target - Resolved provider identity, including aliases.
 * @param version - Version of the text being shown.
 * @returns Opaque digest used only for line-reference validation, never authorization.
 */
export function lineAnchorSeed(target: FsTarget, version: FsVersion): string {
  return createHash('sha256').update(String(target.targetKey)).update('\0').update(String(version)).digest('hex')
}

/**
 * Identify a complete, untruncated line within one exact file version.
 * @param seed - Digest from lineAnchorSeed.
 * @param number - One-based line coordinate.
 * @param text - Complete LF-normalized line without its newline.
 * @returns Compact number:hash reference; the provider's full version guard remains authoritative.
 */
export function lineAnchor(seed: string, number: number, text: string): string {
  const hash = createHash('sha256').update(seed).update('\0').update(String(number)).update('\0').update(text).digest('hex').slice(0, 8)
  return `${number}:${hash}`
}

/**
 * Validate every anchor and range before constructing any changed text.
 * @param before - Complete current text, with CRLF normalized for line coordinates.
 * @param seed - Seed for the provider version that will guard publication.
 * @param edits - At most 32 disjoint edits, all addressed against the same original text.
 * @returns LF text, original final-newline convention, and a bounded first-change preview range.
 * @throws FsError for stale anchors, or Error for invalid, overlapping, or no-op batches.
 */
export function planAnchoredEdits(
  before: string, seed: string, edits: readonly AnchoredLineEdit[],
): { after: string; firstLine: number; previewLines: number } {
  if (edits.length === 0 || edits.length > 32) throw new Error('edits must contain between 1 and 32 operations')
  const normalized = before.replace(/\r\n/g, '\n')
  const finalNewline = normalized.endsWith('\n')
  const lines = normalized.length === 0 ? [] : normalized.split('\n')
  if (finalNewline) lines.pop()
  const position = (anchor: string): number => {
    const match = /^([1-9]\d*):([0-9a-f]{8})$/i.exec(anchor)
    if (match === null || !Number.isSafeInteger(Number(match[1]))) throw new Error('anchors must be copied as number:hash from read')
    const number = Number(match[1])
    const text = lines[number - 1]
    const hash = match[2]
    if (text === undefined || hash === undefined || lineAnchor(seed, number, text) !== `${number}:${hash.toLowerCase()}`) {
      throw new FsError(`line anchor ${anchor} is stale or belongs to another file`, 'FS_STALE_VERSION')
    }
    return number
  }
  let firstLine = Number.POSITIVE_INFINITY
  const plans = edits.map((edit) => {
    if (!['replace', 'insert_before', 'insert_after'].includes(edit.op)) throw new Error('invalid anchored edit operation')
    const start = position(edit.start)
    if (edit.op !== 'replace' && edit.end !== undefined) throw new Error('end is only valid for replace')
    const end = edit.end === undefined ? start : position(edit.end)
    if (end < start) throw new Error('end must not precede start')
    const content = edit.text.replace(/\r\n/g, '\n').replace(/\n$/, '')
    const replacement = edit.text.length === 0 ? [] : content.split('\n')
    const from = edit.op === 'insert_after' ? start : start - 1
    const to = edit.op === 'replace' ? end : from
    firstLine = Math.min(firstLine, from + 1)
    return { from, to, replacement }
  }).sort((a, b) => a.from - b.from || a.to - b.to)
  let previous: typeof plans[number] | undefined
  for (const current of plans) {
    if (previous !== undefined && (current.from < previous.to || current.from === previous.from)) {
      throw new Error('edits overlap; submit disjoint original ranges')
    }
    previous = current
  }
  const result = [...lines]
  for (const plan of [...plans].reverse()) result.splice(plan.from, plan.to - plan.from, ...plan.replacement)
  const after = result.join('\n') + (finalNewline && result.length > 0 ? '\n' : '')
  if (after === normalized) throw new Error('anchored edits make no changes')
  return { after, firstLine: Math.max(1, Math.min(firstLine, result.length)),
    previewLines: Math.min(8, Math.max(1, plans[0]?.replacement.length ?? 1)) }
}
