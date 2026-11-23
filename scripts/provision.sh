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

# Neither provider's image has swap, and a build that outgrows RAM gets OOM-killed instead of slowing down.
# Low swappiness: swap only what is really idle, so an interactive shell is not paged out.
# A root disk without 2G left after the swapfile gets none: a full disk breaks more than no swap does.
setup_swap() {
  if [ ! -f /swapfile ]; then
    if [ "$(df --output=avail -k / | tail -1)" -lt $((6 * 1024 * 1024)) ]; then
      echo "setup_swap: under 6G free on /, no swapfile"
      return 0
    fi
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  swapon --show=NAME --noheadings | grep -qx /swapfile || swapon /swapfile
  echo vm.swappiness=10 >/etc/sysctl.d/99-swappiness.conf
  sysctl -q vm.swappiness=10
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

# Contabo merges its own cloud-config into ours, and it ships an hourly `echo 1 > drop_caches`: it frees
# nothing a process could not reclaim anyway and makes every hour start from a cold page cache.
drop_provider_cron() {
  rm -f /etc/cron.hourly/free
}

# A loaded machine must still answer ssh: it arrives through tailscaled, which shares system.slice with
# docker, so both get ten times the default CPU weight. The shell itself is in user.slice, already
# half the CPU against system.slice. set-property persists in /etc/systemd/system.control.
prioritize_ssh() {
  systemctl set-property tailscaled.service CPUWeight=1000
  systemctl set-property ssh.service CPUWeight=1000
}

setup_data
setup_swap # before the installers: npm and build-essential are the first to outgrow a small machine's RAM
drop_provider_cron
install_docker
install_agents
install_tailscale
prioritize_ssh # after install_tailscale: tailscaled.service exists only from there
systemctl try-reload-or-restart ssh # sshd may have started before cloud-init wrote 00-node-ctl.conf
echo provisioned
