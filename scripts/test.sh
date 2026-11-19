#!/usr/bin/env bash
# Whole test suite, run by `./node-ctl test`.
set -euo pipefail
cd "$(dirname "$0")/.."

shellcheck -e SC2016 node-ctl scripts/*.sh tests/stubs/* # SC2016: jq filters legitimately use $var in single quotes
bats tests
terraform -chdir=terraform fmt -check -recursive -diff
terraform -chdir=terraform init -backend=false -input=false >/dev/null
terraform -chdir=terraform validate
terraform -chdir=terraform test
terraform -chdir=terraform/contabo init -backend=false -input=false >/dev/null
terraform -chdir=terraform/contabo validate
terraform -chdir=terraform/contabo test
