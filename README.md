# revdiff-relay

A Claude Code plugin that wires [revdiff](https://github.com/umputun/revdiff) into a
floating [Zellij](https://zellij.dev) pane and pipes your diff annotations straight into
your Claude Code session.

`/revdiff` opens the revdiff TUI over the current diff and gets out of the way. Annotate,
press `O`, and the annotations appear in your session as a message — Claude answers
questions in conversation and implements change requests. Press `R` to reload the diff and
see what changed, annotate again, flush again. There is no round structure and no fixed
number of passes: the pane is yours for as long as you want it, and each flush is just a
message.

Claude doesn't wait on the pane or poll it, and doesn't spend a turn until a flush arrives.

## Requirements

- `revdiff` on PATH, with `--post-flush-command` and the `flush_output` action (`O`)
- Zellij with floating pane support, and Claude Code running inside a Zellij session
- A Claude Code release with mods (function hooks), on macOS or Linux. Developed against
  v2.1.287; the mod API is early access and may move between releases

## Install

```
/plugin marketplace add <git-url-or-owner/repo-or-local-path>
/plugin install revdiff-relay@revdiff-relay
```

## Usage

```
/revdiff              auto-detect: working-copy changes, last commit, or branch vs main
/revdiff main         review against a branch
/revdiff @-           any ref syntax revdiff understands (git, jj, and hg supported)
/revdiff --staged     staged changes only
```

Arguments are split on whitespace and passed through to revdiff.

In the pane:

| Key | Effect                                                   |
| --- | -------------------------------------------------------- |
| `O` | Flush annotations to Claude without closing the pane     |
| `R` | Reload the diff from the VCS, picking up Claude's edits  |
| `i` | Info popup                                               |

`O` and `R` are revdiff's own keys and are rebindable in its config.

## Configuration

### Other

- `REVDIFF_POPUP_WIDTH` / `REVDIFF_POPUP_HEIGHT` — floating pane size (default `90%`)
- revdiff's own look and behavior (theme, line numbers, keybindings) belong in
  `~/.config/revdiff/config`, which applies to manual runs too

## How it works

The plugin is a mod: a hooks module, `hooks/register.ts`, that Claude Code loads alongside
the session. A flush travels revdiff → `scripts/flush.sh` → FIFO → the hooks module → your
session.

- When the session starts, the module registers `/revdiff` and starts a task that sleeps
  until there's a review to read.
- `/revdiff` points revdiff's `--output` at `/tmp/revdiff-<session-id>/annotations`, creates
  a FIFO beside it, hands the FIFO to that task and opens the floating pane. The pane is
  named after the session's title, or the directory and the start of the session ID when
  there's no title, so you can tell which conversation it belongs to.
- revdiff runs `flush.sh` after each `O`, in the Zellij server's environment. It exits
  silently on an empty annotation set; otherwise it writes the set plus a NUL terminator to
  the FIFO, bounded by a timeout so a dead reader can't freeze the TUI.
- The task runs `cat` on the FIFO as a child of Claude Code, reads one annotation set per
  flush and submits it prefixed `Annotations from revdiff:`. It's submitted as your own
  words, so Claude reads it without the frame Claude Code puts around plugin messages; the
  transcript still records that it came from the plugin. A flush that lands while Claude is
  busy waits for the session to go idle and then starts a turn of its own, in order. One
  reader runs per session: a new `/revdiff` replaces it, a plugin reload picks the open FIFO
  back up, and Claude Code ends it with the session.
- Delivery uses only the mod API's own events. Claude Code's older `classic.*` hook events
  are skipped for user-installed plugins wherever an organization manages Claude Code, so
  the plugin reads the session title from them but doesn't depend on them; under managed
  settings the pane gets the fallback name.
- A pane belongs to the session that opened it. After `/clear`, which starts a new session,
  run `/revdiff` again.
- Annotation lifecycle is revdiff's, not the plugin's. `R` drops the annotations on lines the
  reload changed and keeps the others, so a comment that comes back around is one you left
  standing on purpose. The plugin does no diffing and keeps no snapshot, which is also why
  git, jj, and hg all behave identically.

## Development

`claude plugin test .` runs `hooks/register.test.ts`. `claude plugin validate
.claude-plugin/plugin.json` reports what the module hooks and calls. Run Claude Code with
`--plugin-dir .` to load the plugin from the checkout; saving the module reloads it. Loading
also writes the API's type declarations into `.claude-plugin/types/` and a `tsconfig.json`
that extends them, both ignored, so after the first load `tsc -p .` (in the dev shell)
type-checks `hooks/`.

### Debugging

revdiff reports a post-flush-command failure on its own stdout, not in the TUI, and the pane
runs with `--close-on-exit`, so that output dies with the pane. So `flush.sh` logs each flush
and hand-off to `flush.log` beside the annotations, in `/tmp/revdiff-<session-id>/`. The
reader logs to Claude Code's debug log (`claude --debug`, written to
`~/.claude/debug/<session-id>.txt`) under the plugin's name, as does a hook that Claude Code
skips or refuses. If flushes seem to vanish, read those first.
