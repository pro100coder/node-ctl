terraform {
  required_version = ">= 1.7"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.50"
    }
    tailscale = {
      source  = "tailscale/tailscale"
      version = "~> 0.17"
    }
  }
}

# HCLOUD_TOKEN (the account of this workspace), TAILSCALE_OAUTH_CLIENT_ID and TAILSCALE_OAUTH_CLIENT_SECRET
# are exported by ./node-ctl from node-ctl.yaml
provider "hcloud" {}
provider "tailscale" {
  tailnet = "-"
}
