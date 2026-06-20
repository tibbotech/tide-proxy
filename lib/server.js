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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
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
const os = require('os');
const PROXY_PORT = 3535;
const socket = socket_io_client_1.io(`http://localhost:${PROXY_PORT}/tide`);
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
    proxy = new tide_proxy_1.TIDEProxy(proxyURL, proxyName !== '' ? proxyName : 'remotenet', PROXY_PORT);
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
            if (data.mac !== req.body.mac) {
                return;
            }
            socket.off('upload_complete', listener);
            socket.off('upload', progressListener);
            resolve(data);
        };
        const progressListener = (data) => {
            if (data.mac !== req.body.mac) {
                return;
            }
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
        const { file, uploadWatchdog, verificationTimer, resetProgrammingToken, infoToken, deviceInterface, deviceDefinition } = device, rest = __rest(device, ["file", "uploadWatchdog", "verificationTimer", "resetProgrammingToken", "infoToken", "deviceInterface", "deviceDefinition"]);
        return Object.assign(Object.assign({}, rest), { messageQueue: device.messageQueue.length });
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
app.get('/interfaces', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
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
    let currentInterface = '';
    if (proxy && proxy.currentInterface) {
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
            if (currentInterface)
                break;
        }
    }
    res.json({
        interfaces: interfacesList,
        current: currentInterface
    });
}));
app.post('/interfaces', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    proxy.setInterface(req.body.interface);
    res.status(200).send();
}));
app.use(express.static(path.join(__dirname, '..', 'static')));
app.listen(port, () => __awaiter(void 0, void 0, void 0, function* () {
    console.log(`TIDE Proxy listening on port ${port}`);
    yield readProxy();
    readADKs();
}));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3NlcnZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQXlDO0FBQ3pDLHVEQUFzQztBQUV0QyxNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDbkMsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQzdCLE1BQU0sRUFBRSxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUN6QixNQUFNLEdBQUcsR0FBRyxPQUFPLEVBQUUsQ0FBQztBQUN0QixNQUFNLElBQUksR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLHNCQUFzQixJQUFJLElBQUksQ0FBQztBQUN4RCxNQUFNLElBQUksR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDN0IsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBRXpCLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQztBQUV4QixNQUFNLE1BQU0sR0FBRyxxQkFBRSxDQUFDLG9CQUFvQixVQUFVLE9BQU8sQ0FBQyxDQUFDO0FBQ3pELE1BQU0sQ0FBQyxFQUFFLENBQUMsU0FBUyxFQUFFLEdBQUcsRUFBRTtJQUN0QixPQUFPLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBQzdCLENBQUMsQ0FBQyxDQUFDO0FBRUgsR0FBRyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUMsQ0FBQztBQUN6QyxHQUFHLENBQUMsR0FBRyxDQUNILElBQUksQ0FBQztJQUNELE1BQU0sQ0FBQyxNQUFjLEVBQUUsUUFBa0I7UUFDckMsUUFBUSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQztJQUN6QixDQUFDO0lBQ0QsT0FBTyxFQUFFLENBQUMs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