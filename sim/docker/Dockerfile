# Renode-based simulator for Tibbo TPP boards (Zephyr firmware).
# Build context is the sim/ directory: docker build -f docker/Dockerfile .

# ---- sim-manager build ----
FROM node:20.18.1-bookworm-slim AS manager
WORKDIR /build
COPY manager/package.json manager/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY manager/ ./
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM ubuntu:24.04

# Renode >= 1.17: earlier SynopsysEthernetMAC models keep the ETH IRQ asserted with
# DMA interrupts disabled, which hangs the STM32F4 HAL v2 Ethernet driver (G3 boards).
ARG RENODE_VERSION=1.17.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl iproute2 iputils-ping dnsmasq-base libicu74 python3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/renode/renode/releases/download/v${RENODE_VERSION}/renode-${RENODE_VERSION}.linux-portable.tar.gz" -o /tmp/renode.tar.gz \
    && mkdir -p /opt/renode \
    && tar -xzf /tmp/renode.tar.gz -C /opt/renode --strip-components=1 \
    && rm /tmp/renode.tar.gz \
    && ln -s /opt/renode/renode /usr/local/bin/renode

COPY --from=manager /usr/local/bin/node /usr/local/bin/node
COPY --from=manager /build/lib /opt/sim/manager/lib
COPY --from=manager /build/node_modules /opt/sim/manager/node_modules
COPY --from=manager /build/public /opt/sim/manager/public
COPY --from=manager /build/package.json /opt/sim/manager/package.json

COPY renode/ /opt/sim/renode/
COPY docker/entrypoint.sh /opt/sim/entrypoint.sh
RUN sed -i 's/\r$//' /opt/sim/entrypoint.sh && chmod +x /opt/sim/entrypoint.sh

ENV SIM_DATA_DIR=/data \
    SIM_RENODE_DIR=/opt/sim/renode \
    SIM_HTTP_PORT=3100 \
    SIM_RELAY_PORT=65530

VOLUME /data
EXPOSE 3100/tcp 65530/udp

ENTRYPOINT ["/opt/sim/entrypoint.sh"]
