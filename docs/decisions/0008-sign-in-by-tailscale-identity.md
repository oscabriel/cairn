# Sign-in by Tailscale identity

Cairn admits requests by Tailscale user login, not by arrival over Tailscale, because friends' and family's devices share the tailnet. Caddy `forward_auth` passes `{remote_host}`, Cairn runs `tailscale whois` and admits `oscabriel@`, including requests from the Beelink itself (v1's device allowlist locked the Beelink out and spawned a root cutover). Every state-changing request and WebSocket upgrade must also carry Cairn's own Origin.
