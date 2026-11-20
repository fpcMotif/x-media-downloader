import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config, execute, commandFor, root } from './commands.mjs'

const cli = ['bunx', 'agent-browser@0.38.2']
const boundTabs = new Map()
const projectSession = 'qa-' + createHash('sha256').update(root).digest('hex').slice(0, 12)

export function extensionInfo(directory) {
  const path = realpathSync(resolve(root, directory))
  const manifest = JSON.parse(readFileSync(resolve(path, 'manifest.json'), 'utf8'))
  if (manifest.manifest_version !== 3) throw new Error('This harness expects a Manifest V3 build')
  const source = manifest.key ? Buffer.from(manifest.key, 'base64') : Buffer.from(path)
  const id = createHash('sha256')
    .update(source)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + Number.parseInt(character, 16)))
  const pages = [
    ...new Set(
      [
        manifest.action?.default_popup,
        manifest.options_ui?.page,
        manifest.options_page,
        manifest.side_panel?.default_path,
      ].filter(Boolean),
    ),
  ]
  if (!pages.length) throw new Error('No extension UI pages found in built manifest')
  for (const page of pages) {
    const full = resolve(path, page)
    if (!full.startsWith(path + '/') || !existsSync(full))
      throw new Error('Missing or invalid extension page: ' + page)
  }
  return { path, manifest, id, pages }
}

async function agent(args, session, extension) {
  if (boundTabs.has(session) && !['tab', 'close'].includes(args[0])) {
    await agent(['tab', boundTabs.get(session)], session, extension)
  }
  const launch = extension ? ['--extension', extension.path] : []
  const child = Bun.spawn(
    [...cli, '--session', session, '--pin-tab', ...launch, '--json', ...args],
    {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0)
    throw new Error(stderr.trim() || stdout.trim() || 'agent-browser failed with exit ' + code)
  if (!stdout.trim()) throw new Error('agent-browser returned empty output')
  const response = JSON.parse(stdout)
  if (response.success !== true) throw new Error(String(response.error ?? 'agent-browser failed'))
  return response.data
}

export function webTarget(args) {
  const [address, expectedText] = args
  if (!address || !expectedText)
    throw new Error('Provide URL and expected visible text: smoke URL EXPECTED_TEXT')
  const url = new URL(address)
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Web smoke requires an HTTP(S) URL')
  return { url: url.href, expectedText }
}

async function capture(session, extension, output, index) {
  const snapshot = await agent(['snapshot', '-i'], session, extension)
  if (!snapshot.snapshot?.trim()) throw new Error('Empty accessibility snapshot')
  writeFileSync(resolve(output, index + '-snapshot.json'), JSON.stringify(snapshot, null, 2))
  const screenshot = resolve(output, index + '.png')
  await agent(['screenshot', screenshot], session, extension)
  if (!existsSync(screenshot) || statSync(screenshot).size === 0)
    throw new Error('Empty screenshot')
}

async function checkExtensionPage(session, extension, output, page, index) {
  await agent(['open', 'chrome-extension://' + extension.id + '/' + page], session, extension)
  await agent(['wait', '--fn', 'Boolean(document.body?.innerText.trim())'], session, extension)
  const state = await agent(
    [
      'eval',
      '({id:chrome.runtime.id,version:chrome.runtime.getManifest().version,text:document.body.innerText})',
    ],
    session,
    extension,
  )
  if (
    state.result?.id !== extension.id ||
    state.result?.version !== extension.manifest.version ||
    !state.result?.text?.trim()
  ) {
    throw new Error('Extension identity, version or rendered content did not match')
  }
  if (extension.manifest.permissions?.includes('storage')) {
    const key = '__qa_' + randomUUID()
    const probe =
      'async () => { const key=' +
      JSON.stringify(key) +
      '; try { await chrome.storage.local.set({[key]:key}); return (await chrome.storage.local.get(key))[key]===key; } finally { await chrome.storage.local.remove(key); } }'
    const stored = await agent(['eval', '(' + probe + ')()'], session, extension)
    if (stored.result !== true) throw new Error('Extension storage round trip failed')
  }
  const errors = await agent(['errors'], session, extension)
  if (errors.errors?.length)
    throw new Error('Uncaught browser errors: ' + JSON.stringify(errors.errors))
  await capture(session, extension, output, String(index))
  return {
    page,
    runtimeId: extension.id,
    version: extension.manifest.version,
    rendered: true,
  }
}

async function smoke(args) {
  const target = config.surface === 'web' ? webTarget(args) : undefined
  let extension
  let launched = false
  const session = projectSession + '-' + randomUUID().slice(0, 8)
  const output = resolve(root, 'tools/qa/results', session)
  mkdirSync(output, { recursive: true })
  const report = {
    project: config.project,
    surface: config.surface,
    passed: false,
    checks: [],
    output,
  }
  try {
    if (config.surface === 'extension') {
      const build = commandFor('build')
      const code = await execute(build.command, build.cwd)
      if (code !== 0) throw new Error('Extension build failed with exit ' + code)
      extension = extensionInfo(config.extension.directory)
    }
    launched = true
    const tab = await agent(['tab', 'new', 'about:blank'], session, extension)
    if (!tab.tabId) throw new Error('Browser did not return a stable tab ID')
    boundTabs.set(session, tab.tabId)
    if (extension) {
      for (const [index, page] of extension.pages.entries()) {
        report.checks.push(await checkExtensionPage(session, extension, output, page, index))
      }
    } else {
      await agent(['open', target.url], session)
      await agent(['wait', '--text', target.expectedText], session)
      const state = await agent(
        [
          'eval',
          '({url:location.href,text:document.body.innerText,status:performance.getEntriesByType("navigation")[0]?.responseStatus,errorOverlay:Boolean(document.querySelector("vite-error-overlay"))})',
        ],
        session,
      )
      if (!(state.result?.status >= 200 && state.result.status < 400))
        throw new Error(
          'Navigation did not return a successful HTTP status: ' + state.result?.status,
        )
      if (!state.result?.text?.includes(target.expectedText) || state.result.errorOverlay)
        throw new Error('Expected application content was not rendered')
      if (new URL(state.result.url).origin !== new URL(target.url).origin)
        throw new Error('Application redirected to a different origin')
      const errors = await agent(['errors'], session)
      if (errors.errors?.length)
        throw new Error('Uncaught browser errors: ' + JSON.stringify(errors.errors))
      await capture(session, undefined, output, 'page')
      report.checks.push({
        url: state.result.url,
        expectedText: target.expectedText,
        rendered: true,
      })
    }
    report.passed = true
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    try {
      if (launched) await capture(session, extension, output, 'failure')
    } catch (captureError) {
      report.captureError = String(captureError)
    }
    throw error
  } finally {
    try {
      if (launched) await agent(['close'], session, extension)
    } catch (error) {
      report.passed = false
      report.cleanupError = String(error)
      process.exitCode = 1
    }
    boundTabs.delete(session)
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.info(JSON.stringify(report, null, 2))
  }
  return report.passed ? 0 : 1
}

export async function main(action, args) {
  if (action === 'setup') return execute([...cli, 'install'])
  if (action === 'doctor') return execute([...cli, 'doctor', '--offline', '--quick'])
  if (action === 'smoke') return smoke(args)
  if (!args.length) throw new Error('Provide an agent-browser command')
  if (args.some((argument) => /^(--all|--session|--namespace)(=|$)/.test(argument)))
    throw new Error('Session overrides and global close are excluded')
  const attach = args.some(
    (argument) =>
      argument === '--cdp' || argument.startsWith('--cdp=') || argument === '--auto-connect',
  )
  const extension =
    config.extension && !attach ? extensionInfo(config.extension.directory) : undefined
  const result = await agent(args, projectSession, extension)
  console.info(JSON.stringify(result, null, 2))
  return 0
}
