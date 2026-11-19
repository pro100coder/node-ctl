# Inventory -> resources, with providers mocked (no API calls).

# Contabo ids are numeric strings the configuration feeds back as numbers; mocks must not hand out letters
mock_provider "contabo" {
  mock_resource "contabo_instance" { defaults = { id = "2" } }
  mock_resource "contabo_secret" { defaults = { id = "3" } }
  mock_resource "contabo_firewall" { defaults = { id = "4" } }
}
mock_provider "tailscale" {}

variables {
  ssh_public_key = "ssh-ed25519 AAAA test"
  account        = "cb"
  servers_dir    = "tests/fixtures/servers"
}

run "state_drives_resources" {
  assert {
    condition     = keys(contabo_instance.dev) == ["running", "stopped"]
    error_message = "an instance is a monthly contract: it exists until the machine is archived, and a stopped machine still has one (./node-ctl stop only powers it off); elsewhere belongs to another account and is invisible here"
  }
  assert {
    condition     = keys(contabo_firewall.dev) == ["running", "stopped"] && keys(tailscale_tailnet_key.dev) == ["running", "stopped"]
    error_message = "firewall and tailscale key follow the instance"
  }
  assert {
    condition     = tailscale_tailnet_key.dev["running"].tags == toset(["tag:dev"])
    error_message = "a machine joins as tag:dev: tailscale-rm.sh deletes only nodes with that tag, check.sh mints a key for it"
  }
}

run "dev_machine_shape" {
  assert {
    condition     = contabo_instance.dev["running"].display_name == "running" && contabo_instance.dev["running"].product_id == "V45" && contabo_instance.dev["running"].region == "EU"
    error_message = "the inventory names the instance, its product and its region"
  }
  assert {
    condition     = contabo_instance.dev["running"].image_id == "0e42a3a3-1111-2222-3333-444455556666"
    error_message = "the machine is created from the standard image ./node-ctl create looked up"
  }
  assert {
    condition     = join(",", sort(tolist(one(contabo_firewall.dev["running"].rules).inbound[0].dest_ports))) == "22,8080"
    error_message = "the firewall opens 22 plus open_ports, and nothing else"
  }
  assert {
    condition     = one(one(contabo_firewall.dev["running"].rules).inbound[0].src_cidr).ipv4 == toset(["0.0.0.0/0"]) && contabo_firewall.dev["running"].status == "active"
    error_message = "an active firewall that lets those ports in from anywhere"
  }
  assert {
    condition     = startswith(contabo_instance.dev["running"].user_data, "#cloud-config\n") && strcontains(contabo_instance.dev["running"].user_data, "\"name\": \"node-ctl-user\"") && strcontains(contabo_instance.dev["running"].user_data, "PermitRootLogin no") && strcontains(contabo_instance.dev["running"].user_data, "/data/docker")
    error_message = "the same machine as on Hetzner: node-ctl-user, no root login, docker data-root under /data"
  }
  assert {
    condition     = strcontains(contabo_instance.dev["running"].user_data, "TS_AUTHKEY=") && !strcontains(contabo_instance.dev["running"].user_data, "DATA_VOLUME=1\n")
    error_message = "cloud-init hands provision.sh its tailnet key, and never a volume: Contabo has no block storage"
  }
}
