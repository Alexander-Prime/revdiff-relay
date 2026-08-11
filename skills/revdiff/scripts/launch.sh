#!/usr/bin/env bash
# Open revdiff in a floating Zellij pane, then become the relay that carries each
# flush into this Claude Code session.
#
# usage: launch.sh [revdiff args...]
# MUST be run as a background task (run_in_background), because after opening the
# pane this process does not return — it execs into scripts/relay.sh and runs for
# the length of the review.
#
# The relay must be a Claude Code descendant: a socket message is shown in the
# user's chat without cross-session framing, and is delivered even in
# permission-bypassing sessions, only when its sender descends from the Claude
# Code process. revdiff is spawned by the Zellij server, so scripts/flush.sh
# (revdiff's child) can never qualify. This process can — but only while it stays
# a live child of Claude Code. An orphaned process does NOT: when its launcher
# exits it reparents to init/systemd, not to Claude Code, losing the ancestry.
# So the skill runs this script as a background task (a live Claude Code child)
# and it never detaches: it execs the relay rather than backgrounding it.
set -euo pipefail

if [ -z "${ZELLIJ:-}" ]; then
    echo "error: not inside a Zellij session" >&2
    exit 1
fi

REVDIFF_BIN=$(command -v revdiff || true)
if [ -z "$REVDIFF_BIN" ]; then
    echo "error: revdiff not found in PATH" >&2
    exit 1
fi

if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
    echo "error: not inside a Claude Code session" >&2
    exit 1
fi

# The socket is how annotations get back here, so its absence is fatal rather
# than degraded. A session binds one only with cross-session messaging enabled
# (Claude Code v2.1.224+, macOS/Linux), and binding can fail for reasons not
# visible from inside the session, so say what to check.
SOCKET="${CLAUDE_CODE_MESSAGING_SOCKET:-}"
if [ -z "$SOCKET" ]; then
    cat >&2 <<'EOF'
error: this session has no inbox socket, so revdiff has nowhere to send annotations.
       CLAUDE_CODE_MESSAGING_SOCKET is unset. Check with /status — a session with an
       inbox shows a "Peer address" row. Requires Claude Code v2.1.224 or later on
       macOS or Linux. Starting a fresh session usually binds one.
EOF
    exit 1
fi
SOCKET="${SOCKET#uds:}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLUSH_SCRIPT="$SCRIPT_DIR/flush.sh"
RELAY_SCRIPT="$SCRIPT_DIR/relay.sh"

# Both are checked here because a script that can't start is the one failure that
# leaves no trace: it never writes its log, and revdiff's own error dies with the
# pane.
for s in "$FLUSH_SCRIPT" "$RELAY_SCRIPT"; do
    if [ ! -x "$s" ]; then
        printf 'error: %s is missing or not executable\n' "$s" >&2
        exit 1
    fi
done

# Resolve jq and socat here, in this script's environment, and pass absolute
# paths to the relay. revdiff runs in the Zellij server's environment, whose PATH
# is whatever zellij was started with — routinely barer than this one — so the
# paths must not be left to be re-resolved there. Failing now beats failing at
# flush time, after the reviewer has written their annotations.
JQ_BIN=$(command -v jq || true)
SOCAT_BIN=$(command -v socat || true)
MISSING=""
[ -n "$JQ_BIN" ] || MISSING="jq"
[ -n "$SOCAT_BIN" ] || MISSING="${MISSING:+$MISSING and }socat"
if [ -n "$MISSING" ]; then
    printf 'error: %s not found in PATH; the relay needs it to encode and deliver annotations\n' \
        "$MISSING" >&2
    exit 1
fi

STATE_DIR="/tmp/revdiff-${CLAUDE_CODE_SESSION_ID}"
mkdir -p "$STATE_DIR"
ANNOTATIONS="$STATE_DIR/annotations"
FIFO="$STATE_DIR/flush.pipe"
PIDFILE="$STATE_DIR/relay.pid"

# Stop a relay left over from an earlier /revdiff in this session so exactly one
# runs, then reset the annotations and FIFO so nothing from that review carries
# into this one.
if [ -f "$PIDFILE" ]; then
    OLD_RELAY=$(cat "$PIDFILE" 2>/dev/null || true)
    [ -n "$OLD_RELAY" ] && kill "$OLD_RELAY" 2>/dev/null || true
    rm -f "$PIDFILE"
fi
rm -f "$ANNOTATIONS" "$FIFO"
mkfifo "$FIFO"

# revdiff hands --post-flush-command to a shell, so the arguments are quoted
# here. flush.sh only reaches the FIFO; it needs neither the socket nor the
# resolved tools.
POST_FLUSH=$(printf '%s --annotations %q --fifo %q' "$FLUSH_SCRIPT" "$ANNOTATIONS" "$FIFO")

CMD=("$REVDIFF_BIN" --output="$ANNOTATIONS" --post-flush-command="$POST_FLUSH" "$@")

# the zellij server spawns pane commands with its own environment, which
# predates shell rc exports; carry the caller's editor through so revdiff's
# multi-line annotation flow opens the right one
ENV_ARGS=()
if [ -n "${EDITOR:-}" ]; then ENV_ARGS+=("EDITOR=$EDITOR"); fi
if [ -n "${VISUAL:-}" ]; then ENV_ARGS+=("VISUAL=$VISUAL"); fi
if [ ${#ENV_ARGS[@]} -gt 0 ]; then
    CMD=(/usr/bin/env "${ENV_ARGS[@]}" "${CMD[@]}")
fi

# No --block-until-exit: the pane outlives this call. Bad revdiff arguments
# surface as a pane that closes immediately. zellij run returns as soon as the
# pane is created, so the exec below happens right after — the window in which a
# flush could find no relay is sub-second, far shorter than any human flush.
zellij run --floating --close-on-exit \
    --width "${REVDIFF_POPUP_WIDTH:-90%}" --height "${REVDIFF_POPUP_HEIGHT:-90%}" \
    --x 5% --y 5% \
    --name "revdiff: $(basename "$PWD")" --cwd "$PWD" \
    -- "${CMD[@]}"

echo "revdiff pane open; this task is now the relay. Annotations arrive on each flush (\`O\`)."

# Become the relay. exec keeps this same pid — a live Claude Code child, since
# the skill started this script as a background task — so the relay's socket
# writes are recognized as self-sent. Record that pid so the next /revdiff can
# stop this relay.
echo $$ > "$PIDFILE"
exec "$RELAY_SCRIPT" \
    --fifo "$FIFO" --socket-path "$SOCKET" --session-id "$CLAUDE_CODE_SESSION_ID" \
    --jq "$JQ_BIN" --socat "$SOCAT_BIN"
