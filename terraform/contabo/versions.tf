terraform {
  required_version = ">= 1.7"
  required_providers {
    contabo = {
      source  = "contabo/contabo"
      version = "~> 0.1.44"
    }
    tailscale = {
      source  = "tailscale/tailscale"
      version = "~> 0.17"
    }
  }
}

# CNTB_OAUTH2_CLIENT_ID, CNTB_OAUTH2_CLIENT_SECRET, CNTB_OAUTH2_USER and CNTB_OAUTH2_PASS (the
# account of this workspace), TAILSCALE_OAUTH_CLIENT_ID and TAILSCALE_OAUTH_CLIENT_SECRET are
# exported by ./node-ctl from node-ctl.yaml. The Contabo provider asks for a token when it is
# configured, which is why this root is separate from the Hetzner one (ADR-0018).
provider "contabo" {}
provider "tailscale" {
  tailnet = "-"
}
