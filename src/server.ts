import { TIDEProxy } from './tide-proxy';
import { io } from 'socket.io-client';

const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const port = process.env.TIDE_PROXY_SERVER_PORT || 3005;
const cors = require('cors');
const os = require('os');

const socket = io('http://localhost:3535/tide');
socket.on('connect', () => {
    console.log('connected');
});

app.use(express.json({ limit: '50mb' }));
app.use(
    cors({
        origin(origin: string, callback: Function) {
            callback(null, true);
        },
        methods: ['GET', 'PUT', 'POST', 'DELETE'],
        credentials: true,
    }),
);

let proxyURL = '';
let proxyName = 'remotenet';
let proxyConfig = { url: '', name: '' };
let proxy: any;
let adks: any[] = [];

const readProxy = async () => {
    try {
        proxyConfig = JSON.parse(await fs.readFileSync(path.join(__dirname, '..', 'debug.json'), 'utf-8'));
    } catch (ex) {

    }
    if (proxyConfig) {
        proxyURL = proxyConfig.url;
        proxyName = proxyConfig.name;
    }
    setProxy(proxyName, proxyURL);
};

const setProxy = async (name: string, url: string) => {
    proxyName = name;
    proxyURL = url;
    await fs.writeFileSync(path.join(__dirname, '..', 'debug.json'), JSON.stringify({
        url: proxyURL,
        name: proxyName,
    }), 'utf-8');
    if (proxy) {
        await proxy.stop();
    }
    proxy = new TIDEProxy(proxyURL, proxyName !== '' ? proxyName : 'remotenet', 3535);
};

const readADKs = async () => {
    try {
        adks = JSON.parse(await fs.readFileSync(path.join(__dirname, '..', 'adks.json'), 'utf-8'));
        proxy.setADKS(adks);
    } catch (ex) {

    }
};

app.get('/debug', (req: any, res: any) => {
    res.json({
        name: proxyName,
        url: proxyURL,
    });
});

app.post('/debug', async (req: any, res: any) => {
    await setProxy(req.body.name, req.body.url);
    res.status(200).send();
});

app.post('/refresh', async (req: any, res: any) => {
    res.json(proxy.handleRefresh());
    res.status(200).send();
});

app.post('/upload', async (req: any, res: any) => {
    socket.emit('application', {
        data: req.body.file,
        mac: req.body.mac,
    });
    await new Promise((resolve, reject) => {
        const listener = (data: any) => {
            if (data.mac !== req.body.mac) {
                return;
            }
            socket.off('upload_complete', listener);
            socket.off('upload', progressListener);
            resolve(data);
        };
        const progressListener = (data: any) => {
            if (data.mac !== req.body.mac) {
                return;
            }
            console.log(data);
        };
        socket.on('upload', progressListener);
        socket.on('upload_complete', listener);
    });
    res.status(200).send();
});

app.get('/devices', async (req: any, res: any) => {
    const devices = proxy.getDevices();
    // remove file from devices
    const devicesResult = devices.map((device: any) => {
        return {
            ...device,
            file: undefined,
            messageQueue: device.messageQueue.length,
        };
    });
    res.json(devicesResult);
});

app.get('/pendingMessages', async (req: any, res: any) => {
    res.json(proxy.pendingMessages.length);
});

app.get('/adks/:address?', async (req: any, res: any) => {
    if (req.params.address) {
        const adk = adks.find((adk: any) => adk.address === req.params.address);
        if (adk) {
            res.json(adk);
        } else {
            res.status(404).send();
        }
        return;
    }
    res.json(adks);
});

app.post('/adks/:address/gpio/:pin', async (req: any, res: any) => {
    socket.emit('gpio_set', {
        address: req.params.address,
        pin: req.params.pin,
        value: req.body.value,
    });
    res.status(200).send();
});

app.post('/adks/:address/wiegand', async (req: any, res: any) => {
    socket.emit('wiegand_send', {
        address: req.params.address,
        value: req.body.value,
    });
    res.status(200).send();
});

app.get('/interfaces', async (req: any, res: any) => {
    const interfaces = os.networkInterfaces();
    const interfacesList = [];

    for (const key in interfaces) {
        const iface = interfaces[key];
        for (let i = 0; i < iface.length; i++) {
            const tmp = iface[i];
            if (tmp.family == 'IPv4' && !tmp.internal) {
                interfacesList.push({
                    name: key,
                    address: tmp.address
                });
            }
        }
    }

    // Get current interface name from proxy
    let currentInterface = '';
    if (proxy && proxy.currentInterface) {
        // Find the interface name by comparing with the current interface netInterface address
        for (const key in interfaces) {
            const iface = interfaces[key];
            for (let i = 0; i < iface.length; i++) {
                const tmp = iface[i];
                if (tmp.family == 'IPv4' && !tmp.internal &&
                    tmp.address === proxy.currentInterface.netInterface.address) {
                    currentInterface = key;
                    break;
                }
            }
            if (currentInterface) break;
        }
    }

    res.json({
        interfaces: interfacesList,
        current: currentInterface
    });
});

app.post('/interfaces', async (req: any, res: any) => {
    proxy.setInterface(req.body.interface);
    res.status(200).send();
});

app.use(express.static(path.join(__dirname, '..', 'static')));

app.listen(port, async () => {
    console.log(`TIDE Proxy listening on port ${port}`);
    await readProxy();
    readADKs();
});
