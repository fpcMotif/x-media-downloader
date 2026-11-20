import { config, execute, commandFor } from './commands.mjs'
export { config, execute, commandFor, root } from './commands.mjs'

export async function main(args) {
  const [action = 'list', ...rest] = args
  if (action === 'list' || action === '--help') {
    console.info(config.project + ' — ' + config.surface + '\n' + config.choice)
    console.info('Checks: ' + Object.keys(config.commands).join(', '))
    console.info('bun tools/qa/run.mjs CHECK [ARGS...]\nbun tools/qa/run.mjs plan CHECK [ARGS...]')
    if (config.surface === 'web' || config.surface === 'extension') {
      console.info(
        'bun tools/qa/run.mjs setup\nbun tools/qa/run.mjs browser open URL\nbun tools/qa/run.mjs browser snapshot -i\nbun tools/qa/run.mjs browser close',
      )
      console.info(
        config.surface === 'extension'
          ? 'bun tools/qa/run.mjs smoke'
          : 'bun tools/qa/run.mjs smoke URL EXPECTED_TEXT',
      )
    }
    return 0
  }
  if (action === 'plan') {
    const [name, ...extra] = rest
    console.info(JSON.stringify(commandFor(name, extra), null, 2))
    return 0
  }
  if (
    ['browser', 'smoke', 'setup', 'doctor'].includes(action) &&
    ['web', 'extension'].includes(config.surface)
  ) {
    const browser = await import('./browser.mjs')
    return browser.main(action, rest)
  }
  const operation = commandFor(action, rest)
  return execute(operation.command, operation.cwd)
}

if (import.meta.main) {
  try {
    process.exitCode = await main(Bun.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
