# Inventory -> resources, with providers mocked (no API calls).

# hcloud ids are numeric strings in real life; mocks must not hand out random letters
mock_provider "hcloud" {
  mock_resource "hcloud_server" { defaults = { id = "2" } }
  mock_resource "hcloud_volume" { defaults = { id = "3" } }
  mock_resource "hcloud_firewall" { defaults = { id = "4" } }
}
mock_provider "tailscale" {}

variables {
  ssh_public_key = "ssh-ed25519 AAAA test"
  account        = "main"
  servers_dir    = "tests/fixtures/servers"
}

run "state_drives_resources" {
  assert {
    condition     = keys(hcloud_server.dev) == ["plain", "running"]
    error_message = "only running machines of this workspace's account get a VPS: elsewhere belongs to another account and is invisible here"
  }
  assert {
    condition     = keys(hcloud_volume.data) == ["running", "stopped"]
    error_message = "a volume exists for the machines that asked for one (volume_size), until they are archived"
  }
  assert {
    condition     = keys(hcloud_volume_attachment.data) == ["running"]
    error_message = "the attachment follows the VPS of a machine with a volume"
  }
  assert {
    condition     = keys(hcloud_firewall.dev) == ["plain", "running"] && keys(tailscale_tailnet_key.dev) == ["plain", "running"]
    error_message = "firewall and tailscale key follow the VPS"
  }
  assert {
    condition     = tailscale_tailnet_key.dev["running"].tags == toset(["tag:dev"])
    error_message = "a machine joins as tag:dev: tailscale-rm.sh deletes only nodes with that tag, check.sh mints a key for it"
  }
}

run "dev_machine_shape" {
  assert {
    condition     = one(hcloud_server.dev["running"].public_net).ipv4_enabled == true && one(hcloud_server.dev["running"].public_net).ipv6_enabled == true
    error_message = "every machine gets its own public IPv4 and IPv6: there is no gateway to route through"
  }
  assert {
    condition     = length(hcloud_server.dev["running"].network) == 0
    error_message = "no private network: nothing is left that would need one"
  }
  assert {
    condition     = join(",", sort([for r in hcloud_firewall.dev["running"].rule : r.port if r.protocol == "tcp"])) == "22,8080"
    error_message = "firewall opens 22 plus open_ports"
  }
  assert {
    condition     = hcloud_server.dev["running"].image == "ubuntu-24.04"
    error_message = "a machine with no kept disk boots the base image"
  }
  assert {
    condition     = hcloud_server.dev["running"].keep_disk == true && hcloud_server.dev["plain"].keep_disk == false
    error_message = "the disk follows the server type only when the inventory says so (./node-ctl resize asked), else a smaller type stays possible"
  }
  assert {
    condition     = strcontains(hcloud_server.dev["running"].user_data, "DATA_VOLUME=1\n") && !strcontains(hcloud_server.dev["plain"].user_data, "DATA_VOLUME=1\n")
    error_message = "provision.sh mounts a volume only on a machine that has one (/etc/provision.env says DATA_VOLUME=1)"
  }
  assert {
    condition     = strcontains(hcloud_server.dev["running"].user_data, "/usr/local/sbin/mount-volume") && strcontains(hcloud_server.dev["running"].user_data, "/mnt/volume")
    error_message = "every machine ships mount-volume.sh, so a volume added later mounts at the next boot too"
  }
  assert {
    condition     = strcontains(hcloud_server.dev["running"].user_data, "TS_AUTHKEY=") && !strcontains(hcloud_server.dev["running"].user_data, "NAT_GW")
    error_message = "cloud-init hands provision.sh its tailnet key, and nothing about a NAT route"
  }
  assert {
    condition     = startswith(hcloud_server.dev["running"].user_data, "#cloud-config\n") && strcontains(hcloud_server.dev["running"].user_data, "/data/docker")
    error_message = "user_data is a cloud-config that puts docker's data-root under /data"
  }
  assert {
    condition     = strcontains(hcloud_server.dev["running"].user_data, "\"name\": \"node-ctl-user\"") && strcontains(hcloud_server.dev["running"].user_data, "NOPASSWD:ALL") && strcontains(hcloud_server.dev["running"].user_data, "\"ssh_pwauth\": false") && strcontains(hcloud_server.dev["running"].user_data, "PermitRootLogin no")
    error_message = "every machine gets node-ctl-user with passwordless sudo; sshd refuses root and passwords"
  }
}

# ./node-ctl stop snapshots the root disk and writes the image id into the inventory, so the next VPS is
# the machine that was stopped rather than a fresh install.
run "kept_disk_boots_the_machine_back" {
  variables {
    servers_dir = "tests/fixtures/snapshot"
  }
  assert {
    condition     = hcloud_server.dev["kept"].image == "4711"
    error_message = "a machine stopped with a root-disk snapshot boots from that image"
  }
}
