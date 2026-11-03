/** Reusable local-page browser checks; no project dependency installation or shared browser profile. */
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Reject nonlocal destinations and credential-bearing URLs before launching a browser. */
export function localUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password) throw new Error('Provide an HTTP(S) localhost URL without credentials')
  return url.href
}

/** Run task-specific functional checks with an isolated page and awaited cleanup. */
export async function withPage(url, check) {
  const target = localUrl(url)
  const provider = createRequire(import.meta.resolve('@deepseek-ai/dsh-experimental-browser-use-playwright-mcp/package.json'))
  const runtime = createRequire(provider.resolve('@playwright/mcp/package.json'))
  const { chromium } = runtime('playwright')
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/key|secret|token|password|credential/i.test(name)))
  const browser = await chromium.launch({ channel: 'chrome', headless: true, env })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    page.setDefaultTimeout(5000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message.slice(0, 300)))
    await page.goto(target, { waitUntil: 'load', timeout: 20000 })
    return await check(page, errors)
  } finally { await browser.close() }
}

/** Check measured layout failures, including the optional no-scrollbar-chrome criterion. */
export function layoutIssues(view, hideScrollbars = false) {
  const issues = []
  if (view.content > view.client) issues.push('Horizontal overflow')
  if (view.offscreenControls > 0) issues.push('Offscreen visible controls')
  if (hideScrollbars && view.scrollHeight > view.height && view.viewport > view.client) issues.push('Visible page scrollbar chrome')
  return issues
}

/** Bounded solid-color text audit; complex backgrounds and transparent text are reported as skipped. */
function solidTextContrast() {
  const rgb = value => (value.match(/[\d.]+/g) || []).map(Number)
  const luminance = color => {
    const c = color.slice(0, 3).map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4 })
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]
  }
  let checked = 0, skipped = 0
  const failures = []
  for (const element of document.querySelectorAll('body *')) {
    if (![...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())
      || element.closest('[aria-hidden="true"],dialog:not([open])')) continue
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
    if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none'
      || style.clip !== 'auto' || style.clipPath !== 'none') continue
    let parent = element, background
    while (parent) {
      const current = getComputedStyle(parent), color = rgb(current.backgroundColor)
      if (current.backgroundImage !== 'none' || Number(current.opacity) < 1) break
      if (color.length === 3 || color[3] === 1) { background = color; break }
      if (color[3] > 0) break
      parent = parent.parentElement
    }
    const foreground = rgb(style.color)
    if (!background || foreground[3] < 1) { skipped++; continue }
    const a = luminance(foreground), b = luminance(background)
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
    const size = Number(style.fontSize.replace('px', ''))
    const large = size >= 24 || size >= 18.66 && Number(style.fontWeight) >= 700
    checked++
    if (ratio < (large ? 3 : 4.5)) failures.push({ text: element.textContent.trim().slice(0, 80), ratio: Math.round(ratio * 100) / 100 })
  }
  return { checked, skipped, failures }
}

/** Capture integrated layouts and observable geometry; functional acceptance stays task-specific. */
export async function checkUi(url, output, hideScrollbars = false, requireContrast = false) {
  const out = output ? resolve(output) : await mkdtemp(join(tmpdir(), 'codecrew-ui-check-'))
  await mkdir(out, { recursive: true })
  return await withPage(url, async (page, errors) => {
    const views = []
    for (const [width, height] of [[390, 844], [768, 1024], [1440, 1000]]) {
      await page.setViewportSize({ width, height })
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      const geometry = await page.evaluate(() => ({
        viewport: innerWidth, height: innerHeight, scrollHeight: document.documentElement.scrollHeight,
        client: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
        offscreenControls: [...document.querySelectorAll('button,input,select,a')].filter(element => {
          const box = element.getBoundingClientRect(), style = getComputedStyle(element)
          return box.width && box.height && style.clip === 'auto' && style.clipPath === 'none' && style.visibility !== 'hidden' && !element.closest('[hidden],dialog:not([open])')
            && (box.left < -1 || box.right > innerWidth + 1)
        }).length,
      }))
      const screenshot = `overview-${width}.png`
      await page.screenshot({ path: join(out, screenshot), fullPage: true, animations: 'disabled' })
      views.push({ ...geometry, screenshot, issues: layoutIssues(geometry, hideScrollbars),
        ...requireContrast ? { contrast: await page.evaluate(solidTextContrast) } : {} })
    }
    const result = { output: out, views, pageErrors: errors, passed: errors.length === 0 && views.every(view => view.issues.length === 0 && (view.contrast?.failures.length ?? 0) === 0),
      scope: 'Integrated screenshots, geometry, captured page errors and optional solid-color text contrast. Complex backgrounds are skipped. Verify task interactions, keyboard use and the design checklist separately; this is not a complete accessibility audit.' }
    await writeFile(join(out, 'checks.json'), JSON.stringify(result, null, 2) + '\n')
    return result
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hideScrollbars = process.argv.includes('--hide-scrollbars')
  const requireContrast = process.argv.includes('--contrast')
  const [url, output] = process.argv.slice(2).filter(value => value !== '--hide-scrollbars' && value !== '--contrast')
  if (!url || url === '--help') console.log('Usage: node check-ui.mjs http://127.0.0.1:PORT [output-directory] [--hide-scrollbars] [--contrast]\nExports withPage(url, async page => { /* functional checks */ }) and checkUi(url, output). Uses the repository\'s pinned Playwright runtime and installed Chrome; no browser download or shared profile.')
  else checkUi(url, output, hideScrollbars, requireContrast).then(result => { console.log(JSON.stringify(result)); if (!result.passed) process.exitCode = 1 }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
