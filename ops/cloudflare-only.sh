#!/usr/bin/env bash
#
# Only Cloudflare may reach this box on 80/443 (#772).
#
# ## Why
#
# Cloudflare's proxy absorbs floods aimed at `mio.dlany.uk`, and that is worth
# nothing while the droplet's own address still answers. On 2026-09-09 it did:
# `https://<origin ip>` with a `Host: mio.dlany.uk` header returned **200** and
# served the real `/api/health`. The origin presented the **Cloudflare Origin
# Certificate** while the same request through the hostname presented a
# **Google Trust Services** one — two certificates from two endpoints, which is
# what made it a measurement rather than an inference.
#
# ⚠️ The address was published directly in DNS until 2026-09-07, so it is in
# historical DNS and old scan data. Finding it is not the hard part.
#
# ## Why this is a script and not a paste
#
# ⛔ **Cloudflare adds IP ranges.** These rules are a snapshot, and a stale
# snapshot fails in the worst possible way: the site keeps working for you, keeps
# working for `droplet-drift.yml`, and is silently down for whoever lands on an
# edge in a range you never allowed. Nothing in MiO logs it.
#
# So this rebuilds the rules from the published list every time, and it is
# idempotent — run it on a cron, run it after a deploy, run it twice.
#
# ## ⛔ Two things that are easy to get wrong
#
# 1. **`ufw` does not work here.** Docker publishes ports by writing its own
#    iptables rules, traversed before ufw's, so `ufw deny 443` on a Docker host
#    reports success and leaves the port open. The rules have to go in
#    `DOCKER-USER`.
#
# 2. **`-i eth0` is load-bearing, and omitting it takes production down.**
#    `DOCKER-USER` sits in the FORWARD chain, which sees traffic in *both*
#    directions. Without the interface match, a rule on `--dports 80,443` also
#    matches a container's own outbound request to port 443 — so every
#    server-side fetch is dropped. An `ESTABLISHED,RELATED` accept does not save
#    it, because the first packet of an outbound connection is NEW.
#    This was shipped wrong once, on 2026-09-09, and broke outbound for minutes.
#
# ## Verifying, which needs all three
#
#   from off-box:  curl -k --resolve mio.dlany.uk:443:<ip> https://mio.dlany.uk/api/health
#                  → must NOT answer
#   from off-box:  curl https://mio.dlany.uk/api/health
#                  → must answer
#   on the box:    docker exec mio-prod-worker-1 python -c \
#                    "import urllib.request as u;print(u.urlopen('https://example.com',timeout=10).status)"
#                  → must be 200
#
# ⚠️ **Use a neutral host for the outbound check.** Probing `youtube.com` cannot
# tell a firewall from #177's refusal of this address, and a probe that cannot
# separate its two explanations has measured nothing.
#
# ## Rolling back
#
#   iptables  -F DOCKER-USER; iptables  -A DOCKER-USER -j RETURN
#   ip6tables -F DOCKER-USER; ip6tables -A DOCKER-USER -j RETURN
#
# A reboot does the same, unless the rules have been persisted.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

# The interface the default route leaves by. Never hardcode `eth0`: matching the
# wrong interface either protects nothing or blocks the containers.
IFACE=$(ip route get 1.1.1.1 | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") print $(i + 1)}')
if [ -z "${IFACE:-}" ] || [ "${IFACE#docker}" != "$IFACE" ] || [ "${IFACE#br-}" != "$IFACE" ]; then
  echo "refusing to run: '$IFACE' is not a public interface" >&2
  exit 1
fi
echo "public interface: $IFACE"

V4=$(curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4)
V6=$(curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6)

# ⛔ Refuse to continue on a short list. An empty or truncated answer would
# otherwise flush the allows, leave the DROP, and take the site off the internet
# — a fetch failing is not a reason to lock everyone out.
v4_count=$(printf '%s\n' "$V4" | grep -c .)
v6_count=$(printf '%s\n' "$V6" | grep -c .)
if [ "$v4_count" -lt 10 ] || [ "$v6_count" -lt 4 ]; then
  echo "refusing to run: got $v4_count IPv4 and $v6_count IPv6 ranges, which is too few" >&2
  exit 1
fi
echo "allowing $v4_count IPv4 and $v6_count IPv6 Cloudflare ranges"

# Start from Docker's own default so repeated runs do not stack duplicates.
iptables -F DOCKER-USER
iptables -A DOCKER-USER -j RETURN
ip6tables -F DOCKER-USER
ip6tables -A DOCKER-USER -j RETURN

# `-I` inserts at the top, so the deny goes in first and the allows land above it.
iptables -I DOCKER-USER -i "$IFACE" -p tcp -m multiport --dports 80,443 -j DROP
ip6tables -I DOCKER-USER -i "$IFACE" -p tcp -m multiport --dports 80,443 -j DROP

for cidr in $V4; do
  iptables -I DOCKER-USER -i "$IFACE" -s "$cidr" -p tcp -m multiport --dports 80,443 -j ACCEPT
done
for cidr in $V6; do
  ip6tables -I DOCKER-USER -i "$IFACE" -s "$cidr" -p tcp -m multiport --dports 80,443 -j ACCEPT
done

# Belt and braces. Not what makes outbound work — `-i $IFACE` is — but it keeps a
# connection already in flight from being cut if these rules are ever widened.
iptables -I DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -I DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

echo "done. Verify all three checks in the header before trusting this."
