import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

const COMMAND = 'revdiff'
const LEAD_IN = 'Annotations from revdiff:'

const GUIDANCE = `The user opened revdiff over the current diff in a floating Zellij pane. Each time they press O there, their annotations arrive in this session as a message beginning "${LEAD_IN}", on their own schedule: possibly interleaved with unrelated work, possibly never. Treat each one as the user handing you review comments: answer questions in conversation and make the changes they ask for. Don't wait on or poll for annotations.

When the user reloads the diff, revdiff clears annotations on lines the reload changed and keeps the rest, so an annotation they send again is deliberately still standing.

Annotations are \`## path/to/file:43 (+)\` headers followed by the comment text, where (+) is an added line, (-) a removed line, ( ) an unchanged context line, and no line number means a file-level comment.`

// Prompts can't be submitted from command.run; the reader runs from session.start.
// https://code.claude.com/docs/en/plugins/mods/api#start-a-turn-from-a-background-job
let isStarted = false
let pendingFifo: string | undefined
let wakeLoop: (() => void) | undefined
let reader: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let sessionTitle: string | undefined

async function nextFifo(): Promise<string> {
  while (pendingFifo === undefined) await new Promise<void>(resolve => (wakeLoop = resolve))
  const fifo = pendingFifo
  pendingFifo = undefined
  return fifo
}

function stopReader() {
  pendingFifo = undefined
  const stopping = reader
  reader = undefined
  void stopping?.return({ code: null, signal: 'SIGTERM' })
}

function requestReader(fifo: string) {
  stopReader()
  pendingFifo = fifo
  wakeLoop?.()
}

function statePaths(sessionId: string) {
  const dir = `/tmp/revdiff-${sessionId}`
  return { dir, annotations: `${dir}/annotations`, fifo: `${dir}/flush.pipe` }
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

async function findOnPath($: EngineInterface, name: string) {
  for (const dir of ((await $.env.get('PATH')) ?? '').split(':')) {
    if (!dir) continue
    const path = `${dir}/${name}`
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat?.kind === 'file') return path
  }
  return undefined
}

function startReader($: EngineInterface, fifo: string) {
  // Opened read-write so cat never sees EOF between flushes.
  const child = $.process.spawn({ argv: ['sh', '-c', 'exec cat <>"$1"', 'sh', fifo] })
  reader = child

  void (async () => {
    let pending = ''
    try {
      for await (const { stream, text } of child) {
        // return() doesn't cancel a pending read.
        if (reader !== child) break
        if (stream === 'stderr') {
          $.ui.log(`reader: ${text.trim()}`, { to: 'debug' })
          continue
        }
        pending += text
        for (let end = pending.indexOf('\0'); end !== -1; end = pending.indexOf('\0')) {
          const record = pending.slice(0, end)
          pending = pending.slice(end + 1)
          if (record.trim()) await $.prompt.submit({ text: `${LEAD_IN}\n\n${record}`, asUser: true })
        }
      }
    } catch (err) {
      $.ui.log(`reader stopped: ${String(err)}`, { to: 'debug' })
    }
    if (reader === child) reader = undefined
  })()
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (!e.isInteractive) return next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Annotate the current diff in a floating revdiff pane',
      argumentHint: '[ref] [ref2] [--staged] [--only=<file>]',
    })
    const started = await next(e)
    isStarted = true
    void (async () => {
      for (;;) startReader($, await nextFifo())
    })()

    // A reload kills the reader but not the pane; resume an existing FIFO.
    const { fifo } = statePaths(await $.session.id())
    const stat = await $.fs.stat(fifo).catch(() => undefined)
    if (stat?.kind === 'other') requestReader(fifo)

    return started
  })

  // A pane belongs to its session; /clear and /resume end it without a reload.
  on('session.end', async (_$, e, next) => {
    stopReader()
    sessionTitle = undefined
    return next(e)
  })

  // Title only: classic.* hooks are skipped under managed settings.
  // https://code.claude.com/docs/en/plugins/mods/admin#know-what-happens-by-default
  on('classic.SessionStart', async (_$, e, next) => {
    sessionTitle = e.session_title
    return next(e)
  })

  on('classic.UserPromptSubmit', async (_$, e, next) => {
    if (e.session_title) sessionTitle = e.session_title
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (!isStarted) return { text: 'The session has not started yet.' }
    if (!(await $.env.get('ZELLIJ'))) return { text: 'Not inside a Zellij session.' }

    // The pane runs in the Zellij server's environment, whose PATH may differ.
    const revdiff = await findOnPath($, 'revdiff')
    if (!revdiff) return { text: 'revdiff not found on PATH.' }

    const sessionId = await $.session.id()
    const { dir, annotations, fifo } = statePaths(sessionId)

    stopReader()
    await $.process.run(['mkdir', '-p', dir])
    await $.process.run(['rm', '-f', annotations, fifo])
    await $.process.run(['mkfifo', fifo])
    requestReader(fifo)

    const flush = `${$.plugin.root}/scripts/flush.sh`
    const postFlush = `${shellQuote(flush)} --annotations ${shellQuote(annotations)} --fifo ${shellQuote(fifo)}`
    let cmd = [
      revdiff,
      `--output=${annotations}`,
      `--post-flush-command=${postFlush}`,
      ...e.args.split(/\s+/).filter(Boolean),
    ]

    const editors: string[] = []
    const editor = await $.env.get('EDITOR')
    const visual = await $.env.get('VISUAL')
    if (editor) editors.push(`EDITOR=${editor}`)
    if (visual) editors.push(`VISUAL=${visual}`)
    if (editors.length > 0) cmd = ['/usr/bin/env', ...editors, ...cmd]

    const cwd = await $.session.cwd()
    const owner = sessionTitle
      ? sessionTitle.length > 60 ? `${sessionTitle.slice(0, 59)}…` : sessionTitle
      : `${cwd.split('/').pop()} · ${sessionId.slice(0, 8)}`
    const opened = await $.process.run([
      'zellij', 'run', '--floating', '--close-on-exit',
      '--width', (await $.env.get('REVDIFF_POPUP_WIDTH')) ?? '90%',
      '--height', (await $.env.get('REVDIFF_POPUP_HEIGHT')) ?? '90%',
      '--x', '5%', '--y', '5%',
      '--name', `revdiff: ${owner}`, '--cwd', cwd,
      '--', ...cmd,
    ])
    if (opened.exitCode !== 0) {
      stopReader()
      return { text: `zellij could not open the pane: ${opened.stderr.trim()}` }
    }

    return {
      text: 'revdiff is open. Press O in the pane to send annotations here, R to reload the diff.',
      context: [GUIDANCE],
    }
  })
}
