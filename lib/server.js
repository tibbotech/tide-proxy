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
        return Object.assign(Object.assign({}, device), { file: undefined, messageQueue: undefined });
    });
    res.json(devices);
}));
app.get('/pendingMessages', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    res.json(proxy.pendingMessages.length);
}));
app.use('/*', express.static(path.join(__dirname, '..', 'static')));
app.listen(port, () => {
    console.log(`TIDE Proxy listening on port ${port}`);
    readProxy();
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3NlcnZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7OztBQUFBLDZDQUF5QztBQUN6Qyx1REFBc0M7QUFFdEMsTUFBTSxPQUFPLEdBQUcsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQ25DLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUM3QixNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDekIsTUFBTSxHQUFHLEdBQUcsT0FBTyxFQUFFLENBQUM7QUFDdEIsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQkFBc0IsSUFBSSxJQUFJLENBQUM7QUFDeEQsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBRTdCLE1BQU0sTUFBTSxHQUFHLHFCQUFFLENBQUMsNEJBQTRCLENBQUMsQ0FBQztBQUNoRCxNQUFNLENBQUMsRUFBRSxDQUFDLFNBQVMsRUFBRSxHQUFHLEVBQUU7SUFDdEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUM3QixDQUFDLENBQUMsQ0FBQztBQUVILEdBQUcsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDekMsR0FBRyxDQUFDLEdBQUcsQ0FDSCxJQUFJLENBQUM7SUFDRCxNQUFNLENBQUMsTUFBYyxFQUFFLFFBQWtCO1FBQ3JDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUM7SUFDekIsQ0FBQztJQUNELE9BQU8sRUFBRSxDQUFDLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLFFBQVEsQ0FBQztJQUN6QyxXQUFXLEVBQUUsSUFBSTtDQUNwQixDQUFDLENBQ0wsQ0FBQztBQUVGLElBQUksUUFBUSxHQUFHLEVBQUUsQ0FBQztBQUNsQixJQUFJLFNBQVMsR0FBRyxXQUFXLENBQUM7QUFDNUIsSUFBSSxXQUFXLEdBQUcsRUFBRSxHQUFHLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxFQUFFLEVBQUUsQ0FBQztBQUN4QyxJQUFJLEtBQVUsQ0FBQztBQUVmLE1BQU0sU0FBUyxHQUFHLEdBQVMsRUFBRTtJQUN6QixJQUFJO1FBQ0EsV0FBVyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxZQUFZLENBQUMsRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDO0tBQ3RHO0lBQUMsT0FBTyxFQUFFLEVBQUU7S0FFWjtJQUNELElBQUksV0FBVyxFQUFFO1FBQ2IsUUFBUSxHQUFHLFdBQVcsQ0FBQyxHQUFHLENBQUM7UUFDM0IsU0FBUyxHQUFHLFdBQVcsQ0FBQyxJQUFJLENBQUM7S0FDaEM7SUFDRCxRQUFRLENBQUMsU0FBUyxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQ2xDLENBQUMsQ0FBQSxDQUFDO0FBRUYsTUFBTSxRQUFRLEdBQUcsQ0FBTyxJQUFZLEVBQUUsR0FBVyxFQUFFLEVBQUU7SUFDakQsU0FBUyxHQUFHLElBQUksQ0FBQztJQUNqQixRQUFRLEdBQUcsR0FBRyxDQUFDO0lBQ2YsTUFBTSxFQUFFLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxZQUFZLENBQUMsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO1FBQzVFLEdBQUcsRUFBRSxRQUFRO1FBQ2IsSUFBSSxFQUFFLFNBQVM7S0FDbEIsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ2IsSUFBSSxLQUFLLEVBQUU7UUFDUCxNQUFNLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztLQUN0QjtJQUNELEtBQUssR0FBRyxJQUFJLHNCQUFTLENBQUMsUUFBUSxFQUFFLFNBQVMsS0FBSyxFQUFFLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsV0FBVyxFQUFFLElBQUksQ0FBQyxDQUFDO0FBQ3RGLENBQUMsQ0FBQSxDQUFDO0FBRUYsR0FBRyxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxHQUFRLEVBQUUsR0FBUSxFQUFFLEVBQUU7SUFDckMsR0FBRyxDQUFDLElBQUksQ0FBQztRQUNMLElBQUksRUFBRSxTQUFTO1FBQ2YsR0FBRyxFQUFFLFFBQVE7S0FDaEIsQ0FBQyxDQUFDO0FBQ1AsQ0FBQyxDQUFDLENBQUM7QUFFSCxHQUFHLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFPLEdBQVEsRUFBRSxHQUFRLEVBQUUsRUFBRTtJQUM1QyxNQUFNLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQzVDLEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7QUFDM0IsQ0FBQyxDQUFBLENBQUMsQ0FBQztBQUVILEdBQUcsQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLENBQU8sR0FBUSxFQUFFLEdBQVEsRUFBRSxFQUFFO0lBQzlDLEdBQUcsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLGFBQWEsRUFBRSxDQUFDLENBQUM7SUFDaEMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUMzQixDQUFDLENBQUEsQ0FBQyxDQUFDO0FBRUgsR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBTyxHQUFRLEVBQUUsR0FBUSxFQUFFLEVBQUU7SUFDN0MsTUFBTSxDQUFDLElBQUksQ0FBQyxhQUFhLEVBQUU7UUFDdkIsSUFBSSxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSTtRQUNuQixHQUFHLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHO0tBQ3BCLENBQUMsQ0FBQztJQUNILE1BQU0sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7UUFDbEMsTUFBTSxRQUFRLEdBQUcsQ0FBQyxJQUFTLEVBQUUsRUFBRTtZQUMzQixNQUFNLENBQUMsR0FBRyxDQUFDLGlCQUFpQixFQUFFLFFBQVEsQ0FBQyxDQUFDO1lBQ3hDLE1BQU0sQ0FBQyxHQUFHLENBQUMsUUFBUSxFQUFFLGdCQUFnQixDQUFDLENBQUM7WUFDdkMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ2xCLENBQUMsQ0FBQztRQUNGLE1BQU0sZ0JBQWdCLEdBQUcsQ0FBQyxJQUFTLEVBQUUsRUFBRTtZQUNuQyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3RCLENBQUMsQ0FBQztRQUNGLE1BQU0sQ0FBQyxFQUFFLENBQUMsUUFBUSxFQUFFLGdCQUFnQixDQUFDLENBQUM7UUFDdEMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxpQkFBaUIsRUFBRSxRQUFRLENBQUMsQ0FBQztJQUMzQyxDQUFDLENBQUMsQ0FBQztJQUNILEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7QUFDM0IsQ0FBQyxDQUFBLENBQUMsQ0FBQztBQUVILEdBQUcsQ0FBQyxHQUFHLENBQUMsVUFBVSxFQUFFLENBQU8sR0FBUSxFQUFFLEdBQVEsRUFBRSxFQUFFO0lBQzdDLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQztJQUVuQyxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBVyxFQUFFLEVBQUU7UUFDOUMsdUNBQ08sTUFBTSxLQUNULElBQUksRUFBRSxTQUFTLEVBQ2YsWUFBWSxFQUFFLFNBQVMsSUFDekI7SUFDTixDQUFDLENBQUMsQ0FBQztJQUNILEdBQUcsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDdEIsQ0FBQyxDQUFBLENBQUMsQ0FBQztBQUVILEdBQUcsQ0FBQyxHQUFHLENBQUMsa0JBQWtCLEVBQUUsQ0FBTyxHQUFRLEVBQUUsR0FBUSxFQUFFLEVBQUU7SUFDckQsR0FBRyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQzNDLENBQUMsQ0FBQSxDQUFDLENBQUM7QUFFSCxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFFcEUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsR0FBRyxFQUFFO0lBQ2xCLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0NBQWdDLElBQUksRUFBRSxDQUFDLENBQUM7SUFDcEQsU0FBUyxFQUFFLENBQUM7QUFDaEIsQ0FBQyxDQUFDLENBQUMifQ==