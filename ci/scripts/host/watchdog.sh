#!/usr/bin/env bash
# Host watchdog: keeps the public sites up when the active host dies, without anyone at a keyboard.
# Installed on every host by `node ci/scripts/host/watchdog.mjs install` as /opt/services/bin/host-watchdog,
# run every minute by host-watchdog.timer (root). Config: /opt/services/host-state/watchdog.env (see watchdog.mjs).
#
# Standby host (no tunnel here):
#   The public sites answer with Cloudflare's "no origin" errors (502/503/530: no tunnel connected) for
#   TAKEOVER_AFTER checks in a row, AND the active peer is unreachable or its tunnel isn't running
#   → start the tunnel and crons here (same as promote.mjs), mark this host active, email.
#   A standby whose own internet is down sees curl failures, not Cloudflare errors, and does nothing.
# Active host (tunnel here):
#   Another host ALSO runs the tunnel (the dead host came back with its tunnel), for YIELD_AFTER checks in a
#   row → the host that became active earlier stops its tunnel and parks its crons, and emails.
#   The sites are down while this host's tunnel runs (Traefik or an app is broken) → email once.
# Testing: WATCHDOG_DRY=1 logs what it would do instead of doing it (and doesn't email);
# WATCHDOG_PUBLIC=up|noorigin|down|unknown pretends the public checks said that; WATCHDOG_PEERS_STATE="name tunnel
# <active-since>" pretends a peer answered that; --test-mail sends a test email.
# A promote pauses every watchdog (watchdog.pause-until) so a planned handover isn't mistaken for an outage.
set -uo pipefail

STATE=/opt/services/host-state
CONF=$STATE/watchdog.env
TUNNEL_DIR=/opt/services/infra/cloudflared
TUNNEL_ENV=/opt/services/data/app-env/cloudflared.env
MAIL_ENV=/opt/services/data/app-env/site-mail.env
TAKEOVER_AFTER=3
YIELD_AFTER=5
ALERT_AFTER=5

[ -f "$CONF" ] || { echo "no $CONF"; exit 0; }
# shellcheck disable=SC1090
. "$CONF"   # HOST_NAME, PEERS ("name=user@addr ..."), CHECKS ("url ..."), ALERT_TO
mkdir -p "$STATE/watchdog"
W=$STATE/watchdog
now=$(date +%s)
DRY=${WATCHDOG_DRY:-}
[ -n "$DRY" ] && W=$(mktemp -d)   # a dry run leaves no counters or markers behind
log() { echo "$(date -Is) ${DRY:+[dry] }$*" | tee -a "$W/log"; }

[ -f "$STATE/watchdog.disabled" ] && [ -z "$DRY" ] && [ "${1:-}" != --test-mail ] && exit 0
if [ -z "$DRY" ] && [ -f "$STATE/watchdog.pause-until" ] && [ "$now" -lt "$(cat "$STATE/watchdog.pause-until" 2>/dev/null || echo 0)" ]; then
  rm -f "$W"/count-*; exit 0
fi

count() { [ -n "$DRY" ] && { echo 99; return; }; local f="$W/count-$1"; local n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$f"; echo "$n"; }
reset() { rm -f "$W/count-$1"; }
tunnel_running() { [ "$(docker inspect -f '{{.State.Running}}' cloudflared 2>/dev/null)" = true ]; }
active_since() { cat "$STATE/active-since" 2>/dev/null || echo 0; }

mail() {  # subject, body. Through this host's own site-mail, so it works whichever host is alive.
  [ -n "$DRY" ] && { log "would email: $1"; return; }
  local key; key=$(grep -m1 '^SITE_MAIL_API_KEY=' "$MAIL_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"'"'")
  [ -n "$key" ] && [ -n "${ALERT_TO:-}" ] || { log "can't email: no site-mail key or ALERT_TO"; return; }
  jq -n --arg to "$ALERT_TO" --arg s "[hosts] $1" --arg t "$2" '{site:"billing",to:$to,subject:$s,text:$t,priority:"high"}' |
    curl -s -m 20 -o /dev/null -w '%{http_code}' -H 'Host: site-mail.joed.dev' -H "Authorization: Bearer $key" \
      -H 'Content-Type: application/json' --data @- http://127.0.0.1/v1/send | grep -q 200 || log "email failed: $1"
}

# Public state: up (every check 200), noorigin (Cloudflare can't reach a tunnel), or unknown (our own network).
public_state() {
  local up=1 noorigin=0 url code
  for url in $CHECKS; do
    code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$url" || true)
    [ "$code" = 200 ] && continue
    up=0
    case "$code" in 502|503|530) noorigin=1 ;; 000) echo unknown; return ;; esac
  done
  [ $up = 1 ] && echo up || { [ $noorigin = 1 ] && echo noorigin || echo down; }
}

# For each peer: "name tunnel|notunnel|unreachable active-since"
peers_state() {
  [ -n "${WATCHDOG_PEERS_STATE:-}" ] && { printf '%s
' "$WATCHDOG_PEERS_STATE"; return; }   # tests: "name tunnel 123"
  local p name target out
  for p in $PEERS; do
    name=${p%%=*}; target=${p#*=}
    out=$(timeout 25 ssh -n -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$target" \
      "if [ \"\$(sudo -n docker inspect -f '{{.State.Running}}' cloudflared 2>/dev/null)\" = true ]; then echo tunnel; else echo notunnel; fi; cat $STATE/active-since 2>/dev/null || echo 0" 2>/dev/null | tr '\n' ' ')
    echo "$name ${out:-unreachable 0}"
  done
}

start_tunnel() {
  [ -n "$DRY" ] && { log "would start the tunnel and crons"; return; }
  for f in "$STATE"/cron/wl-*; do [ -e "$f" ] && install -m 644 "$f" /etc/cron.d/; done
  (cd "$TUNNEL_DIR" && docker compose -p cloudflared -f compose.yml --env-file "$TUNNEL_ENV" up -d --quiet-pull >/dev/null 2>&1)
  echo "$now" > "$STATE/active-since"
}
stop_tunnel() {
  [ -n "$DRY" ] && { log "would stop the tunnel and park the crons"; return; }
  docker stop cloudflared-autoheal cloudflared >/dev/null 2>&1 || true
  mkdir -p "$STATE/cron"
  for f in /etc/cron.d/wl-*; do [ -e "$f" ] && mv "$f" "$STATE/cron/"; done
  rm -f "$STATE/active-since"
}

if [ "${1:-}" = --test-mail ]; then
  mail "test from $HOST_NAME" "The host watchdog on $HOST_NAME can email you. Nothing is wrong."; echo sent; exit 0
fi
public=${WATCHDOG_PUBLIC:-$(public_state)}

if tunnel_running; then
  # ---- active
  mine=$(active_since)
  newer=""
  while read -r name st since; do
    [ "$st" = tunnel ] || continue
    # The host that became active later keeps serving; ties go to the name that sorts first.
    if [ "${since:-0}" -gt "$mine" ] || { [ "${since:-0}" -eq "$mine" ] && [[ "$name" < "$HOST_NAME" ]]; }; then newer=$name; fi
  done < <(peers_state)
  if [ -n "$newer" ]; then
    n=$(count yield)
    log "$newer also runs the tunnel and became active later ($n/$YIELD_AFTER)"
    if [ "$n" -ge "$YIELD_AFTER" ]; then
      stop_tunnel; reset yield
      log "yielded to $newer"
      mail "$HOST_NAME handed the sites to $newer" "$HOST_NAME came back while $newer was serving the sites (it took over while $HOST_NAME was down). $HOST_NAME stopped its tunnel and crons and is now a standby.

Anything written on $HOST_NAME before it went down, since the last sync, is still only on $HOST_NAME. Compare:
  node ci/scripts/host/status.mjs --data
and copy what matters with data-copy.mjs (dry run first). To finish the move (deploy runners): promote.mjs $newer --yes"
    fi
  else
    reset yield
  fi
  if [ "$public" = up ]; then
    [ -f "$W/alerted-down" ] && { rm -f "$W/alerted-down"; mail "sites are back up ($HOST_NAME)" "The public sites answer again from $HOST_NAME."; }
    reset down
  elif [ "$public" != unknown ]; then
    n=$(count down)
    log "sites $public while $HOST_NAME runs the tunnel ($n)"
    if [ "$n" -ge "$ALERT_AFTER" ] && [ ! -f "$W/alerted-down" ]; then
      touch "$W/alerted-down"
      mail "sites DOWN while $HOST_NAME runs the tunnel" "The public sites ($CHECKS) have failed for $n minutes, but $HOST_NAME (the active host) runs the tunnel, so failing over wouldn't help: Traefik, an app, or the tunnel connection is broken. Start with node ci/scripts/host/status.mjs and docker logs cloudflared on $HOST_NAME."
    fi
  fi
  exit 0
fi

# ---- standby
reset yield
if [ "$public" != noorigin ]; then reset takeover; exit 0; fi
n=$(count takeover)
log "sites have no origin ($n/$TAKEOVER_AFTER)"
[ "$n" -ge "$TAKEOVER_AFTER" ] || exit 0

why=""
while read -r name st _; do
  case "$st" in
    tunnel) log "$name runs the tunnel; not taking over (Cloudflare or its connection is the problem)"; exit 0 ;;
    unreachable) why="$why $name is unreachable." ;;
    *) why="$why $name is reachable but its tunnel isn't running." ;;
  esac
done < <(peers_state)

start_tunnel
[ -n "$DRY" ] || for i in $(seq 1 45); do [ "$(docker inspect -f '{{.State.Health.Status}}' cloudflared 2>/dev/null)" = healthy ] && break; sleep 2; done
reset takeover
synced=$(cat "$STATE/last-sync" 2>/dev/null || echo "unknown")
log "took over:$why"
mail "$HOST_NAME TOOK OVER the sites" "The public sites were down (Cloudflare had no tunnel to send them to) for $TAKEOVER_AFTER checks in a row.$why
$HOST_NAME started its tunnel and crons and serves the sites now, with the data from its last sync (around $synced). Writes made on the old host since then are still there.

Deploy jobs still go to the old host's runners. To move them:  node ci/scripts/host/promote.mjs $HOST_NAME --yes
When the old host comes back, its watchdog sees two tunnels and hands over to $HOST_NAME on its own within a few minutes. Then compare data:  node ci/scripts/host/status.mjs --data"
