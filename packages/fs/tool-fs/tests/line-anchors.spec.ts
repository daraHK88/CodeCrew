/** Pure validation rejects unsafe plans without doing any filesystem work. */
import { describe, expect, it } from 'vitest'
import { lineAnchor, planAnchoredEdits } from '../src/line-anchors.ts'
import type { AnchoredLineEdit } from '../src/line-anchors.ts'
import { buildWindow } from '../src/read-render.ts'

const seed = 'fixture-file-version'
const before = 'alpha\nbeta\ngamma\n'
const a = (n: number) => lineAnchor(seed, n, ['alpha', 'beta', 'gamma'][n - 1]!)
const replacement: AnchoredLineEdit = { op: 'replace', start: a(2), text: 'BETA' }

describe('anchored edit planning', () => {
  it('uses original coordinates regardless of argument order', () => {
    expect(planAnchoredEdits(before, seed, [
      { op: 'insert_after', start: a(3), text: 'last' },
      { op: 'replace', start: a(2), text: 'BETA\nextra' },
      { op: 'insert_before', start: a(1), text: 'first' },
    ]).after).toBe('first\nalpha\nBETA\nextra\ngamma\nlast\n')
  })

  it.each(['2:00000000', a(2).replace(/^2:/, '1:'), '99:00000000'])('refuses a mismatched anchor %s', (start) => {
    expect(() => planAnchoredEdits(before,seed,[{ ...replacement,start }])).toThrow(/stale/)
  })

  it.each(['0:00000000','2','beta','2:abcdefgh','-1:12345678','9007199254740992:12345678'])('rejects malformed anchor %s', (start) => {
    expect(() => planAnchoredEdits(before,seed,[{ ...replacement,start }])).toThrow(/anchors/)
  })

  it('rejects reversed ranges, unused ends, no-op changes and oversized batches', () => {
    expect(() => planAnchoredEdits(before,seed,[{ ...replacement,end:a(1) }])).toThrow(/precede/)
    expect(() => planAnchoredEdits(before,seed,[{ ...replacement,op:'insert_after',end:a(3) }])).toThrow(/only valid/)
    expect(() => planAnchoredEdits(before,seed,[{ ...replacement,text:'beta' }])).toThrow(/no changes/)
    expect(() => planAnchoredEdits(before,seed,[])).toThrow(/between 1 and 32/)
    expect(() => planAnchoredEdits(before,seed,Array<AnchoredLineEdit>(33).fill(replacement))).toThrow(/between 1 and 32/)
    expect(() => planAnchoredEdits(before,seed,[{ ...replacement,op:'other' as never }])).toThrow(/invalid/)
  })

  it('rejects same-boundary insertions and every overlapping range', () => {
    expect(() => planAnchoredEdits(before,seed,[
      { op:'insert_before',start:a(2),text:'one' },
      { op:'insert_before',start:a(2),text:'two' },
    ])).toThrow(/overlap/)
    expect(() => planAnchoredEdits(before,seed,[
      { op:'replace',start:a(1),end:a(3),text:'one' },replacement,
    ])).toThrow(/overlap/)
  })

  it('retains logical empty lines, Unicode and final-newline conventions', () => {
    expect(planAnchoredEdits(before,seed,[{ ...replacement,text:'\n' }]).after).toBe('alpha\n\ngamma\n')
    expect(planAnchoredEdits(before,seed,[{ ...replacement,text:'你好 👋\r\nagain\r\n' }]).after).toBe('alpha\n你好 👋\nagain\ngamma\n')
    expect(planAnchoredEdits('alpha',seed,[{ op:'replace',start:a(1),text:'omega\n' }]).after).toBe('omega')
    expect(planAnchoredEdits('alpha\n',seed,[{ op:'replace',start:a(1),text:'' }]).after).toBe('')
  })

  it('generates identical complete-line anchors across streaming boundaries', async () => {
    const request={ offset:1,limit:10,maxLineLength:5,maxBytes:1024,anchorSeed:seed }
    const streamed=await buildWindow(['alp','ha\r','\nbeta\n','too-long\n'],request,'fixture')
    const whole=await buildWindow(['alpha\r\nbeta\ntoo-long\n'],request,'fixture')
    expect(streamed).toEqual(whole)
    expect(whole.lines[0]?.anchor).toBe(a(1))
    expect(whole.lines[2]?.anchor).toBeUndefined()
  })

  it('charges anchor prefixes to the selected-content byte cap', async () => {
    const window = await buildWindow(['alpha\nbeta\n'], {
      offset: 1, limit: 10, maxLineLength: 20, maxBytes: 16, anchorSeed: seed,
    }, 'fixture')
    expect(window.lines).toHaveLength(1)
    expect(window.totalLines).toBe(2)
    expect(window.truncatedByBytes).toBe(true)
  })
})
