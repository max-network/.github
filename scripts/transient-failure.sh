#!/usr/bin/env bash
set -euo pipefail

awk -F'\t' '
function transient(msg, err) {
  if (err && msg ~ /unexpected http response: 5[0-9][0-9]|does not indicate success: (5[0-9][0-9]|429)|returned error: 5[0-9][0-9]|bad gateway|service unavailable|gateway time-?out|econnreset|etimedout|eai_again|socket hang up|rate limit exceeded|received a shutdown signal|lost communication with the server|failed to download action/) return 1
  if (msg ~ /^npm (err!|error) (code )?(e5[0-9][0-9]|econnreset|etimedout|eai_again)/) return 1
  if (msg ~ /^err_pnpm_(meta_)?fetch_(5[0-9][0-9]|fail)/) return 1
  if (msg ~ /^error: get [^ ]+ - (5[0-9][0-9]|429)/) return 1
  return 0
}
NF >= 3 {
  job = $1
  msg = $3
  for (i = 4; i <= NF; i++) msg = msg "\t" $i
  sub(/^[0-9][0-9T:.-]*Z /, "", msg)
  sub(/^[ \t]+/, "", msg)
  lower = tolower(msg)
  err = sub(/^##\[error\]/, "", lower)
  if (!(job in seen)) { seen[job] = 1; order[++n] = job }
  if (!(job in hit) && transient(lower, err)) hit[job] = msg
}
END {
  if (n == 0) { print "no failed job logs"; exit 1 }
  real = 0
  for (i = 1; i <= n; i++) {
    j = order[i]
    if (j in hit) printf "transient\t%s\t%s\n", j, hit[j]
    else { printf "real\t%s\n", j; real = 1 }
  }
  exit real
}'
