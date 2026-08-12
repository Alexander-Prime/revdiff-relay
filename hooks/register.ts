import type { EngineInterface, Register } from 'claude-code'

const COMMAND = 'revdiff'
const LEAD_IN = 'Annotations from revdiff:'

// Recorded for the model when the pane opens, so it knows what the messages
// that follow are and what to do with them.
const GUIDANCE = `The user opened revdiff over the current diff in a floating Zellij pane. Each time they press O there, their annotations arrive in this session as a message beginning "${LEAD_IN}", on their own schedule: possibly interleaved with unrelated work, possibly never. Treat each one as the user handing you review comments: answer questions in conversation and make the changes they ask for. Don't wait on or poll for annotations.

When the user reloads the diff, revdiff clears annotations on lines the reload changed and keeps the rest, so an annotation they send again is deliberately still standing.

Annotations are \`## path/to/file:43 (+)\` headers followed by the comment text, where (+) is an added line, (-) a removed line, ( ) an unchanged context line, and no line number means a file-level comment.`

// Where a session's revdiff writes its annotations. revdiff rewrites the file
// on every flush and Claude Code watches it, so the file is the whole hand-off.
const annotationsPath = (sessionId: string) => `/tmp/revdiff-${sessionId}/annotations`

// The first file named `name` in a PATH directory, as `command -v` finds it.
async function findOnPath($: EngineInterface, name: string) {
  for (const dir of ((await $.env.get('PATH')) ?? '').split(':')) {
    if (!dir) continue
    const path = `${dir}/${name}`
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat?.kind === 'file') return path
  }
  return undefined
}

// The session's title, for the pane's name, so a pane left open across /clear
// visibly names the conversation it belongs to. Claude Code passes it on these
// two events only; a new session has none until its first prompt is titled.
let sessionTitle: string | undefined

// Flushes waiting to be submitted. The FileChanged hook can't submit them
// itself (the host refuses a prompt from a hook a turn may be waiting on), so
// it queues them here for a task session.start owns, which sleeps until woken.
const flushes: string[] = []
let wake: (() => void) | undefined

function queueFlush(text: string) {
  flushes.push(text)
  wake?.()
}

async function nextFlush(): Promise<string> {
  while (flushes.length === 0) await new Promise<void>(resolve => (wake = resolve))
  return flushes.shift() as string
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (e.isInteractive) {
      await $.command.register({
        name: COMMAND,
        description: 'Annotate the current diff in a floating revdiff pane',
        argumentHint: '[ref] [ref2] [--staged] [--only=<file>]',
      })
    }
    const started = await next(e)

    // Submits each queued flush in order. A prompt submitted mid-turn waits
    // for the session to go idle, so awaiting it keeps later flushes behind.
    void (async () => {
      for (;;) {
        const text = await nextFlush()
        try {
          await $.prompt.submit({ text: `${LEAD_IN}\n\n${text}`, asUser: true })
        } catch (err) {
          $.ui.log(`submit rejected: ${String(err)}`, { to: 'debug' })
        }
      }
    })()

    return started
  })

  // Claude Code watches the paths a SessionStart hook returns and raises
  // FileChanged for each. The watch is tied to the session: after /clear a
  // pane opened before it is no longer heard.
  on('classic.SessionStart', async ($, e, next) => {
    sessionTitle = e.session_title
    const result = await next(e)
    const annotations = annotationsPath(e.session_id)
    // The file must exist to be watched.
    if (!(await $.fs.exists(annotations))) await $.fs.write(annotations, '')
    return { ...result, watchPaths: [...(result.watchPaths ?? []), annotations] }
  })

  on('classic.UserPromptSubmit', async (_$, e, next) => {
    if (e.session_title) sessionTitle = e.session_title
    return next(e)
  })

  on('classic.FileChanged', async ($, e, next) => {
    const annotations = annotationsPath(e.session_id)
    if (e.file_path !== annotations || e.event === 'unlink') return next(e)

    // Each flush is the whole current set. An empty file is /revdiff
    // resetting it; there's nothing for Claude to act on.
    const text = await $.fs.read(annotations)
    if (text.trim()) queueFlush(text)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (!(await $.env.get('ZELLIJ'))) return { text: 'Not inside a Zellij session.' }

    // Resolved here, because the pane runs in the Zellij server's environment,
    // whose PATH may not have it.
    const revdiff = await findOnPath($, 'revdiff')
    if (!revdiff) return { text: 'revdiff not found on PATH.' }

    // Start from an empty file, so no annotation from an earlier review
    // carries into this one. Truncating, not deleting, keeps the watch.
    const sessionId = await $.session.id()
    const annotations = annotationsPath(sessionId)
    await $.fs.write(annotations, '')

    let cmd = [revdiff, `--output=${annotations}`, ...e.args.split(/\s+/).filter(Boolean)]

    // The Zellij server spawns pane commands with its own environment, which
    // predates shell rc exports; carry the editor through so revdiff's
    // multi-line annotation flow opens the right one.
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
    // zellij run returns as soon as the pane exists. Bad revdiff arguments
    // surface as a pane that closes at once.
    const opened = await $.process.run([
      'zellij', 'run', '--floating', '--close-on-exit',
      '--width', (await $.env.get('REVDIFF_POPUP_WIDTH')) ?? '90%',
      '--height', (await $.env.get('REVDIFF_POPUP_HEIGHT')) ?? '90%',
      '--x', '5%', '--y', '5%',
      '--name', `revdiff: ${owner}`, '--cwd', cwd,
      '--', ...cmd,
    ])
    if (opened.exitCode !== 0) {
      return { text: `zellij could not open the pane: ${opened.stderr.trim()}` }
    }

    return {
      text: 'revdiff is open. Press O in the pane to send annotations here, R to reload the diff.',
      context: [GUIDANCE],
    }
  })
}
