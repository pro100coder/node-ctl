#!/usr/bin/env bash
# Runs on a machine, piped over ssh by ./node-ctl load: bash -s -- <once|plain|tty> <color|mono> <block|row>.
# Every argument always carries a word: ssh re-splits the command line there, where an empty one disappears.
set -euo pipefail
mode=$1 layout=$3
G='' R='' N=''
[ "$2" != color ] || { G='\033[32m' R='\033[31m' N='\033[0m'; }
cores=$(nproc)
dev=$(findmnt -no SOURCE /); dev=${dev##*/}
grep -q " $dev " /proc/diskstats || dev=$(printf '%s' "$dev" | sed -E 's/p?[0-9]+$//') # a partition may not keep its own stats
busy_ms() { awk -v d="$dev" '$3 == d { t = $13 } END { print t + 0 }' /proc/diskstats; } # field 13: ms the disk was busy
up= # after the first block, redraw over it instead of scrolling
while :; do
  read -r l1 l5 l15 _ < /proc/loadavg
  b0=$(busy_ms)
  idle=$(vmstat 1 2 | awk 'END {print $15}') # the second sample is a real one-second delta
  busy=$(( ($(busy_ms) - b0) / 10 )); [ "$busy" -le 100 ] || busy=100 # ms busy in that same second
  df=$(df -m / | awk 'NR == 2 {print $2, $3}') # /data and docker live on the root disk
  printf '%s' "$up"
  free -m | awk -v cores="$cores" -v cpu="$((100 - idle))" -v l1="$l1" -v l5="$l5" -v l15="$l15" \
                -v busy="$busy" -v dtotal="${df% *}" -v dused="${df#* }" -v layout="$layout" \
                -v G="$G" -v R="$R" -v N="$N" '
    function rep(ch, n,   i, s) { for (i = 0; i < n; i++) s = s ch; return s }
    function bar(pct, w,   n, green) { n = int(pct * w / 100 + 0.5); if (n > w) n = w; if (n < 0) n = 0
                                       green = int(w * 0.7); if (n < green) green = n # the last 30% of the bar is the red zone
                                       return G rep("|", green) R rep("|", n - green) N rep(" ", w - n) }
    /^Mem:/ { ram = 100 * $3 / $2; root = 100 * dused / dtotal
              if (layout == "row") { # one line per machine; node-ctl prints the header that names these columns
                printf "[%s] %3d%%  [%s] %3d%%  [%s] %5.2f  [%s] %3d%%  [%s] %3d%%  %5.1fG\n", bar(cpu, 8), cpu,
                       bar(ram, 8), ram, bar(100 * l1 / cores, 8), l1, bar(busy, 8), busy, bar(root, 8), root,
                       (dtotal - dused) / 1024
                next }
              printf "cpu  [%s] %3d%%  %d cores\n", bar(cpu, 20), cpu, cores
              printf "ram  [%s] %3d%%  %d/%d MiB\n", bar(ram, 20), ram, $3, $2
              printf "load [%s] %5.2f  5m %.2f  15m %.2f\n", bar(100 * l1 / cores, 20), l1, l5, l15
              printf "disk [%s] %3d%%  busy\n", bar(busy, 20), busy
              printf "root [%s] %3d%%  %.1f/%.1f GiB  %.1f free\n", bar(root, 20),
                     root, dused / 1024, dtotal / 1024, (dtotal - dused) / 1024 }'
  [ "$mode" != once ] || break
  [ "$mode" != tty ] || up=$'\033[5A'
done
