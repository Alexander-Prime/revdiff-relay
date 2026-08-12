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

- `revdiff` on PATH, with the `flush_output` action (`O`)
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
the session. revdiff writes each flush to a file, and Claude Code tells the module when that
file changes.

- When the session starts, the module asks Claude Code to watch
  `/tmp/revdiff-<session-id>/annotations`, creating it if needed, and registers `/revdiff`.
- `/revdiff` empties that file, so nothing from an earlier review carries over, and opens
  the floating pane with revdiff's `--output` pointed at it. The pane is named after the
  session's title, or the directory and the start of the session ID when there's no title
  yet, so you can tell which conversation it belongs to.
- On each `O`, revdiff rewrites the file with the full current annotation set. When Claude
  Code reports the change, the module reads the file and submits the set prefixed
  `Annotations from revdiff:`. It's submitted as your own words, so Claude reads it without
  the frame Claude Code puts around plugin messages; the transcript still records that it
  came from the plugin. A flush that lands while Claude is busy waits for the session to go
  idle and then starts a turn of its own, in order. Flushing the same set again sends it
  again.
- Delivery takes a moment after `O`: Claude Code waits for the file to settle before
  reporting the change, which keeps it from reading a half-written set.
- The watch belongs to the session. After `/clear` — which starts a new session — a pane
  opened before it is no longer heard, and its pane name shows the old title. Run
  `/revdiff` again in the new session.
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

If flushes seem to vanish, check that the file changes: `/tmp/revdiff-<session-id>/annotations`
should hold your annotations after `O`. A submit Claude Code refuses is logged to its debug
log (`claude --debug`) under the plugin's name.
