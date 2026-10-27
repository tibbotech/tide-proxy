#!/bin/bash
# Sets up the simulated LAN (bridge + DHCP) and runs the sim-manager.
set -e

BRIDGE="${SIM_BRIDGE:-br-sim}"
BRIDGE_IP="${SIM_BRIDGE_IP:-10.77.0.1}"
PREFIX="${SIM_SUBNET_PREFIX:-10.77.0.}"

mkdir -p /run/sim "$SIM_DATA_DIR"

if ! ip link show "$BRIDGE" >/dev/null 2>&1; then
    ip link add name "$BRIDGE" type bridge
fi
ip addr replace "${BRIDGE_IP}/24" dev "$BRIDGE"
ip link set "$BRIDGE" up

# The relay sends limited broadcasts (255.255.255.255) which must leave through the bridge.
ip route replace 255.255.255.255/32 dev "$BRIDGE" src "$BRIDGE_IP"

# Docker Desktop's VM hands packets in marked "checksum verified" without a valid checksum;
# the TAP passes them to Renode as-is and the guest drops them (TCP never gets past SYN-ACK).
# iptables CHECKSUM only fills partial checksums, so recompute every packet onto the bridge.
tc qdisc replace dev "$BRIDGE" clsact
tc filter replace dev "$BRIDGE" egress pref 1 matchall action csum ip4h icmp tcp udp \
    || echo "warning: checksum fix-up failed; TCP from outside the container may not reach devices" >&2

# Devices with a static IP outside 10.77.0.0/24 still reply to us; don't drop those.
# (docker-compose sets the sysctls; this covers `docker run --privileged`.)
for f in /proc/sys/net/ipv4/conf/*/rp_filter; do { echo 0 > "$f"; } 2>/dev/null || true; done

# Outbound access for devices (internet, the Docker host, the host's LAN): NAT through the
# container's own uplink. docker-compose sets net.ipv4.ip_forward; this covers --privileged.
# SIM_NAT=0 keeps the simulated LAN isolated.
if [ "${SIM_NAT:-1}" = "1" ]; then
    { echo 1 > /proc/sys/net/ipv4/ip_forward; } 2>/dev/null || true
    UPLINK="$(ip route show default | awk '{ print $5; exit }')"
    if [ -n "$UPLINK" ]; then
        iptables -t nat -C POSTROUTING -o "$UPLINK" -j MASQUERADE 2>/dev/null \
            || iptables -t nat -A POSTROUTING -o "$UPLINK" -j MASQUERADE \
            || echo "warning: NAT setup failed; devices will have no outbound access" >&2
    fi
fi

# DNS on the bridge too, forwarding to the container's resolver (Docker's embedded DNS, which
# also resolves host.docker.internal). DHCP advertises the bridge IP as the DNS server.
touch /run/sim/dnsmasq.hosts
dnsmasq \
    --interface="$BRIDGE" --bind-interfaces \
    --no-hosts \
    --dhcp-range="${PREFIX}100,${PREFIX}250,255.255.255.0,12h" \
    --dhcp-option=option:router,"$BRIDGE_IP" \
    --dhcp-hostsfile=/run/sim/dnsmasq.hosts \
    --dhcp-authoritative \
    --dhcp-leasefile=/run/sim/dnsmasq.leases \
    --pid-file=/run/sim/dnsmasq.pid \
    --log-facility=- --quiet-dhcp

cd /opt/sim/manager
exec node lib/server.js
