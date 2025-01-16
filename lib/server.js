"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const tide_proxy_1 = require("./tide-proxy");
const socket_io_client_1 = require("socket.io-client");
const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const port = process.env.TIDE_PROXY_SERVER_PORT || 3005;
const cors = require('cors');
const socket = socket_io_client_1.io('http://localhost:3535/tide');
socket.on('connect', () => {
    console.log('connected');
});
app.use(express.json({ limit: '50mb' }));
app.use(cors({
    origin(origin, callback) {
        callback(null, true);
    },
    methods: ['GET', 'PUT', 'POST', 'DELETE'],
    credentials: true,
}));
let proxyURL = '';
let proxyName = 'remotenet';
let proxyConfig = { url: '', name: '' };
let proxy;
let adks = [];
const readProxy = () => __awaiter(void 0, void 0, void 0, function* () {
    try {
        proxyConfig = JSON.parse(yield fs.readFileSync(path.join(__dirname, '..', 'debug.json'), 'utf-8'));
    }
    catch (ex) {
    }
    if (proxyConfig) {
        proxyURL = proxyConfig.url;
        proxyName = proxyConfig.name;
    }
    setProxy(proxyName, proxyURL);
});
const setProxy = (name, url) => __awaiter(void 0, void 0, void 0, function* () {
    proxyName = name;
    proxyURL = url;
    yield fs.writeFileSync(path.join(__dirname, '..', 'debug.json'), JSON.stringify({
        url: proxyURL,
        name: proxyName,
    }), 'utf-8');
    if (proxy) {
        yield proxy.stop();
    }
    proxy = new tide_proxy_1.TIDEProxy(proxyURL, proxyName !== '' ? proxyName : 'remotenet', 3535);
});
const readADKs = () => __awaiter(void 0, void 0, void 0, function* () {
    try {
        adks = JSON.parse(yield fs.readFileSync(path.join(__dirname, '..', 'adks.json'), 'utf-8'));
        proxy.setADKS(adks);
    }
    catch (ex) {
    }
});
app.get('/debug', (req, res) => {
    res.json({
        name: proxyName,
        url: proxyURL,
    });
});
app.post('/debug', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield setProxy(req.body.name, req.body.url);
    res.status(200).send();
}));
app.post('/refresh', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    res.json(proxy.handleRefresh());
    res.status(200).send();
}));
app.post('/upload', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    socket.emit('application', {
        data: req.body.file,
        mac: req.body.mac,
    });
    yield new Promise((resolve, reject) => {
        const listener = (data) => {
            socket.off('upload_complete', listener);
            socket.off('upload', progressListener);
            resolve(data);
        };
        const progressListener = (data) => {
            console.log(data);
        };
        socket.on('upload', progressListener);
        socket.on('upload_complete', listener);
    });
    res.status(200).send();
}));
app.get('/devices', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const devices = proxy.getDevices();
    const devicesResult = devices.map((device) => {
        return Object.assign(Object.assign({}, device), { file: undefined, messageQueue: device.messageQueue.length });
    });
    res.json(devicesResult);
}));
app.get('/pendingMessages', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    res.json(proxy.pendingMessages.length);
}));
app.get('/adks/:address?', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    if (req.params.address) {
        const adk = adks.find((adk) => adk.address === req.params.address);
        if (adk) {
            res.json(adk);
        }
        else {
            res.status(404).send();
        }
        return;
    }
    res.json(adks);
}));
app.post('/adks/:address/gpio/:pin', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    socket.emit('gpio_set', {
        address: req.params.address,
        pin: req.params.pin,
        value: req.body.value,
    });
    res.status(200).send();
}));
app.post('/adks/:address/wiegand', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    socket.emit('wiegand_send', {
        address: req.params.address,
        value: req.body.value,
    });
    res.status(200).send();
}));
app.use(express.static(path.join(__dirname, '..', 'static')));
app.listen(port, () => __awaiter(void 0, void 0, void 0, function* () {
    console.log(`TIDE Proxy listening on port ${port}`);
    yield readProxy();
    readADKs();
}));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3NlcnZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7OztBQUFBLDZDQUF5QztBQUN6Qyx1REFBc0M7QUFFdEMsTUFBTSxPQUFPLEdBQUcsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQ25DLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUM3QixNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDekIsTUFBTSxHQUFHLEdBQUcsT0FBTyxFQUFFLENBQUM7QUFDdEIsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQkFBc0IsSUFBSSxJQUFJLENBQUM7QUFDeEQsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBRTdCLE1BQU0sTUFBTSxHQUFHLHFCQUFFLENBQUMsNEJBQTRCLENBQUMsQ0FBQztBQUNoRCxNQUFNLENBQUMsRUFBRSxDQUFDLFNBQVMsRUFBRSxHQUFHLEVBQUU7SUFDdEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUM3QixDQUFDLENBQUMsQ0FBQztBQUVILEdBQUcsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDekMsR0FBRyxDQUFDLEdBQUcsQ0FDSCxJQUFJLENBQUM7SUFDRCxNQUFNLENBQUMsTUFBYyxFQUFFLFFBQWtCO1FBQ3JDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUM7SUFDekIsQ0FBQztJQUNELE9BQU8sRUFBRSxDQUFDLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLFFBQVEsQ0FBQztJQUN6QyxXQUFXLEVBQUUsSUFBSTtDQUNwQixDQUFDLENBQ0wsQ0FBQztBQUVGLElBQUksUUFBUSxH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