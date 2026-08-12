import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const ENV = { ZELLIJ: '0', EDITOR: 'nvim', PATH: '/nope:/bin' }
const ANNOTATIONS = '/tmp/revdiff-sess/annotations'

// Runs /revdiff as the person typing it would.
const revdiff = ($: Engine, args: string) =>
  $.command.run({
    command: 'revdiff',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

// Starts the session the way Claude Code does: the engine's event, then the
// SessionStart hook event whose result carries the watch paths.
async function startSession($: Engine, title?: string) {
  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  return $.classic.SessionStart({ source: 'startup', session_id: 'sess', session_title: title })
}

const flush = ($: Engine, file_path = ANNOTATIONS) =>
  $.classic.FileChanged({ session_id: 'sess', file_path, event: 'change' })

// Answers everything beneath the plugin from memory: a file system of one
// directory, the host commands it runs, and the prompts it submits.
function host(on: On) {
  const files = new Map<string, string>()
  const runs: string[][] = []
  const submitted: { text: string; asUser?: boolean }[] = []

  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', async () => ({}))
  on('classic.FileChanged', async () => ({}))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.id', async () => ({ value: 'sess' }))
  on('session.cwd', async () => ({ value: '/work/proj' }))
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', async (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', async (_$, e) => {
    if (e.path !== '/bin/revdiff') return { deny: 'ENOENT' }
    return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
  })
  on('process.run', async (_$, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', async (_$, e) => {
    submitted.push({ text: e.text, asUser: e.origin.kind === 'plugin' ? e.origin.asUser : undefined })
    return { text: e.text }
  })

  return { files, runs, submitted }
}

test('the session watches its annotations file, created empty', async ($, on) => {
  mock.env(on, ENV)
  const { files } = host(on)

  const result = await startSession($)
  expect(result.watchPaths).toEqual([ANNOTATIONS])
  expect(files.get(ANNOTATIONS)).toBe('')
})

test('each flush arrives as one unframed prompt', async ($, on) => {
  mock.env(on, ENV)
  const clock = mock.clock(on)
  const { files, submitted } = host(on)
  await startSession($)

  files.set(ANNOTATIONS, '## a.go:1 (+)\nfirst')
  await flush($)
  files.set(ANNOTATIONS, '## a.go:1 (+)\nfirst')
  await flush($)
  await clock.settle()

  // The same set flushed twice is the reviewer re-sending it, so both arrive.
  expect(submitted).toEqual([
    { text: 'Annotations from revdiff:\n\n## a.go:1 (+)\nfirst', asUser: true },
    { text: 'Annotations from revdiff:\n\n## a.go:1 (+)\nfirst', asUser: true },
  ])
})

test('an empty file and other files are ignored', async ($, on) => {
  mock.env(on, ENV)
  const clock = mock.clock(on)
  const { files, submitted } = host(on)
  await startSession($)

  files.set(ANNOTATIONS, ' \n')
  await flush($)
  files.set('/elsewhere', 'text')
  await flush($, '/elsewhere')
  await clock.settle()

  expect(submitted).toEqual([])
})

test('/revdiff empties the file and opens a pane named for the session', async ($, on) => {
  mock.env(on, ENV)
  const { files, runs } = host(on)
  await startSession($, 'Review the relay')
  files.set(ANNOTATIONS, 'left over')

  const ran = await revdiff($, 'main --staged')
  expect(ran.text).toContain('revdiff is open')
  expect(ran.context?.[0]).toContain('Annotations from revdiff:')
  expect(files.get(ANNOTATIONS)).toBe('')

  const zellij = runs.find(argv => argv[0] === 'zellij') ?? []
  expect(zellij[zellij.indexOf('--name') + 1]).toBe('revdiff: Review the relay')
  expect(zellij.slice(zellij.indexOf('--') + 1)).toEqual([
    '/usr/bin/env', 'EDITOR=nvim', '/bin/revdiff', `--output=${ANNOTATIONS}`, 'main', '--staged',
  ])
})

test('an untitled session names the pane by directory and session id', async ($, on) => {
  mock.env(on, ENV)
  const { runs } = host(on)
  await startSession($)

  await revdiff($, '')
  const zellij = runs.find(argv => argv[0] === 'zellij') ?? []
  expect(zellij[zellij.indexOf('--name') + 1]).toBe('revdiff: proj · sess')
})

test('outside Zellij nothing is started', async ($, on) => {
  mock.env(on, { PATH: '/bin' })
  const { runs } = host(on)
  await startSession($)

  const ran = await revdiff($, '')
  expect(ran.text).toBe('Not inside a Zellij session.')
  expect(runs).toEqual([])
})
