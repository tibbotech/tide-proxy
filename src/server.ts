import { TIDEProxy } from './tide-proxy';

const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const port = process.env.TIDE_PROXY_SERVER_PORT || 3000;

app.use(express.json({ limit: '50mb' }));

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
};

const setProxy = async (name: string, url: string) => {
    proxyName = name;
    proxyURL = url;
    await fs.writeFileSync(path.join(__dirname, '..', 'debug.json'), JSON.stringify({
        url: proxyURL,
        name: proxyName,
    }), 'utf-8');
    if (proxyURL !== '') {
        if (proxy) {
            proxy.close();
        }
        proxy = new TIDEProxy(proxyURL, proxyName !== '' ? proxyName : 'remotenet', 3535);
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

app.use('/*', express.static(path.join(__dirname, '..', 'static')));


app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
    readProxy();
});
