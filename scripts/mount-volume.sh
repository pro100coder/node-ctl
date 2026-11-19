#!/bin/bash
# Mounts the machine's Hetzner Volume at /mnt/volume. provision.sh runs it on every boot of a machine
# that has one (DATA_VOLUME=1), ./node-ctl volume pipes it over ssh when a running machine gets one.
# Idempotent: a machine booted from its own disk snapshot brought the fstab entry along.
set -euo pipefail
dev=''
for _ in $(seq 1 36); do # the volume is attached after the server boots, so it can take a while to appear
  dev=$(compgen -G "/dev/disk/by-id/scsi-0HC_Volume_*" | head -1) && break
  sleep 5
done
[ -n "$dev" ] || { echo "no volume attached" >&2; exit 1; }
blkid "$dev" >/dev/null || mkfs.ext4 -q "$dev" # Hetzner pre-formats it; a volume made elsewhere may be blank
grep -q ' /mnt/volume ' /etc/fstab || echo "$dev /mnt/volume ext4 discard,nofail,defaults 0 0" >> /etc/fstab
mkdir -p /mnt/volume
mountpoint -q /mnt/volume || mount /mnt/volume
chown node-ctl-user:node-ctl-user /mnt/volume
