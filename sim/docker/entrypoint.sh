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

# Devices with a static IP outside 10.77.0.0/24 still reply to us; don't drop those.
# (docker-compose sets the sysctls; this covers `docker run --privileged`.)
for f in /proc/sys/net/ipv4/conf/*/rp_filter; do { echo 0 > "$f"; } 2>/dev/null || true; done

touch /run/sim/dnsmasq.hosts
dnsmasq \
    --interface="$BRIDGE" --bind-interfaces \
    --port=0 \
    --dhcp-range="${PREFIX}100,${PREFIX}250,255.255.255.0,12h" \
    --dhcp-option=option:router,"$BRIDGE_IP" \
    --dhcp-hostsfile=/run/sim/dnsmasq.hosts \
    --dhcp-authoritative \
    --dhcp-leasefile=/run/sim/dnsmasq.leases \
    --pid-file=/run/sim/dnsmasq.pid \
    --log-facility=- --quiet-dhcp

cd /opt/sim/manager
exec node lib/server.js
