import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localUrl, layoutIssues } from './check-ui.mjs'

test('limits automated UI navigation to explicit local HTTP pages without credentials', () => {
  for (const url of ['http://127.0.0.1:3000/', 'https://localhost:4443/dashboard', 'http://[::1]:8080/']) assert.equal(localUrl(url), url)
  for (const url of ['https://example.com/', 'http://localhost.example.com/', 'file:///tmp/index.html', 'http://user:secret@localhost/', 'data:text/html,hello']) assert.throws(() => localUrl(url))
})

test('detects page scrollbar chrome independently from horizontal overflow', () => {
  const mobile = { viewport: 390, client: 375, content: 375, height: 844, scrollHeight: 1200, offscreenControls: 0 }
  assert.deepEqual(layoutIssues(mobile, true), ['Visible page scrollbar chrome'])
  assert.deepEqual(layoutIssues(mobile), [])
  assert.deepEqual(layoutIssues({ ...mobile, client: 390, content: 390 }, true), [])
  assert.deepEqual(layoutIssues({ ...mobile, scrollHeight: 800 }, true), [])
  assert.deepEqual(layoutIssues({ ...mobile, content: 701 }, true), ['Horizontal overflow', 'Visible page scrollbar chrome'])
})
