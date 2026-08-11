#!/usr/bin/env bash
# Carry each revdiff flush into this Claude Code session's inbox socket.
#
# usage: relay.sh --fifo <path> --socket-path <uds> --session-id <id>
#                 --jq <path> --socat <path>
#
# launch.sh execs into this script, keeping the same pid, and runs it for the
# whole review. It exists for one reason: a message written to the inbox socket
# is shown in the user's chat without the cross-session framing only when its
# sender is a live descendant of the Claude Code process. revdiff is spawned by
# the Zellij server, so flush.sh (revdiff's child) can never qualify. This relay
# does, because the skill launched it (via launch.sh) as a Claude Code background
# task, which stays a live Claude Code child — a detached process would reparent
# to init/systemd and lose that ancestry. It is reaped when the session ends.
#
# It reads NUL-delimited annotation records from the FIFO and writes one inbox
# message per record. launch.sh stops any prior relay before starting a new one,
# so exactly one runs per session.
set -euo pipefail

FIFO=""
SOCKET=""
SESSION_ID=""
JQ=""
SOCAT=""

while [ $# -gt 0 ]; do
    case "$1" in
        --fifo)        FIFO="${2:-}"; shift 2 ;;
        --socket-path) SOCKET="${2:-}"; shift 2 ;;
        --session-id)  SESSION_ID="${2:-}"; shift 2 ;;
        --jq)          JQ="${2:-}"; shift 2 ;;
        --socat)       SOCAT="${2:-}"; shift 2 ;;
        *) printf 'relay.sh: unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
done

if [ -z "$FIFO" ] || [ -z "$SOCKET" ] || [ -z "$SESSION_ID" ] \
   || [ -z "$JQ" ] || [ -z "$SOCAT" ]; then
    echo "relay.sh: --fifo, --socket-path, --session-id, --jq and --socat are all required" >&2
    exit 2
fi

LOG="$(dirname "$FIFO")/relay.log"
log() { printf '%s relay.sh: %s\n' "$(date -Is)" "$1" >> "$LOG" 2>/dev/null || true; }

LEAD_IN="Annotations from revdiff:"

log "started (pid $$)"

# Open the FIFO read-write and hold it. This keeps a reader on the pipe for the
# relay's entire life, so flush.sh's writes never block on open and the relay
# never sees a spurious EOF between flushes. The consequence is that the read
# loop never ends on its own — the relay runs until launch.sh kills it on the
# next /revdiff, or the session ends and Claude Code reaps it.
exec 3<>"$FIFO"

# shellcheck disable=SC2016  # the jq program is single-quoted deliberately:
# $sid, $lead and $ann are jq variables, not shell expansions.
build_payload() {
    "$JQ" -cn --arg sid "$SESSION_ID" --arg lead "$LEAD_IN" --arg ann "$1" \
        '{
            type: "user",
            session_id: $sid,
            from: "revdiff",
            message: { role: "user", content: ($lead + "\n\n" + $ann) }
        }'
}

while IFS= read -r -d '' record <&3; do
    [ -n "$record" ] || continue

    if ! payload=$(build_payload "$record" 2>>"$LOG"); then
        log "failed to build payload; dropping one flush"
        continue
    fi

    # The receiver reads a line at a time and drops the connection once one
    # exceeds 1 MiB, reporting nothing. Bytes, not characters — multibyte
    # annotations are longer than their character count.
    bytes=$(printf '%s\n' "$payload" | wc -c)
    if [ "$bytes" -ge 1048576 ]; then
        log "payload is $bytes bytes; receiver drops lines at 1 MiB, so this would vanish. Annotation set too large."
        continue
    fi

    # -u is one-way: send and close without waiting on a reply the server never
    # sends. The timeout bounds a stuck connection so one bad flush can't wedge
    # the relay.
    if printf '%s\n' "$payload" | timeout 5 "$SOCAT" -u - "UNIX-CONNECT:$SOCKET" 2>>"$LOG"; then
        log "sent one flush ($bytes bytes)"
    else
        log "socat write failed to $SOCKET"
    fi
done

log "FIFO closed; exiting"
