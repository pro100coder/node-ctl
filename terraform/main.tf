locals {
  servers_dir = var.servers_dir != "" ? var.servers_dir : "${path.module}/../servers"
  inventory = { for f in fileset(local.servers_dir, "*.json") :
    trimsuffix(f, ".json") => jsondecode(file("${local.servers_dir}/${f}"))
  }
  # One workspace per Hetzner account (ADR-0017): this apply only knows the machines of its own.
  servers = { for k, v in local.inventory : k => v if v.account == var.account }
  running = { for k, v in local.servers : k => v if v.state == "running" }
  # A volume is opt-in (volume_size > 0): an extra disk at /mnt/volume that outlives the VPS until
  # the machine is archived; /data itself is on the root disk (ADR-0016).
  with_volume = { for k, v in local.servers : k => v if v.state != "archived" && try(v.volume_size, 0) > 0 }
  attached    = { for k, v in local.running : k => v if try(v.volume_size, 0) > 0 }

  any = ["0.0.0.0/0", "::/0"]
}

# The cloud-config is the same on every provider, so both roots render it from one module.
module "cloud_init" {
  source         = "./modules/cloud-init"
  ssh_public_key = var.ssh_public_key
  machines = { for k, v in local.running : k => {
    tailscale_key = tailscale_tailnet_key.dev[k].key
    volume        = contains(keys(local.attached), k)
  } }
}

resource "hcloud_ssh_key" "me" {
  name       = "agent-remote-environment"
  public_key = var.ssh_public_key
}

# --- dev machines: VPS follows state == running, a volume (if any) survives until archived -----

resource "hcloud_volume" "data" {
  for_each = local.with_volume
  name     = each.key
  size     = each.value.volume_size
  location = each.value.location
  format   = "ext4"
}

resource "hcloud_firewall" "dev" {
  for_each = local.running
  name     = each.key
  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = local.any
  }
  dynamic "rule" {
    for_each = toset([for p in concat([22], each.value.open_ports) : tostring(p)])
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = rule.value
      source_ips = local.any
    }
  }
}

resource "tailscale_tailnet_key" "dev" {
  for_each      = local.running
  preauthorized = true
  reusable      = false
  ephemeral     = false
  tags          = ["tag:dev"] # the tag tailscale-rm.sh deletes by and check.sh mints a key for
  expiry        = 86400
}

resource "hcloud_server" "dev" {
  for_each    = local.running
  name        = each.key
  server_type = each.value.type
  # Whether the disk follows the type: a grown disk never shrinks again, so ./node-ctl resize asks and
  # writes the answer here; by default the disk stays, and a smaller type stays possible.
  keep_disk = try(each.value.keep_disk, true)
  # The snapshot ./node-ctl stop keeps of the root disk, once there is one: a started machine is the
  # machine that was stopped, not a fresh install. Only read at create time (ignore_changes below),
  # so the next stop replacing it is not a rebuild.
  image        = try(tostring(each.value.image), var.image)
  location     = each.value.location
  ssh_keys     = [hcloud_ssh_key.me.id]
  firewall_ids = [hcloud_firewall.dev[each.key].id]
  user_data    = module.cloud_init.user_data[each.key]

  # Both addresses are auto-created with the server and go with it: a stopped machine holds no
  # address and pays for none. GitHub has no AAAA record, so IPv4 is not optional (ADR-0013).
  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  lifecycle {
    ignore_changes = [user_data, ssh_keys, image]
  }
}

resource "hcloud_volume_attachment" "data" {
  for_each  = local.attached
  volume_id = hcloud_volume.data[each.key].id
  server_id = hcloud_server.dev[each.key].id
  automount = false # mount-volume.sh mounts it at /mnt/volume
}
