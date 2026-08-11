#!/usr/bin/env bash
# revdiff's --post-flush-command: hand the current annotation set to the relay
# (scripts/relay.sh) over a FIFO. Runs once per successful `O` flush, in the
# Zellij server's environment.
#
# usage: flush.sh --annotations <file> --fifo <path>
#
# This script does not touch the inbox socket — the relay does, because it must
# be a Claude Code descendant and this script (a child of revdiff, which the
# Zellij server spawned) is not. All this needs to reach is the FIFO.
#
# revdiff waits for this before restoring the TUI, so it stays fast and never
# blocks indefinitely: the FIFO write is bounded by a timeout in case the relay
# has died. Failures are logged next to the annotations; if flushes seem to
# vanish, read flush.log and relay.log beside it.
set -euo pipefail

ANNOTATIONS=""
FIFO=""

while [ $# -gt 0 ]; do
    case "$1" in
        --annotations) ANNOTATIONS="${2:-}"; shift 2 ;;
        --fifo)        FIFO="${2:-}"; shift 2 ;;
        *) printf 'flush.sh: unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
done

if [ -z "$ANNOTATIONS" ] || [ -z "$FIFO" ]; then
    echo "flush.sh: --annotations and --fifo are both required" >&2
    exit 2
fi

LOG="$(dirname "$ANNOTATIONS")/flush.log"
log() { printf '%s flush.sh: %s\n' "$(date -Is)" "$1" >> "$LOG" 2>/dev/null || true; }

# Nothing to relay: the reviewer flushed an empty set, or cleared every
# annotation. Staying silent spares the session a turn with nothing to act on.
if [ ! -s "$ANNOTATIONS" ] || [ -z "$(tr -d '[:space:]' < "$ANNOTATIONS")" ]; then
    log "empty annotation set; nothing sent"
    exit 0
fi

# One record per flush, NUL-terminated. Annotations are text and contain no NUL,
# so the relay reads back exactly one whole multi-line set per record. The
# timeout keeps a dead relay — nothing holding the FIFO's read end — from
# freezing the TUI on the blocking open.
# shellcheck disable=SC2016  # $1/$2 are the inner sh -c's positional params.
if timeout 5 sh -c '{ cat "$1"; printf "\0"; } > "$2"' _ "$ANNOTATIONS" "$FIFO" 2>>"$LOG"; then
    log "relayed $(wc -c < "$ANNOTATIONS") bytes to the flush pipe"
else
    log "flush-pipe write failed or timed out (relay not running?)"
    exit 1
fi
