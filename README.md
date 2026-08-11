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

Nothing on the Claude Code side watches or waits. `/revdiff` stands up a process wired with
enough context to inject back into your session, and that is the extent of it.

## Requirements

- `revdiff` on PATH, with `--post-flush-command` and the `flush_output` action (`O`)
- `jq` and `socat` reachable from the shell Claude Code runs in. `launch.sh` resolves them to
  absolute paths and passes those to the relay, so they do **not** need to be on the Zellij
  server's PATH — a different, commonly barer environment. A missing tool fails the launch
  immediately rather than the first flush
- Zellij with floating pane support, and Claude Code running inside a Zellij session
- Claude Code **v2.1.224 or later** on macOS or Linux, in a session that binds an inbox
  socket — check with `/status`, which shows a `Peer address` row when it has one

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

Arguments are passed through to revdiff unmodified.

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

A flush travels revdiff → `flush.sh` → FIFO → relay → inbox socket. The split exists for one
reason: a socket message is shown in your chat without cross-session framing, and is
delivered even in permission-bypassing sessions, only when its sender is a **live descendant
of the Claude Code process**. revdiff is spawned by the Zellij server, so `flush.sh`
(revdiff's child) never qualifies — but the relay does, because the skill runs it as a
Claude Code background task.

- The skill runs `skills/revdiff/scripts/launch.sh` **as a background task**. It points
  revdiff's `--output` at `/tmp/revdiff-<session-id>/annotations`, creates a FIFO beside it,
  opens the floating pane, and then — without returning — execs into the relay. It passes
  `--post-flush-command` naming `flush.sh` with the annotations path and the FIFO; that
  command runs in the Zellij server's environment, so it must carry everything it needs, but
  that is now just two paths.
- The relay (`skills/revdiff/scripts/relay.sh`, which `launch.sh` execs into, keeping the
  same pid) is the piece that writes the socket, so it must descend from Claude Code. That
  holds only because the skill launched it as a background task: such a task stays a live
  Claude Code child. A *detached* process would not — when its launcher exits it reparents to
  init/systemd, not to Claude Code — which is why the relay is never backgrounded or
  `setsid`'d away from the task. It holds the FIFO open, reads one NUL-delimited annotation
  record per flush, frames each with `jq`, and writes it with a one-way `socat`. It runs for
  the length of the review; exactly one runs per session, since `launch.sh` stops any prior
  one (by pidfile) before opening a new pane.
- `skills/revdiff/scripts/flush.sh` runs once per successful flush, in the Zellij server's
  environment. It exits silently on an empty annotation set, so clearing your comments costs
  Claude nothing; otherwise it writes the set plus a NUL terminator to the FIFO, bounded by a
  timeout so a dead relay can't freeze the TUI.
- The message carries `session_id`, so a stale socket path makes the receiver drop it rather
  than deliver into whichever session now owns that pid, and is prefixed
  `Annotations from revdiff:` so one arriving mid-task names its source.
- Annotation lifecycle is revdiff's, not the plugin's. `R` drops the annotations on lines the
  reload changed and keeps the others, so a comment that comes back around is one you left
  standing on purpose. The plugin does no diffing and keeps no snapshot, which is also why
  git, jj, and hg all behave identically.

### Debugging

revdiff reports a post-flush-command failure on its own stdout, not in the TUI — and the
pane runs with `--close-on-exit`, so that output dies with the pane. The socket discards
malformed writes without complaint too.

So the scripts log beside the annotations, in `/tmp/revdiff-<session-id>/`: `flush.sh`
records each flush and hand-off in `flush.log`, and `relay.sh` records each socket write in
`relay.log`. If flushes seem to vanish, read those first.
