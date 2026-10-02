import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const ZELLIJ_ENV = { ZELLIJ: '0', EDITOR: 'nvim', PATH: '/nope:/bin' }
const FIFO = '/tmp/revdiff-sess/flush.pipe'

const revdiff = ($: Engine, args: string) =>
  $.command.run({
    command: 'revdiff',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

const startSession = ($: Engine) =>
  $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })

const paneName = (runs: string[][]) => {
  const zellij = runs.find(argv => argv[0] === 'zellij') ?? []
  return zellij[zellij.indexOf('--name') + 1]
}

function host(on: On, { hasFifo = false } = {}) {
  const runs: string[][] = []
  const submitted: string[] = []
  const readers: { argv: readonly string[]; release: () => void }[] = []

  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', async () => ({}))
  on('classic.UserPromptSubmit', async () => ({}))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.id', async () => ({ value: 'sess' }))
  on('session.cwd', async () => ({ value: '/work/proj' }))
  on('fs.stat', async (_$, e) => {
    if (e.path === '/bin/revdiff') return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
    if (e.path === FIFO && hasFifo) return { value: { kind: 'other' as const, size: 0, mtimeMs: 0, isLink: false } }
    return { deny: 'ENOENT' }
  })
  on('process.run', async (_$, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', async (_$, e) => {
    expect(e.origin).toEqual({ kind: 'plugin', name: 'revdiff-relay', asUser: true })
    submitted.push(e.text)
    return { text: e.text }
  })
  on('process.spawn', async function* (_$, e) {
    let release = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    readers.push({ argv: e.argv, release })
    // A flush split across two pieces, an empty flush, then a gated second flush.
    yield { stream: 'stdout' as const, text: '## a.go:1 (+)\nfirst' }
    yield { stream: 'stdout' as const, text: ' half\0  \n\0' }
    await gate
    yield { stream: 'stdout' as const, text: '## b.go (+)\nsecond\0' }
    return { value: { code: 0, signal: null } }
  })

  return { runs, submitted, readers }
}

test('each flush arrives as one prompt; empty flushes are dropped', async ($, on) => {
  mock.env(on, ZELLIJ_ENV)
  const clock = mock.clock(on)
  const { submitted, readers } = host(on)
  await startSession($)

  const ran = await revdiff($, '@-')
  expect(ran.text).toContain('revdiff is open')
  expect(ran.context?.[0]).toContain('Annotations from revdiff:')
  await clock.settle()
  expect(submitted).toEqual(['Annotations from revdiff:\n\n## a.go:1 (+)\nfirst half'])

  readers[0]?.release()
  await clock.settle()
  expect(submitted).toHaveLength(2)
  expect(submitted[1]).toBe('Annotations from revdiff:\n\n## b.go (+)\nsecond')
})

test('the pane gets the flush hook, the editor and the arguments', async ($, on) => {
  mock.env(on, ZELLIJ_ENV)
  const clock = mock.clock(on)
  const { runs, readers } = host(on)
  await startSession($)

  await revdiff($, 'main --staged')
  await clock.settle()
  expect(readers[0]?.argv).toEqual(['sh', '-c', 'exec cat <>"$1"', 'sh', FIFO])

  const zellij = runs.find(argv => argv[0] === 'zellij') ?? []
  const pane = zellij.slice(zellij.indexOf('--') + 1)
  expect(pane[0]).toBe('/usr/bin/env')
  expect(pane[1]).toBe('EDITOR=nvim')
  expect(pane[2]).toBe('/bin/revdiff')
  expect(pane[3]).toBe('--output=/tmp/revdiff-sess/annotations')
  expect(pane[4]).toMatch(/^--post-flush-command='.*\/scripts\/flush\.sh' --annotations '\/tmp\/revdiff-sess\/annotations' --fifo '\/tmp\/revdiff-sess\/flush\.pipe'$/)
  expect(pane.slice(5)).toEqual(['main', '--staged'])
})

test('a new review stops the previous reader', async ($, on) => {
  mock.env(on, ZELLIJ_ENV)
  const clock = mock.clock(on)
  const { submitted, readers } = host(on)
  await startSession($)

  await revdiff($, '')
  await clock.settle()
  await revdiff($, '')
  await clock.settle()
  expect(readers).toHaveLength(2)
  expect(submitted).toHaveLength(2)

  readers[0]?.release()
  await clock.settle()
  expect(submitted).toHaveLength(2)
  readers[1]?.release()
  await clock.settle()
  expect(submitted).toHaveLength(3)
})

test('a reload picks up the FIFO a still-open pane flushes into', async ($, on) => {
  mock.env(on, ZELLIJ_ENV)
  const clock = mock.clock(on)
  const { submitted, readers } = host(on, { hasFifo: true })
  await startSession($)
  await clock.settle()

  expect(readers[0]?.argv).toEqual(['sh', '-c', 'exec cat <>"$1"', 'sh', FIFO])
  expect(submitted).toHaveLength(1)
})

test('a pane opened before /clear stops delivering', async ($, on) => {
  mock.env(on, ZELLIJ_ENV)
  const clock = mock.clock(on)
  const { submitted, readers } = host(on)
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  await startSession($)

  await revdiff($, '')
  await clock.settle()
  expect(submitted).toHaveLength(1)

  await $.session.end({ reason: 'clear', sessionId: 'sess', resume: { id: 'sess' } })
  readers[0]?.release()
  await clock.settle()
  expect(submitted).toHaveLength(1)
})

test('the pane is named for the session title once one is known', async ($, on) => {
  mock.env(on, ZELLIJ_ENV)
  const { runs } = host(on)
  await startSession($)
  await $.classic.SessionStart({ source: 'startup', session_id: 'sess' })

  await revdiff($, '')
  expect(paneName(runs)).toBe('revdiff: proj · sess')

  await $.classic.UserPromptSubmit({ session_id: 'sess', prompt: 'hi', session_title: 'Review the relay' })
  runs.length = 0
  await revdiff($, '')
  expect(paneName(runs)).toBe('revdiff: Review the relay')
})

test('outside Zellij nothing is started', async ($, on) => {
  mock.env(on, { PATH: '/bin' })
  const { runs, readers } = host(on)
  await startSession($)

  const ran = await revdiff($, '')
  expect(ran.text).toBe('Not inside a Zellij session.')
  expect(runs).toEqual([])
  expect(readers).toEqual([])
})
