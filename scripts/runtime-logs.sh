#!/usr/bin/env bash
#
# Tail the embedded desktop runtime log (runtime.log) without hunting for the
# deep, per-profile userData path. Auto-discovers the most-recently-written
# runtime.log under the Electron userData dirs; pretty-prints pino JSON when
# `jq` is available.
#
#   scripts/runtime-logs.sh                      # follow everything
#   scripts/runtime-logs.sh composio             # only lines matching /composio/i
#   scripts/runtime-logs.sh 'execute.failure|cfRay'
#   HOLABOSS_RUNTIME_LOG=/path/to/runtime.log scripts/runtime-logs.sh
#
set -euo pipefail

log="${HOLABOSS_RUNTIME_LOG:-}"
if [[ -z "$log" ]]; then
  # Newest runtime.log under the Electron userData dirs — handles the escaped
  # per-profile dir name (e.g. _Users_you_.holaboss-desktop) without hardcoding.
  log="$(find "$HOME/Library/Application Support" -maxdepth 2 -name runtime.log -type f 2>/dev/null \
    | while read -r f; do printf '%s\t%s\n' "$(stat -f '%m' "$f" 2>/dev/null || echo 0)" "$f"; done \
    | sort -rn | head -1 | cut -f2-)"
fi

if [[ -z "$log" || ! -f "$log" ]]; then
  echo "runtime.log not found (is the desktop running?). Override with HOLABOSS_RUNTIME_LOG=/path/to/runtime.log" >&2
  exit 1
fi

filter="${1:-}"
echo "→ tailing $log${filter:+   (filter: /$filter/i)}" >&2

pretty() {
  if command -v jq >/dev/null 2>&1; then
    jq -Rr '
      . as $line
      | (try (fromjson) catch null) as $j
      | if $j == null then $line
        else
          (try (
            (($j.time // 0) / 1000 | floor | localtime | strftime("%H:%M:%S")) as $t
            | ({"10":"TRC","20":"DBG","30":"INF","40":"WRN","50":"ERR","60":"FTL"}[($j.level | tostring)] // "?") as $lvl
            | "\($t) \($lvl) " + ($j.event // $j.msg // "")
              + (if $j.toolSlug then "  tool=\($j.toolSlug)" else "" end)
              + (if $j.httpStatus then "  status=\($j.httpStatus)" else "" end)
              + (if $j.cfRay then "  cf-ray=\($j.cfRay)" else "" end)
              + (if $j.originServer then "  server=\($j.originServer)" else "" end)
              + (if $j.responseBody then "  body=\(($j.responseBody | tostring)[0:200])" else "" end)
          ) catch $line)
        end'
  else
    cat
  fi
}

if [[ -n "$filter" ]]; then
  tail -n 200 -F "$log" | grep --line-buffered -iE "$filter" | pretty
else
  tail -n 200 -F "$log" | pretty
fi
