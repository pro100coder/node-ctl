output "machines" {
  value = { for k, s in contabo_instance.dev : k => {
    ipv4 = try(s.ip_config[0].v4[0].ip, null)
    ipv6 = try(s.ip_config[0].v6[0].ip, null)
  } }
}
