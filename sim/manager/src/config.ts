import * as path from 'path';

function num(name: string, def: number): number {
    const v = process.env[name];
    return v ? parseInt(v, 10) : def;
}

export const config = {
    dataDir: process.env.SIM_DATA_DIR || path.resolve('sim-data'),
    renodeDir: process.env.SIM_RENODE_DIR || path.resolve(__dirname, '../../renode'),
    renodeBin: process.env.SIM_RENODE_BIN || 'renode',
    httpPort: num('SIM_HTTP_PORT', 3100),
    relayPort: num('SIM_RELAY_PORT', 65530),
    // Linux bridge the instance TAPs join; the manager owns its first address.
    bridge: process.env.SIM_BRIDGE || 'br-sim',
    bridgeIp: process.env.SIM_BRIDGE_IP || '10.77.0.1',
    subnetPrefix: process.env.SIM_SUBNET_PREFIX || '10.77.0.',
    // Instance n gets IP <prefix>(ipBase + n) via DHCP and device HTTP on httpForwardBase + n.
    ipBase: num('SIM_IP_BASE', 10),
    httpForwardBase: num('SIM_HTTP_FORWARD_BASE', 18000),
    maxInstances: num('SIM_MAX_INSTANCES', 32),
    // Internal TCP ports (inside the container) for Renode monitor, bridge and UARTs.
    monitorPortBase: num('SIM_MONITOR_PORT_BASE', 41000),
    bridgePortBase: num('SIM_BRIDGE_PORT_BASE', 42000),
    uartPortBase: num('SIM_UART_PORT_BASE', 43000),
    // MAC prefix for instance n: <prefix>:<n hex>. 00:24:77 is Tibbo's OUI.
    macPrefix: process.env.SIM_MAC_PREFIX || '00:24:77:fe:00',
    // Manage TAP devices and dnsmasq host entries (off when running without root/bridge).
    manageNetwork: (process.env.SIM_MANAGE_NETWORK || 'true') !== 'false',
    dnsmasqHostsFile: process.env.SIM_DNSMASQ_HOSTS || '/run/sim/dnsmasq.hosts',
    dnsmasqPidFile: process.env.SIM_DNSMASQ_PID || '/run/sim/dnsmasq.pid',
};

// Shared firmware library of earlier versions; only read to migrate instances that used it.
export function legacyFirmwareDir(): string {
    return path.join(config.dataDir, 'firmware');
}

export function monitorsDir(): string {
    return path.join(config.dataDir, 'monitors');
}

export function instancesDir(): string {
    return path.join(config.dataDir, 'instances');
}
