#!/bin/bash
# Provisioning, run by cloud-init on every new VPS — including one booted from the root-disk
# snapshot ./node-ctl stop kept, so every step here is idempotent and skips what is already in place.
# Settings come from /etc/provision.env: TS_AUTHKEY, DATA_VOLUME (1 when a Hetzner Volume is attached)
set -euo pipefail
# shellcheck source=/dev/null
. /etc/provision.env
export DEBIAN_FRONTEND=noninteractive

wait_for() { # wait_for <seconds> <cmd...>
  local i
  for ((i = 0; i < $1; i += 5)); do
    "${@:2}" && return 0
    sleep 5
  done
  return 1
}

# /data is on the root disk, so the snapshot ./node-ctl stop takes holds everything (ADR-0016): the
# home moves there, and /etc/docker/daemon.json already points data-root at /data/docker. A machine
# booted from its snapshot has the home there already, and cloud-init wrote authorized_keys into it.
setup_data() {
  mkdir -p /data/docker
  if [ -d /home/node-ctl-user ] && [ ! -d /data/node-ctl-home ]; then mv /home/node-ctl-user /data/node-ctl-home; fi
  usermod -d /data/node-ctl-home node-ctl-user
  [ "${DATA_VOLUME:-}" != 1 ] || /usr/local/sbin/mount-volume # an extra disk at /mnt/volume, when the machine has one
}

# A machine started from the snapshot ./node-ctl stop took has all of this already, with whatever was
# installed or configured on top of it: re-running the installers would only undo the point of it.
install_docker() {
  if command -v docker >/dev/null; then return 0; fi
  apt-get update -q
  apt-get install -y -q docker.io docker-compose-v2 restic htop mc
  usermod -aG docker node-ctl-user
}

install_agents() { # codex wants Node 22+, newer than what Ubuntu ships
  if command -v codex >/dev/null; then return 0; fi
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs build-essential # node-pty (Orca, VS Code remote) ships no linux prebuild
  npm install -g @openai/codex
  # claude goes in as node-ctl-user: npm's global prefix is root-owned, so its auto-update cannot write there
  sudo -u node-ctl-user -H bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
  ln -sfn /data/node-ctl-home/.local/bin/claude /usr/local/bin/claude # ~/.local/bin: not in a non-interactive PATH
}

install_tailscale() { # Funnel is configured later by ./node-ctl expose over ssh: nothing to do at boot
  command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
  # Always: the node was logged out before the snapshot and the key below is a fresh single-use one.
  tailscale up --auth-key="$TS_AUTHKEY" --hostname="$(hostname)"
}

setup_data
install_docker
install_agents
install_tailscale
systemctl try-reload-or-restart ssh # sshd may have started before cloud-init wrote 00-node-ctl.conf
echo provisioned
