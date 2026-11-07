#!/usr/bin/env bash
# Install, check or remove the version-filter patch in the running Onyx api_server container.
#
#   onyx-patches/version-filter/apply.sh apply    copy version_filter.py in, edit search_tool.py
#                                                 (three one-line changes), restart api_server
#   onyx-patches/version-filter/apply.sh check    exit 0 when the patch is in place
#   onyx-patches/version-filter/apply.sh revert   restore search_tool.py, remove the module, restart
#   onyx-patches/version-filter/apply.sh rule [labels|latest-dated]
#                                                 show or set the selection rule (no restart)
#
# The patch lives only in the container's filesystem: a `docker compose up --force-recreate`
# of api_server drops it. The eval hook checks it against manifest.json (onyx_api_server_patches).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
C=${ONYX_API_SERVER_CONTAINER:-onyx-api_server-1}
ST=/app/onyx/tools/tool_implementations/search/search_tool.py
MOD=/app/onyx/secondary_llm_flows/version_filter.py
MARK='onyx-evals version-filter patch'

markers() { docker exec "$C" grep -c "$MARK" "$ST" 2>/dev/null || true; }
module_present() { docker exec "$C" test -f "$MOD"; }

wait_healthy() {
  local base
  base=$(grep -s '^ONYX_BASE_URL=' "$HERE/../../.env" | cut -d= -f2- || true)
  [ -n "$base" ] || return 0
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$base/api/health")" = 200 ] && return 0
    sleep 2
  done
  echo "api_server did not report healthy within 2 minutes" >&2
  return 1
}

case ${1:-} in
  check)
    if module_present && [ "$(markers)" = 3 ]; then
      echo "version-filter patch is applied in $C"
      exit 0
    fi
    echo "version-filter patch is NOT applied in $C (markers in search_tool.py: $(markers), module: $(module_present && echo present || echo missing)). Apply it with: $0 apply" >&2
    exit 1;;
  apply)
    docker exec "$C" test -f "$ST.orig" || docker exec "$C" cp "$ST" "$ST.orig"
    docker cp "$HERE/version_filter.py" "$C:$MOD"
    docker exec -i "$C" python - "$ST" "$MARK" <<'PY'
import sys
path, mark = sys.argv[1], sys.argv[2]
src = open(path).read()
if mark in src:
    print("search_tool.py already patched")
    sys.exit(0)
edits = [
    ("from onyx.secondary_llm_flows.time_filter import TimeFilter, decide_time_filter\n",
     "from onyx.secondary_llm_flows.time_filter import TimeFilter, decide_time_filter\n"
     "from onyx.secondary_llm_flows.version_filter import apply_time_filter, decide_as_at_filter  # MARK\n"),
    ("jobs.append((decide_time_filter, (message_history, self.llm)))",
     "jobs.append((decide_as_at_filter, (message_history, self.llm)))  # MARK"),
    ("effective_filters = time_filter.apply_to(effective_filters or BaseFilters())",
     "effective_filters = apply_time_filter(time_filter, effective_filters or BaseFilters())  # MARK"),
]
for old, new in edits:
    assert src.count(old) == 1, f"anchor not found exactly once: {old!r}"
    src = src.replace(old, new.replace("MARK", mark))
open(path, "w").write(src)
print("search_tool.py patched")
PY
    docker exec "$C" python -c "import ast; ast.parse(open('$ST').read()); ast.parse(open('$MOD').read())"
    docker exec "$C" python -c "import onyx.secondary_llm_flows.version_filter" 2>&1 | tail -2
    docker restart "$C" >/dev/null
    wait_healthy
    "$0" check;;
  rule)
    # Which rule picks the versions: labels (in-force tags, default) or latest-dated (file name
    # and file date only). Read per search, so no restart.
    case ${2:-} in
      labels|latest-dated) docker exec "$C" sh -c "echo $2 > ${MOD%.py}.rule"; echo "version rule set to $2";;
      "") echo "version rule: $(docker exec "$C" cat "${MOD%.py}.rule" 2>/dev/null || echo labels)";;
      *) echo "usage: $0 rule [labels|latest-dated]" >&2; exit 2;;
    esac;;
  revert)
    docker exec "$C" sh -c "[ -f $ST.orig ] && mv $ST.orig $ST; rm -f $MOD ${MOD%.py}.rule"
    docker restart "$C" >/dev/null
    wait_healthy
    echo "version-filter patch removed from $C";;
  *)
    echo "usage: $0 apply|check|revert|rule [labels|latest-dated]" >&2
    exit 2;;
esac
