#!/usr/bin/env bash
# Site probe: every minute on every host (host-site-probe.timer, installed by watchdog.mjs install), checks
# every public site from the outside and pushes the results to this host's Pushgateway, for Grafana's
# "WL-Universe Liveness" dashboard (r2pen2/observability). Each host keeps its own history, so whichever host
# serves Grafana shows a complete one.
#
# Sites: every hostname this host's Traefik routes (the plainest router per app), plus hosts.json `placement`.
# Per site: GET https://<site>/ (up = any answer below 500, status, seconds) and GET /.well-known/wl-served-by,
# whose X-Served-By header names the machine that answered (see placement.mjs).
#
# Metrics (job="site-probe", instance=<probing host>):
#   wl_site_up{site}  wl_site_http_status{site}  wl_site_response_seconds{site}
#   wl_site_served_by{site,host} 1   wl_site_served_by_index{site} (position in hosts.json, 0 = unknown)
#   wl_site_probe_timestamp_seconds
set -uo pipefail

CONF=/opt/services/host-state/watchdog.env
[ -f "$CONF" ] && . "$CONF"   # HOST_NAME, PLACED ("site ..."), HOST_INDEX ("name=1 ...")
HOST_NAME=${HOST_NAME:-$(hostname)}
PUSH=${SITE_PROBE_PUSH:-http://127.0.0.1:9091/metrics/job/site-probe/instance/$HOST_NAME}

ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' traefik 2>/dev/null | cut -d' ' -f1)
routed=""
if [ -n "$ip" ]; then
  # Per app: its shortest rule's first Host(`...`). Leaves out previews, dev copies and internal names.
  routed=$(curl -sf -m 10 "http://$ip:8080/api/http/routers?per_page=1000" | jq -r '
    [ .[] | select((.entryPoints // []) | index("web")) | select(.name | test("^(place-|wl-served-by|internal-api)") | not)
      | {service, rule} ] | group_by(.service) | .[] | min_by(.rule | length) | .rule
    | capture("Host\\(`(?<h>[^`]+)`\\)") | .h' 2>/dev/null |
    grep -E '\.' | grep -vE '(^qa-|-dev\.|\.invalid$|^sso-bounce)' || true)
fi
sites=$(printf '%s\n' $routed ${PLACED:-} | sort -u | grep -v '^$')
[ -n "$sites" ] || { echo "no sites to probe"; exit 0; }

probe() {
  local site=$1 out code secs sb
  out=$(curl -s -o /dev/null -m 15 -w '%{http_code} %{time_total}' "https://$site/" 2>/dev/null | tail -1)
  [ -n "$out" ] || out="000 0"
  code=${out% *}; secs=${out#* }
  sb=$(curl -s -m 10 -D - -o /dev/null "https://$site/.well-known/wl-served-by" 2>/dev/null | tr -d '\r' |
    awk -F': ' 'tolower($1)=="x-served-by"{print $2}' | head -1)
  printf '%s %s %s %s\n' "$site" "$code" "$secs" "${sb:-}"
}
export -f probe
results=$(printf '%s\n' $sites | xargs -P 8 -I{} bash -c 'probe "$@"' _ {})

# Each metric's lines must be together for Pushgateway: sort groups them by name.
{
  while read -r site code secs sb; do
    # Up: the site answered with anything below 500 (an API's 404 at / still means it's serving). Down: 5xx
    # (530 = no tunnel, 502 = app down) or no answer at all (000: timeout, DNS, or a network filter).
    case "$code" in [234]??) up=1 ;; *) up=0 ;; esac
    idx=0
    for pair in ${HOST_INDEX:-}; do [ "${pair%%=*}" = "$sb" ] && idx=${pair#*=}; done
    echo "wl_site_up{site=\"$site\"} $up"
    echo "wl_site_http_status{site=\"$site\"} $code"
    echo "wl_site_response_seconds{site=\"$site\"} $secs"
    echo "wl_site_served_by_index{site=\"$site\"} $idx"
    [ -n "$sb" ] && echo "wl_site_served_by{site=\"$site\",host=\"$sb\"} 1"
  done <<< "$results"
  echo "wl_site_probe_timestamp_seconds $(date +%s)"
} | LC_ALL=C sort | curl -s -m 10 -X PUT --data-binary @- "$PUSH" >/dev/null || echo "push to $PUSH failed"
