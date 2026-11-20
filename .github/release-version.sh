#!/usr/bin/env bash
# release-version.sh <yymmdd> [<run number>] < tags: the version of the next release (ADR-0023), from the
# existing tag names on stdin. A release is v0.YYMMDD.NUM, NUM one past that day's highest (1 for the first);
# with a run number it is the pre-release v0.YYMMDD.0-pre.<run>, which takes no NUM and in semver sorts below
# every release of that day and above those of the days before.
set -euo pipefail

day=${1:-}
case $day in
  [0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *) echo "usage: release-version.sh <yymmdd> [<run number>] < tags" >&2; exit 2 ;;
esac
if [ $# -gt 1 ]; then
  case $2 in
    '' | *[!0-9]*) echo "release-version.sh: not a run number: $2" >&2; exit 2 ;;
  esac
  # the tags are read all the same: the release step pipes them in under pipefail, and the producer of a
  # pipe nobody reads dies of SIGPIPE as soon as that day has one tag to send
  cat > /dev/null
  echo "v0.$day.0-pre.$2"
  exit 0
fi

# max + 1, not count + 1: a deleted tag in between must not hand out a number that is still taken
max=0
while IFS= read -r tag || [ -n "$tag" ]; do
  n=${tag#"v0.$day."}
  case $n in
    "$tag" | '' | *[!0-9]*) continue ;; # another day's tag, or a pre-release
  esac
  if [ "$((10#$n))" -gt "$max" ]; then max=$((10#$n)); fi
done
echo "v0.$day.$((max + 1))"
