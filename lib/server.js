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
const os = require('os');
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3NlcnZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7OztBQUFBLDZDQUF5QztBQUN6Qyx1REFBc0M7QUFFdEMsTUFBTSxPQUFPLEdBQUcsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQ25DLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUM3QixNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDekIsTUFBTSxHQUFHLEdBQUcsT0FBTyxFQUFFLENBQUM7QUFDdEIsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQkFBc0IsSUFBSSxJQUFJLENBQUM7QUFDeEQsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQzdCLE1BQU0sRUFBRSxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUV6QixNQUFNLE1BQU0sR0FBRyxxQkFBRSxDQUFDLDRCQUE0QixDQUFDLENBQUM7QUFDaEQsTUFBTSxDQUFDLEVBQUUsQ0FBQyxTQUFTLEVBQUUsR0FBRyxFQUFFO0lBQ3RCLE9BQU8sQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLENBQUM7QUFDN0IsQ0FBQyxDQUFDLENBQUM7QUFFSCxHQUFHLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ3pDLEdBQUcsQ0FBQyxHQUFHLENBQ0gsSUFBSSxDQUFDO0lBQ0QsTUFBTSxDQUFDLE1BQWMsRUFBRSxRQUFrQjtRQUNyQyxRQUFRLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ3pCLENBQUM7SUFDRCxPQUFPLEVBQUUsQ0FBQyxLQUFLLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxRQUFRLENBQUM7SUFDekMsV0FBVyxFQUFFLElBQUk7Q0FDcEIsQ0FBQyxDQUNMLENBQUM7QUFFRixJQUFJLFFBQVEsR0FBRyxFQUFFLENBQUM7QUFDbEIsSUFBSSxTQUFTLEdBQUcsV0FBVyxDQUFDO0FBQzVCLElBQUksV0FBVyxHQUFHLEVBQUUsR0FBRyxFQUFFLEVBQUUsRUFBRSxJQUFJLEVBQUUsRUFBRSxFQUFFLENBQUM7QUFDeEMsSUFBSSxLQUFVLENBQUM7QUFDZixJQUFJLElBQUksR0FBVSxFQUFFLENBQUM7QUFFckIsTUFBTSxTQUFTLEdBQUcsR0FBUyxFQUFFO0lBQ3pCLElBQUk7UUFDQSxXQUFXLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsSUFBSSxFQUFFLFlBQVksQ0FBQyxFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUM7S0FDdEc7SUFBQyxPQUFPLEVBQUUsRUFBRTtLQUVaO0lBQ0QsSUFBSSxXQUFXLEVBQUU7UUFDYixRQUFRLEdBQUcsV0FBVyxDQUFDLEdBQUcsQ0FBQztRQUMzQixTQUFTLEdBQUcsV0FBVyxDQUFDLElBQUksQ0FBQztLQUNoQztJQUNELFFBQVEsQ0FBQyxTQUFTLEVBQUUsUUFBUSxDQUFDLENBQUM7QUFDbEMsQ0FBQyxDQUFBLENBQUM7QUFFRixNQUFNLFFBQVEsR0FBRyxDQUFPLElBQVksRUFBRSxHQUFXLEVBQUUsRUFBRTtJQUNqRCxTQUFTLEdBQUcsSUFBSSxDQUFDO0lBQ2pCLFFBQVEsR0FBRyxHQUFHLENBQUM7SUFDZixNQUFNLEVBQUUsQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsSUFBSSxFQUFFLFlBQVksQ0FBQyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7UUFDNUUsR0FBRyxFQUFFLFFBQVE7UUFDYixJQUFJLEVBQUUsU0FBUztLQUNsQixDQUFDLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDYixJQUFJLEtBQUssRUFBRTtRQUNQLE1BQU0sS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO0tBQ3RCO0lBQ0QsS0FBSyxHQUFHLElBQUksc0JBQVMsQ0FBQyxRQUFRLEVBQUUsU0FBUyxLQUFLLEVBQUUsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxXQUFXLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFDdEYsQ0FBQyxDQUFBLENBQUM7QUFFRixNQUFNLFFBQVEsR0FBRyxHQUFTLEVBQUU7SUFDeEIsSUFBSTtRQUNBLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsV0FBVyxDQUFDLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQztRQUMzRixLQUFLLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO0tBQ3ZCO0lBQUMsT0FBTyxFQUFFLEVBQUU7S0FFWjtBQUNMLENBQUMsQ0FBQSxDQUFDO0FBRUYsR0FBRyxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxHQUFRLEVBQUUsR0FBUSxFQUFFLEVBQUU7SUFDckMsR0FBRyxDQUFDLElBQUksQ0FBQztRQUNMLElBQUksRUFBRSxTQUFTO1FBQ2YsR0FBRyxFQUFFLFFBQVE7S0FDaEIsQ0FBQyxDQUFDO0FBQ1AsQ0FBQyxDQUFDLENBQUM7QUFFSCxHQUFHLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFPLEdBQVEsRUFBRSxHQUFRLEVBQUUsRUFBRTtJQUM1QyxNQUFNLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQzVDLEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7QUFDM0IsQ0FBQyxDQUFBLENBQUMsQ0FBQztBQUVILEdBQUcsQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLENBQU8sR0FBUSxFQUFFLEdBQVEsRUFBRSxFQUFFO0lBQzlDLEdBQUcsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLGFBQWEsRUFBRSxDQUFDLENBQUM7SUFDaEMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUMzQixDQUFDLENBQUEsQ0FBQyxDQUFDO0FBRUgsR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBTyxHQUFRLEVBQUUsR0FBUSxFQUFFLEVBQUU7SUFDN0MsTUFBTSxDQUFDLElBQUksQ0FBQyxhQUFhLEVBQUU7UUFDdkIsSUFBSSxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSTtRQUNuQixHQUFHLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHO0tBQ3BCLENBQUMsQ0FBQztJQUNILE1BQU0sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7UUFDbEMsTUFBTSxRQUFRLEdBQUcsQ0FBQyxJQUFTLEVBQUUsRUFBRTtZQUMzQixJQUFJLElBQUksQ0FBQyxHQUFHLEtBQUssR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUU7Z0JBQzNCLE9BQU87YUFDVjtZQUNELE1BQU0sQ0FBQyxHQUFHLENBQUMsaUJBQWlCLEVBQUUsUUFBUSxDQUFDLENBQUM7WUFDeEMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztZQUN2QyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDbEIsQ0FBQyxDQUFDO1FBQ0YsTUFBTSxnQkFBZ0IsR0FBRyxDQUFDLElBQVMsRUFBRSxFQUFFO1lBQ25DLElBQUksSUFBSSxDQUFDLEdBQUcsS0FBSyxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRTtnQkFDM0IsT0FBTzthQUNWO1lBQ0QsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN0QixDQUFDLENBQUM7UUFDRixNQUFNLENBQUMsRUFBRSxDQUFDLFFBQVEsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO1FBQ3RDLE1BQU0sQ0FBQyxFQUFFLENBQUMsaUJBQWlCLEVBQUUsUUFBUSxDQUFDLENBQUM7SUFDM0MsQ0FBQyxDQUFDLENBQUM7SUFDSCxHQUFHLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0FBQzNCLENBQUMsQ0FBQSxDQUFDLENBQUM7QUFFSCxHQUFHLENBQUMsR0FBRyxDQUFDLFVBQVUsRUFBRSxDQUFPLEdBQVEsRUFBRSxHQUFRLEVBQUUsRUFBRTtJQUM3QyxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7SUFFbkMsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE1BQVcsRUFBRSxFQUFFO1FBQzlDLHVDQUNPLE1BQU0sS0FDVCxJQUFJLEVBQUUsU0FBUyxFQUNmLFlBQVksRUFBRSxNQUFNLENBQUMsWUFBWSxDQUFDLE1BQU0sSUFDMUM7SUFDTixDQUFDLENBQUMsQ0FBQztJQUNILEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUM7QUFDNUIsQ0FBQyxDQUFBLENBQUMsQ0FBQztBQUVILEdBQUcsQ0FBQyxHQUFHLENBQUMsa0JBQWtCLEVBQUUsQ0FBTyxHQUFRLEVBQUUsR0FBUSxFQUFFLEVBQUU7SUFDckQsR0FBRyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQzNDLENBQUMsQ0FBQSxDQUFDLENBQUM7QUFFSCxHQUFHLENBQUMsR0FBRyxDQUFDLGlCQUFpQixFQUFFLENBQU8sR0FBUSxFQUFFLEdBQVEsRUFBRSxFQUFFO0lBQ3BELElBQUksR0FBRyxDQUFDLE1BQU0sQ0FBQyxPQUFPLEVBQUU7UUFDcEIsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQVEsRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLE9BQU8sS0FBSyxHQUFHLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ3hFLElBQUksR0FBRyxFQUFFO1lBQ0wsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztTQUNqQjthQUFNO1lBQ0gsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztTQUMxQjtRQUNELE9BQU87S0FDVjtJQUNELEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDbkIsQ0FBQyxDQUFBLENBQUMsQ0FBQztBQUVILEdBQUcsQ0FBQyxJQUFJLENBQUMsMEJBQTBCLEVBQUUsQ0FBTyxHQUFRLEVBQUUsR0FBUSxFQUFFLEVBQUU7SUFDOUQsTUFBTSxDQUFDLElBQUksQ0FBQyxVQUFVLEVBQUU7UUFDcEIsT0FBTyxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsT0FBTztRQUMzQixHQUFHLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHO1FBQ25CLEtBQUssRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEtBQUs7S0FDeEIsQ0FBQyxDQUFDO0lBQ0gsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUMzQixDQUFDLENBQUEsQ0FBQyxDQUFDO0FBRUgsR0FBRyxDQUFDLElBQUksQ0FBQyx3QkFBd0IsRUFBRSxDQUFPLEdBQVEsRUFBRSxHQUFRLEVBQUUsRUFBRTtJQUM1RCxNQUFNLENBQUMsSUFBSSxDQUFDLGNBQWMsRUFBRTtRQUN4QixPQUFPLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxPQUFPO1FBQzNCLEtBQUssRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEtBQUs7S0FDeEIsQ0FBQyxDQUFDO0lBQ0gsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUMzQixDQUFDLENBQUEsQ0FBQyxDQUFDO0FBRUgsR0FBRyxDQUFDLEdBQUcsQ0FBQyxhQUFhLEVBQUUsQ0FBTyxHQUFRLEVBQUUsR0FBUSxFQUFFLEVBQUU7SUFDaEQsTUFBTSxVQUFVLEdBQUcsRUFBRSxDQUFDLGlCQUFpQixFQUFFLENBQUM7SUFDMUMsTUFBTSxjQUFjLEdBQUcsRUFBRSxDQUFDO0lBRTFCLEtBQUssTUFBTSxHQUFHLElBQUksVUFBVSxFQUFFO1FBQzFCLE1BQU0sS0FBSyxHQUFHLFVBQVUsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUM5QixLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtZQUNuQyxNQUFNLEdBQUcsR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDckIsSUFBSSxHQUFHLENBQUMsTUFBTSxJQUFJLE1BQU0sSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUU7Z0JBQ3ZDLGNBQWMsQ0FBQyxJQUFJLENBQUM7b0JBQ2hCLElBQUksRUFBRSxHQUFHO29CQUNULE9BQU8sRUFBRSxHQUFHLENBQUMsT0FBTztpQkFDdkIsQ0FBQyxDQUFDO2FBQ047U0FDSjtLQUNKO0lBR0QsSUFBSSxnQkFBZ0IsR0FBRyxFQUFFLENBQUM7SUFDMUIsSUFBSSxLQUFLLElBQUksS0FBSyxDQUFDLGdCQUFnQixFQUFFO1FBRWpDLEtBQUssTUFBTSxHQUFHLElBQUksVUFBVSxFQUFFO1lBQzFCLE1BQU0sS0FBSyxHQUFHLFVBQVUsQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUM5QixLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtnQkFDbkMsTUFBTSxHQUFHLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUNyQixJQUFJLEdBQUcsQ0FBQyxNQUFNLElBQUksTUFBTSxJQUFJLENBQUMsR0FBRyxDQUFDLFFBQVE7b0JBQ3JDLEdBQUcsQ0FBQyxPQUFPLEtBQUssS0FBSyxDQUFDLGdCQUFnQixDQUFDLFlBQVksQ0FBQyxPQUFPLEVBQUU7b0JBQzdELGdCQUFnQixHQUFHLEdBQUcsQ0FBQztvQkFDdkIsTUFBTTtpQkFDVDthQUNKO1lBQ0QsSUFBSSxnQkFBZ0I7Z0JBQUUsTUFBTTtTQUMvQjtLQUNKO0lBRUQsR0FBRyxDQUFDLElBQUksQ0FBQztRQUNMLFVBQVUsRUFBRSxjQUFjO1FBQzFCLE9BQU8sRUFBRSxnQkFBZ0I7S0FDNUIsQ0FBQyxDQUFDO0FBQ1AsQ0FBQyxDQUFBLENBQUMsQ0FBQztBQUVILEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxFQUFFLENBQU8sR0FBUSxFQUFFLEdBQVEsRUFBRSxFQUFFO0lBQ2pELEtBQUssQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUN2QyxHQUFHLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0FBQzNCLENBQUMsQ0FBQSxDQUFDLENBQUM7QUFFSCxHQUFHLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUU5RCxHQUFHLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxHQUFTLEVBQUU7SUFDeEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQ0FBZ0MsSUFBSSxFQUFFLENBQUMsQ0FBQztJQUNwRCxNQUFNLFNBQVMsRUFBRSxDQUFDO0lBQ2xCLFFBQVEsRUFBRSxDQUFDO0FBQ2YsQ0FBQyxDQUFBLENBQUMsQ0FBQyJ9