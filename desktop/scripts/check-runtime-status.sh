#!/bin/bash
# Desktop Runtime Diagnostic Script
# Usage: bash scripts/check-runtime-status.sh

set -e

DATA_DIR="${HOLABOSS_DESKTOP_USER_DATA_PATH:-$HOME/.holaboss-desktop}"
SANDBOX_ROOT="$DATA_DIR/sandbox-host"
RUNTIME_DB="$SANDBOX_ROOT/state/host-state.db"
RUNTIME_CONFIG="$SANDBOX_ROOT/state/runtime-config.json"
RUNTIME_LOG="$DATA_DIR/runtime.log"
RUNTIME_PORT=5060

echo "=== Desktop Runtime Status ==="
echo ""

# 1. Runtime process
echo "── Runtime Process ──"
PID=$(lsof -ti :$RUNTIME_PORT 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "  ✓ Running on :$RUNTIME_PORT (PID: $PID)"
else
  echo "  ✗ Not running on :$RUNTIME_PORT"
fi

# 2. Runtime health
echo ""
echo "── Runtime Health ──"
HEALTH=$(curl -s -m 3 "http://127.0.0.1:$RUNTIME_PORT/healthz" 2>/dev/null || echo "UNREACHABLE")
echo "  $HEALTH"

# 3. Runtime config
echo ""
echo "── Runtime Config ──"
if [ -f "$RUNTIME_CONFIG" ]; then
  python3 -c "
import json
with open('$RUNTIME_CONFIG') as f:
    d = json.load(f)
h = d.get('holaboss', {})
print(f'  model_proxy_base_url: {h.get(\"model_proxy_base_url\", \"NOT SET\")}')
print(f'  default_model:        {h.get(\"default_model\", \"NOT SET\")}')
print(f'  user_id:              {h.get(\"user_id\", \"NOT SET\")}')
print(f'  sandbox_id:           {h.get(\"sandbox_id\", \"NOT SET\")}')
print(f'  auth_token:           {\"SET\" if h.get(\"auth_token\") else \"MISSING\"}')
url = h.get('model_proxy_base_url', '')
if 'host.docker.internal' in url:
    print('  ⚠ WARNING: model_proxy_base_url uses host.docker.internal (should be 127.0.0.1)')
"
else
  echo "  ✗ $RUNTIME_CONFIG not found"
fi

# 4. Model proxy test
echo ""
echo "── Model Proxy ──"
if [ -f "$RUNTIME_CONFIG" ]; then
  python3 -c "
import json, subprocess
with open('$RUNTIME_CONFIG') as f:
    d = json.load(f)
h = d.get('holaboss', {})
base = h.get('model_proxy_base_url', '')
token = h.get('auth_token', '')
sid = h.get('sandbox_id', '')
uid = h.get('user_id', '')
if not base or not token:
    print('  ✗ Missing model_proxy_base_url or auth_token')
    exit()
url = f'{base}/openai/v1/chat/completions'
r = subprocess.run([
    'curl', '-s', '-m', '10', url,
    '-H', f'X-API-Key: {token}',
    '-H', f'X-Holaboss-Sandbox-Id: {sid}',
    '-H', f'X-Holaboss-User-Id: {uid}',
    '-H', 'Content-Type: application/json',
    '-d', json.dumps({'model':'gpt-4o-mini','messages':[{'role':'user','content':'hi'}],'max_completion_tokens':5})
], capture_output=True, text=True)
try:
    resp = json.loads(r.stdout)
    if 'choices' in resp:
        print(f'  ✓ Model proxy working ({url})')
    elif 'detail' in resp:
        print(f'  ✗ {resp[\"detail\"]}')
    else:
        print(f'  ? Unexpected: {r.stdout[:200]}')
except:
    print(f'  ✗ Failed: {r.stdout[:200] or r.stderr[:200]}')
"
else
  echo "  ✗ No config, skipping"
fi

# 5. App status
echo ""
echo "── Workspace Apps ──"
if [ "$HEALTH" != "UNREACHABLE" ]; then
  WORKSPACES=$(sqlite3 "$RUNTIME_DB" "SELECT id, name, status FROM workspaces WHERE deleted_at_utc IS NULL ORDER BY created_at DESC LIMIT 3;" 2>/dev/null || echo "")
  if [ -n "$WORKSPACES" ]; then
    echo "$WORKSPACES" | while IFS='|' read -r wid wname wstatus; do
      echo "  Workspace: $wname ($wstatus)"
      curl -s -m 5 "http://127.0.0.1:$RUNTIME_PORT/api/v1/apps?workspace_id=$wid" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for app in d.get('apps', []):
        ready = '✓' if app.get('ready') else '✗'
        err = app.get('error', '')
        status = app.get('build_status', '?')
        print(f'    {ready} {app[\"app_id\"]:12s}  ready={app.get(\"ready\",\"?\")}  status={status}')
        if err:
            print(f'      error: {err[:120]}')
except:
    print('    (no apps)')
" 2>/dev/null
    done
  else
    echo "  No workspaces found"
  fi
else
  echo "  ✗ Runtime unreachable, skipping"
fi

# 6. Latest agent runs
echo ""
echo "── Recent Agent Runs ──"
sqlite3 "$RUNTIME_DB" "
SELECT substr(input_id,1,8) || '...',
       status,
       substr(json_extract(payload, '$.text'),1,50),
       created_at
FROM agent_session_inputs
ORDER BY created_at DESC LIMIT 5;
" 2>/dev/null | while IFS='|' read -r iid status text created; do
  icon="·"
  [ "$status" = "COMPLETED" ] && icon="✓"
  [ "$status" = "FAILED" ] && icon="✗"
  echo "  $icon [$status] \"$text\" ($created)"
done

# 7. Workspace root
echo ""
echo "── Workspace Root ──"
if [ -d "$SANDBOX_ROOT/workspace" ]; then
  find "$SANDBOX_ROOT/workspace" -maxdepth 2 -mindepth 1 -type d 2>/dev/null | sed 's#^#  #' || true
else
  echo "  No workspace root found"
fi

# 8. Log tail
echo ""
echo "── Recent Errors (runtime.log) ──"
grep '"level":40\|"level":50' "$RUNTIME_LOG" 2>/dev/null | tail -5 | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line.strip())
        msg = d.get('msg', '')
        err = d.get('err', {})
        if isinstance(err, dict):
            msg = err.get('message', msg)
        print(f'  [{\"WARN\" if d[\"level\"]==40 else \"ERROR\"}] {msg[:120]}')
    except:
        pass
" 2>/dev/null || echo "  (no errors)"

echo ""
echo "=== Done ==="
