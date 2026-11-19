locals {
  servers_dir = var.servers_dir != "" ? var.servers_dir : "${path.module}/../../servers"
  inventory = { for f in fileset(local.servers_dir, "*.json") :
    trimsuffix(f, ".json") => jsondecode(file("${local.servers_dir}/${f}"))
  }
  # One workspace per account (ADR-0017): this apply only knows the machines of its own.
  servers = { for k, v in local.inventory : k => v if v.account == var.account }
  # A Contabo instance is a monthly contract, not a server that can be deleted and recreated for
  # free: it exists until the machine is archived or destroyed, and ./node-ctl stop only powers it
  # off through the API (ADR-0018). So `stopped` is still an instance here, unlike on Hetzner.
  machines = { for k, v in local.servers : k => v if v.state != "archived" }
}

# Contabo's equivalent of an uploaded ssh key: a secret of type "ssh", referenced by its id.
resource "contabo_secret" "me" {
  name  = "agent-remote-environment"
  type  = "ssh"
  value = var.ssh_public_key
}

resource "tailscale_tailnet_key" "dev" {
  for_each      = local.machines
  preauthorized = true
  reusable      = false
  ephemeral     = false
  tags          = ["tag:dev"] # the tag tailscale-rm.sh deletes by and check.sh mints a key for
  expiry        = 86400
}

module "cloud_init" {
  source         = "../modules/cloud-init"
  ssh_public_key = var.ssh_public_key
  machines = { for k, v in local.machines : k => {
    tailscale_key = tailscale_tailnet_key.dev[k].key
    volume        = false # Contabo has no attachable block storage (ADR-0001, ADR-0018)
  } }
}

resource "contabo_instance" "dev" {
  for_each     = local.machines
  display_name = each.key # the OS hostname comes from cloud-init; this is what the API is searched by
  product_id   = each.value.type
  region       = each.value.location
  # The standard image ./node-ctl create looked up (a UUID, unlike Hetzner's names); changing it
  # reinstalls the machine, which is why it is read at create time only, like user_data.
  image_id  = try(each.value.image, null)
  ssh_keys  = [tonumber(contabo_secret.me.id)]
  user_data = module.cloud_init.user_data[each.key]

  lifecycle {
    ignore_changes = [user_data, ssh_keys, image_id]
  }
}

# Contabo's firewall is a separate object attached to instances. It is free, but an add-on of the
# contract that a new instance only gets once it has finished provisioning; until then attaching it
# fails with 402, so ./node-ctl apply creates a new instance first and this after a wait
# (contabo_instances_first). Rules are an allow-list; 22 is always in it, the rest is open_ports.
resource "contabo_firewall" "dev" {
  for_each     = local.machines
  name         = each.key
  status       = "active"
  instance_ids = [tonumber(contabo_instance.dev[each.key].id)]

  rules {
    inbound {
      protocol   = "tcp"
      action     = "accept"
      status     = "active"
      dest_ports = toset([for p in concat([22], each.value.open_ports) : tostring(p)])
      src_cidr {
        ipv4 = ["0.0.0.0/0"]
        ipv6 = ["::/0"]
      }
    }
  }
}
