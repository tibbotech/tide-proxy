import { TIDEProxy } from './tide-proxy';
import { io } from 'socket.io-client';

const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const port = process.env.TIDE_PROXY_SERVER_PORT || 3005;
const cors = require('cors');

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
            socket.off('upload_complete', listener);
            socket.off('upload', progressListener);
            resolve(data);
        };
        const progressListener = (data: any) => {
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
    devices.forEach((device: any) => {
        delete device.file;
        delete device.messageQueue;
    });
    res.json(devices);
});

app.get('/pendingMessages', async (req: any, res: any) => {
    res.json(proxy.pendingMessages.length);
});

app.use('/*', express.static(path.join(__dirname, '..', 'static')));

app.listen(port, () => {
    console.log(`TIDE Proxy listening on port ${port}`);
    readProxy();
});
