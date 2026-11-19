#!/usr/bin/env bats
# .github/release-version.sh: the version the release job tags, from the tags that already exist.

version() { printf '%s' "${tags:-}" | "$BATS_TEST_DIRNAME/../.github/release-version.sh" "$@"; }

@test "the first release of a day is NUM 1, the next ones count up from that day's tags only" {
  tags='' run version 261119
  [ "$output" = v0.261119.1 ]
  tags=$'v0.261118.1\nv0.261118.2\nv0.261119.1\n' run version 261119
  [ "$output" = v0.261119.2 ]
  tags=$'v0.261119.2\nv0.261119.1\nv0.261118.7\nv0.261119.0-pre.40\nv0.2611190.1' run version 261119 # no newline at the end
  [ "$status" -eq 0 ]
  [ "$output" = v0.261119.3 ]
}

@test "a number taken above a gap is never handed out again" {
  tags=$'v0.261119.1\nv0.261119.3\n' run version 261119
  [ "$output" = v0.261119.4 ]
}

@test "a pre-release takes no NUM and sorts below that day's releases and above the day before's" {
  tags=$'v0.261119.1\nv0.261119.2\n' run version 261119 42
  [ "$status" -eq 0 ]
  [ "$output" = v0.261119.0-pre.42 ]
  tags=$'v0.261119.1\nv0.261119.2\n' run version 261119 # the next release is unaffected
  [ "$output" = v0.261119.3 ]
  run bun -e 'const o = Bun.semver.order; console.log(o("0.261119.0-pre.42", "0.261119.1"), o("0.261119.0-pre.42", "0.261118.9"), o("0.261119.0-pre.9", "0.261119.0-pre.10"))'
  [ "$output" = "-1 1 -1" ]
}

@test "a malformed date or run number is refused" {
  for d in '' 2611190 26111 2026-11-19; do
    run version "$d"
    [ "$status" -eq 2 ]
  done
  run version 261119 abc
  [ "$status" -eq 2 ]
  [[ $output == *"not a run number"* ]] || false
}
