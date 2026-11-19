output "machines" {
  value = { for k, s in hcloud_server.dev : k => {
    ipv4 = s.ipv4_address
    ipv6 = s.ipv6_address
  } }
}
