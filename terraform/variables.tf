variable "ssh_public_key" {
  type        = string
  description = "Public key installed on every machine; ./node-ctl passes it as TF_VAR_ssh_public_key"
}

variable "account" {
  type        = string
  description = "The Hetzner account (a tag of node-ctl.yaml) this workspace manages: only machines whose inventory names it are read; ./node-ctl passes it as TF_VAR_account, with TF_WORKSPACE and that account's HCLOUD_TOKEN"
}

variable "servers_dir" {
  type        = string
  default     = ""
  description = "Directory with <name>.json inventory files; empty = ../servers"
}

variable "image" {
  type    = string
  default = "ubuntu-24.04"
}
