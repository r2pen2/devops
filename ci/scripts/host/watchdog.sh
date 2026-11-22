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
# <active-since>" pretends a peer answered that; WATCHDOG_OWNER=up|down and WATCHDOG_SITE=up|down pretend a pinned
# app's owner answered (or not) and its site was up (or down); WATCHDOG_NO_MAIL=1 acts but doesn't email;
# --test-mail sends a test email.
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
  if [ -n "$DRY" ] || [ -n "${WATCHDOG_NO_MAIL:-}" ]; then log "would email: $1"; return; fi
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

# ---- pinned apps (hosts.json `pinned`, written to pinned.tsv by placement.mjs --apply), on every host.
# A pinned app runs only on its owner. When the owner is gone (its Traefik doesn't answer over Tailscale) AND
# its site is down publicly, for PIN_AFTER checks in a row, start the app here and serve its site from here.
# Once the owner answers again for HANDBACK_AFTER checks, stop it here and put the planned routes back. While the
# owner is fine, copy its `refresh` folders here every REFRESH_HOURS, so a takeover starts from recent config.
PIN_AFTER=3
HANDBACK_AFTER=5
REFRESH_HOURS=6
PINNED_TSV=${WATCHDOG_PINNED_TSV:-$STATE/pinned.tsv}   # tests: a list with just one site
PLACEMENT=/opt/services/infra/traefik/dynamic/placement.yml

peer_target() { local p; for p in $PEERS; do [ "${p%%=*}" = "$1" ] && echo "${p#*=}"; done; }
pin_slug() { echo "$1" | tr -c 'a-zA-Z0-9\n' '-' | tr 'A-Z' 'a-z'; }
owner_answers() {  # the owner's Traefik, over Tailscale: placement.mjs's served-by route answers 418
  [ -n "${WATCHDOG_OWNER:-}" ] && { [ "$WATCHDOG_OWNER" = up ]; return; }
  [ "$(curl -s -o /dev/null -m 6 -w '%{http_code}' -H 'Host: wl-watchdog.invalid' "http://$1/.well-known/wl-served-by" || true)" = 418 ]
}
site_down() {  # publicly: Cloudflare or the active host's Traefik has nothing healthy (5xx). 000 = our own network.
  [ -n "${WATCHDOG_SITE:-}" ] && { [ "$WATCHDOG_SITE" = down ]; return; }
  case "$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$1/" || true)" in 5??) return 0 ;; *) return 1 ;; esac
}
pinned_compose() {  # site, compose verb...: run it for every project of the site, as placement.mjs recorded them
  local site=$1; shift
  awk -F'\t' -v s="$site" '$1 == s { print $5 "\t" $6 }' "$PINNED_TSV" | while IFS=$'\t' read -r dir args; do
    # shellcheck disable=SC2086
    (cd "$dir" && docker compose $args "$@" >/dev/null 2>&1) || log "docker compose $* failed in $dir"
  done
}
serve_pinned_here() {  # drop the route that sends the site to its owner; this host's own route takes it
  local router="place-$(pin_slug "$1")" tmp
  tmp=$(mktemp)
  { echo "# Taken over by host-watchdog on $(date -Is): $1 is served here while its host is down."
    grep -v '^#' "$PLACEMENT" | jq --arg r "$router" 'del(.http.routers[$r])'; } > "$tmp" && install -m 644 "$tmp" "$PLACEMENT"
  rm -f "$tmp"
}

# From the owner: each project's compose folder and `refresh` folders (no databases or logs), and any image that
# changed there (streamed: private images may not pull here), then re-create the stopped containers to match.
refresh_pinned() {
  local site=$1 owner=$2 target=$3 dir args extra d img mine theirs
  while IFS=$'\t' read -r dir args extra; do
    for d in "${dir#/opt/services/}" ${extra//,/ }; do
      mkdir -p "/opt/services/$d"
      timeout 600 rsync -a --delete --exclude='*.db' --exclude='*.db-*' --exclude='*.log' --exclude='*.log.*' \
        -e "ssh -o BatchMode=yes -o ConnectTimeout=8" --rsync-path="sudo rsync" "$target:/opt/services/$d/" "/opt/services/$d/" >/dev/null 2>&1 \
        || log "couldn't refresh $d from $owner"
    done
    # shellcheck disable=SC2086
    for img in $(cd "$dir" && docker compose $args config --images 2>/dev/null); do
      mine=$(docker image inspect -f '{{.Id}}' "$img" 2>/dev/null)
      theirs=$(timeout 30 ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$target" "sudo docker image inspect -f '{{.Id}}' '$img'" 2>/dev/null)
      [ -n "$theirs" ] && [ "$theirs" != "$mine" ] || continue
      # Public images: pull (anonymously: root's GHCR login is an expired CI token). Private ones: stream.
      d=$(mktemp -d)
      if DOCKER_CONFIG=$d timeout 900 docker pull -q "$img" >/dev/null 2>&1; then rm -rf "$d"; continue; fi
      rm -rf "$d"
      timeout 800 ssh -o BatchMode=yes -o ConnectTimeout=8 "$target" "sudo docker save '$img'" </dev/null | docker load -q >/dev/null 2>&1 \
        && log "refreshed image $img from $owner" || log "couldn't copy image $img from $owner"
    done
    # shellcheck disable=SC2086
    (cd "$dir" && docker compose $args create >/dev/null 2>&1) || log "couldn't re-create $dir"
  done < <(awk -F'\t' -v s="$site" '$1 == s { print $5 "\t" $6 "\t" $7 }' "$PINNED_TSV")
}

pinned_apps() {
  [ -s "$PINNED_TSV" ] || return 0
  local site owner ip projects marker n target last dirs d since fresh
  while IFS=$'\t' read -r site owner ip; do
    [ "$owner" = "$HOST_NAME" ] && continue
    projects=$(awk -F'\t' -v s="$site" '$1 == s { printf "%s ", $4 }' "$PINNED_TSV")
    marker="$W/pinned-$(pin_slug "$site")"
    if [ -f "$marker" ]; then
      # Serving it here. Hand it back once the owner is steadily back.
      if [ -n "$ip" ] && owner_answers "$ip"; then
        n=$(count "handback-$site")
        log "$owner answers again; $site handback ($n/$HANDBACK_AFTER)"
        if [ "$n" -ge "$HANDBACK_AFTER" ]; then
          since=$(cat "$marker" 2>/dev/null || echo "the takeover")
          if [ -n "$DRY" ]; then log "would stop $projects and route $site back to $owner"; else
            pinned_compose "$site" stop
            [ -f "$STATE/placement.planned.yml" ] && install -m 644 "$STATE/placement.planned.yml" "$PLACEMENT"
            rm -f "$marker"
          fi
          reset "handback-$site"
          log "handed $site back to $owner"
          mail "$site is back on $owner" "$owner answers again, so $HOST_NAME stopped its copy of $projects and sends $site to $owner again.

Anything $site saved while $HOST_NAME ran it (since $since) stayed on $HOST_NAME and isn't on $owner (for Home Assistant: history and recorder data; config changes you made there)."
        fi
      else
        reset "handback-$site"
      fi
      continue
    fi
    if [ -n "$ip" ] && owner_answers "$ip"; then
      reset "pin-$site"
      # Keep this host's (stopped) copy current: CI deploys pinned apps to their owner only.
      last=$(stat -c %Y "$W/refreshed-$(pin_slug "$site")" 2>/dev/null || echo 0)
      target=$(peer_target "$owner")
      if [ -n "$target" ] && [ $(( now - last )) -ge $(( REFRESH_HOURS * 3600 )) ] && [ -z "$DRY" ]; then
        refresh_pinned "$site" "$owner" "$target"
        touch "$W/refreshed-$(pin_slug "$site")"
      fi
      continue
    fi
    # The owner doesn't answer. Only act if the site is really down for everyone (not just our view of the owner).
    if ! site_down "$site"; then reset "pin-$site"; continue; fi
    n=$(count "pin-$site")
    log "$owner doesn't answer and $site is down ($n/$PIN_AFTER)"
    [ "$n" -ge "$PIN_AFTER" ] || continue
    if [ -n "$DRY" ]; then log "would start $projects and serve $site here"; else
      pinned_compose "$site" up -d
      serve_pinned_here "$site"
      date -Is > "$marker"
    fi
    reset "pin-$site"
    log "took over $site ($projects) from $owner"
    fresh=$(stat -c %y "$W/refreshed-$(pin_slug "$site")" 2>/dev/null | cut -c1-16)
    mail "$HOST_NAME TOOK OVER $site" "$site was down and $owner (its host) doesn't answer over Tailscale, so $HOST_NAME started its copy of $projects and serves $site now.

Its config is from ${fresh:-the last sync ($(cat "$STATE/last-sync" 2>/dev/null || echo unknown))}; databases (Home Assistant's history) start fresh here.
When $owner is back, $HOST_NAME hands $site back on its own within a few minutes."
  done < <(cut -f1-3 "$PINNED_TSV" | sort -u)
}
pinned_apps
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
