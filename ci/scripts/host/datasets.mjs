/**
 * Measure, snapshot, copy and restore one dataset (hosts/datasets.json) on a host.
 *
 * Every copy runs ON the target host and pulls from the source over SSH, so it works from any controller.
 * Databases are copied logically inside their running containers (never by copying a live database's files).
 */
import { SERVICES, SNAPSHOTS, run, sshCmd } from "./lib.mjs";

const abs = (ds) => `${SERVICES}/${ds.path}`;

/** Shell that prints the names of running containers that bind-mount `dir` (or something inside it). */
const containersMounting = (dir) => `sudo docker ps -q | xargs -r sudo docker inspect -f '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' \\
  | awk -v p='${dir}' '{ for (i = 2; i <= NF; i++) if ($i == p || index($i, p "/") == 1) { sub("^/", "", $1); print $1; break } }'`;

const MONGO_COUNT = `let n = 0, t = 0;
db.adminCommand({ listDatabases: 1 }).databases
  .filter((d) => !["admin", "local", "config"].includes(d.name))
  .forEach((d) => { const x = db.getSiblingDB(d.name); x.getCollectionNames().forEach((c) => { n++; t += x.getCollection(c).countDocuments({}); }); });
print(n + " collections, " + t + " documents");`;

const PG_COUNT = `select count(*) || ' tables, ' || coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint), 0) || ' rows'
from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') and table_type = 'BASE TABLE';`;

/** Recreates the container's database empty, so a restore lands exactly the dump (and app connections drop). */
const PG_RECREATE = `sudo docker exec -i "$C" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -q -c "DROP DATABASE IF EXISTS \\"$POSTGRES_DB\\" WITH (FORCE)" -c "CREATE DATABASE \\"$POSTGRES_DB\\" OWNER \\"$POSTGRES_USER\\""'`;
const PG_RESTORE = `sudo docker exec -i "$C" sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error'`;
const PG_DUMP = `sudo docker exec "$C" sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"'`;
const MONGO_RESTORE = `sudo docker exec -i "$C" mongorestore --archive --drop --quiet --nsExclude 'admin.*' --nsExclude 'config.*'`;

/** One line describing the dataset on a host: counts, size, newest change. Empty string if it isn't there. */
export function measure(h, ds) {
  if (ds.type === "mongo") {
    return run(h, `C=${ds.container}
sudo docker inspect "$C" >/dev/null 2>&1 || { echo "(no container)"; exit 0; }
JS=$(cat <<'JS'
${MONGO_COUNT}
JS
)
sudo docker exec "$C" mongosh --quiet --eval "$JS"`, { quiet: true });
  }
  if (ds.type === "postgres") {
    return run(h, `C=${ds.container}
sudo docker inspect "$C" >/dev/null 2>&1 || { echo "(no container)"; exit 0; }
sudo docker exec -i "$C" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL'
${PG_COUNT}
SQL`, { quiet: true });
  }
  return run(h, `P='${abs(ds)}'
sudo test -d "$P" || { echo "(missing)"; exit 0; }
files=$(sudo find "$P" -type f | wc -l)
mb=$(( $(sudo du -sb "$P" | cut -f1) / 1048576 ))
newest=$(sudo find "$P" -type f -printf '%T@ %P\\n' | sort -n | tail -1)
[ -z "$newest" ] && { echo "$files files"; exit 0; }
when=$(date -u -d "@\${newest%% *}" '+%Y-%m-%d %H:%M UTC')
echo "$files files, \${mb} MB, newest $when (\${newest#* })"`, { quiet: true });
}

/** Saves the dataset as it is now on host h; returns the snapshot path (null if it doesn't exist there). Keeps 10. */
export function snapshot(h, ds, stamp) {
  const base = `${SNAPSHOTS}/${ds.name}-${stamp}`;
  const file = ds.type === "mongo" ? `${base}.archive.gz` : ds.type === "postgres" ? `${base}.dump` : `${base}.tgz`;
  const save =
    ds.type === "mongo" ? `sudo docker exec "$C" mongodump --archive --gzip --quiet | sudo tee "$F" >/dev/null`
    : ds.type === "postgres" ? `${PG_DUMP} | sudo tee "$F" >/dev/null`
    : `sudo tar -C '${abs(ds)}' -czf "$F" .`;
  const exists = ds.type === "files" ? `sudo test -d '${abs(ds)}'` : `sudo docker inspect "$C" >/dev/null 2>&1`;
  const out = run(h, `C='${ds.container || ""}'; F='${file}'
if ! ${exists}; then echo NONE; exit 0; fi
sudo mkdir -p '${SNAPSHOTS}'
${save}
sudo test -s "$F"
ls -1t '${SNAPSHOTS}/${ds.name}-'* 2>/dev/null | tail -n +11 | xargs -r sudo rm -f`);
  return out.includes("NONE") ? null : file;
}

/**
 * Overwrites the dataset on `to` with the one on `from`. Files: stops the containers that use the path on `to`
 * (and on `from` too when stopSource, for a consistent copy), mirrors it, starts them again.
 */
export function copy(from, to, ds, { stopSource = false } = {}) {
  const src = sshCmd(from);
  if (ds.type === "mongo") {
    run(to, `C=${ds.container}
${src} "sudo docker exec ${ds.container} mongodump --archive --quiet" | ${MONGO_RESTORE}`);
    return;
  }
  if (ds.type === "postgres") {
    run(to, `C=${ds.container}
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
${src} "sudo docker exec ${ds.container} sh -c 'pg_dump -U \\"\\$POSTGRES_USER\\" -Fc \\"\\$POSTGRES_DB\\"'" > "$TMP"
[ -s "$TMP" ] || { echo "empty dump from ${from.name}" >&2; exit 1; }
${PG_RECREATE}
${PG_RESTORE} < "$TMP"`);
    return;
  }
  const dir = abs(ds);
  const stopFrom = stopSource ? run(from, containersMounting(dir), { quiet: true }).split("\n").filter(Boolean) : [];
  if (stopFrom.length) run(from, `sudo docker stop ${stopFrom.join(" ")} >/dev/null`);
  try {
    run(to, `STOPPED=$(${containersMounting(dir)} | tr '\\n' ' ')
[ -n "$STOPPED" ] && sudo docker stop $STOPPED >/dev/null
sudo mkdir -p '${dir}'
sudo rsync -aH --numeric-ids --delete -e "sudo -u $(id -un) ${src.replace(/ \S+$/, "")}" --rsync-path="sudo rsync" '${from.user}@${from.tailscale || from.name}:${dir}/' '${dir}/'
[ -n "$STOPPED" ] && sudo docker start $STOPPED >/dev/null
true`);
  } finally {
    if (stopFrom.length) run(from, `sudo docker start ${stopFrom.join(" ")} >/dev/null`);
  }
}

/** Puts a snapshot back on host h (the undo for copy). */
export function restore(h, ds, file) {
  if (ds.type === "mongo") {
    run(h, `C=${ds.container}; F='${file}'
sudo cat "$F" | sudo docker exec -i "$C" mongorestore --archive --gzip --drop --quiet --nsExclude 'admin.*' --nsExclude 'config.*'`);
  } else if (ds.type === "postgres") {
    run(h, `C=${ds.container}; F='${file}'
${PG_RECREATE}
sudo cat "$F" | ${PG_RESTORE}`);
  } else {
    const dir = abs(ds);
    run(h, `F='${file}'
STOPPED=$(${containersMounting(dir)} | tr '\\n' ' ')
[ -n "$STOPPED" ] && sudo docker stop $STOPPED >/dev/null
sudo mkdir -p '${dir}'
sudo find '${dir}' -mindepth 1 -delete
sudo tar -C '${dir}' -xzf "$F"
[ -n "$STOPPED" ] && sudo docker start $STOPPED >/dev/null
true`);
  }
}

/** Snapshots of a dataset on a host, newest first. */
export function listSnapshots(h, ds) {
  return run(h, `ls -1t '${SNAPSHOTS}/${ds.name}-'* 2>/dev/null || true`, { quiet: true }).split("\n").filter(Boolean);
}
