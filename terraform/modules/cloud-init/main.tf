# The cloud-config every machine boots with, shared by the Hetzner and the Contabo root (ADR-0018):
# login, sshd stance, docker data-root and provision.sh are the same machine on both providers.

variable "ssh_public_key" {
  type        = string
  description = "Public key installed for node-ctl-user on every machine"
}

variable "machines" {
  type = map(object({
    tailscale_key = string
    volume        = bool # an extra disk to mount at /mnt/volume (Hetzner only)
  }))
  description = "The machines to render a cloud-config for, by name"
}

locals {
  provision    = file("${path.module}/../../../scripts/provision.sh")
  mount_volume = file("${path.module}/../../../scripts/mount-volume.sh")

  # Machines are used as node-ctl-user (passwordless sudo). sshd refuses root and passwords outright;
  # the drop-in sorts first so nothing an image ships in sshd_config.d can re-enable them.
  login = {
    ssh_pwauth = false
    users = [{
      name                = "node-ctl-user"
      shell               = "/bin/bash"
      sudo                = "ALL=(ALL) NOPASSWD:ALL"
      ssh_authorized_keys = [var.ssh_public_key]
    }]
  }
  sshd_conf = { path = "/etc/ssh/sshd_config.d/00-node-ctl.conf", content = "PermitRootLogin no\nPasswordAuthentication no\n" }
}

# yamlencode instead of templatefile: shell scripts go in verbatim, no $${} escaping.
output "user_data" {
  value = { for k, m in var.machines : k => join("\n", ["#cloud-config", yamlencode(merge(local.login, {
    hostname = k
    write_files = [
      local.sshd_conf,
      { path = "/etc/docker/daemon.json", content = jsonencode({ "data-root" = "/data/docker" }) },
      { path = "/etc/provision.env", content = "TS_AUTHKEY=${m.tailscale_key}\n${m.volume ? "DATA_VOLUME=1\n" : ""}" },
      { path = "/usr/local/sbin/provision", permissions = "0755", content = local.provision },
      { path = "/usr/local/sbin/mount-volume", permissions = "0755", content = local.mount_volume },
    ]
    runcmd = [["/usr/local/sbin/provision"]]
  }))]) }
}
