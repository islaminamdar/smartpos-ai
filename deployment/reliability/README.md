# POS gateway recovery

These files prevent the private Supabase gateway from remaining stopped after its
REST/auth dependencies restart. Install them on the POS host with root access:

```bash
install -D -m 0755 internext-pos-gateway-guard.sh /usr/local/libexec/internext-pos-gateway-guard
install -D -m 0644 internext-pos-gateway-guard.service /etc/systemd/system/internext-pos-gateway-guard.service
install -D -m 0644 internext-pos-gateway-guard.timer /etc/systemd/system/internext-pos-gateway-guard.timer
install -D -m 0644 container-internext-pos-gateway.service.d/dependency-restart.conf \
  /etc/systemd/system/container-internext-pos-gateway.service.d/dependency-restart.conf
systemctl daemon-reload
systemctl enable --now internext-pos-gateway-guard.timer
```

The guard waits for two failed readiness checks, only touches the gateway, and
does not restart the database, REST, or authentication services.
