# `proxy/certs/`

The origin certificate the edge proxy serves, and nothing else. **Everything in
here except this file is gitignored — it contains a private key.**

Empty is the correct state for a fresh clone and for CI. The Caddyfile imports
`/etc/caddy/certs/*.caddy`, and an import glob matching nothing is a warning
rather than an error, so an empty directory validates and Caddy falls through to
automatic HTTPS.

## What belongs here, on a host that is behind Cloudflare

| file | what it is |
|---|---|
| `origin.pem` | the Cloudflare Origin Certificate |
| `origin.key` | its private key — ⛔ shown once, at creation |
| `tls.caddy` | one line: `tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key` |

## Why an origin certificate rather than Let's Encrypt

`mio.dlany.uk` is proxied through Cloudflare because China blocks the
DigitalOcean address — the **IP**, not the hostname, which is why moving the
same name onto Cloudflare's addresses fixed it.

Behind that proxy Caddy cannot renew the way it did: its default TLS-ALPN-01
challenge has to terminate TLS, and Cloudflare terminates it first. ⚠️ **A
certificate that quietly stops renewing takes the site down on a date nobody has
in their calendar.** An origin certificate is valid 15 years and is never
renewed, which removes the failure mode instead of scheduling it.

## Setting it up

1. Cloudflare → the zone → **SSL/TLS → Origin Server → Create Certificate**
2. Keep *Generate private key and CSR with Cloudflare*; hostnames `dlany.uk` and
   `*.dlany.uk`; validity 15 years
3. ⛔ **Copy the private key before leaving the page.** It is shown once.

```bash
mkdir -p proxy/certs && chmod 700 proxy/certs
# paste each box into its file
chmod 600 proxy/certs/origin.key
printf 'tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key\n' > proxy/certs/tls.caddy

openssl x509 -in proxy/certs/origin.pem -noout -subject -enddate   # check before reloading
openssl pkey -in proxy/certs/origin.key -noout -check              # "Key is valid"

docker compose --env-file .env.prod -f docker-compose.proxy.yml up -d
```

`up -d` rather than a reload: the volume list changed, so the container has to
be recreated.

## Verifying

⚠️ Ask the **origin** for its certificate, not Cloudflare — through the proxy you
would only ever see Cloudflare's own edge certificate and learn nothing:

```bash
echo | openssl s_client -connect <droplet-ip>:443 -servername mio.dlany.uk 2>/dev/null \
  | openssl x509 -noout -issuer -enddate
```

The issuer should name CloudFlare Origin, and the expiry should be ~15 years out.

## ⛔ Two things that will bite

- **An origin certificate is trusted by Cloudflare, not by browsers.** The
  proxy has to stay on. Turning the orange cloud off serves an untrusted
  certificate to everyone.
- **The way back** is to delete `tls.caddy` and reload; Caddy resumes managing
  its own certificate from Let's Encrypt.
