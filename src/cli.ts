import { TIDEProxy } from './tide-proxy';

//get cli args
let serverAddress = '';
let networkName = 'MyNetwork';

for (let i = 0; i < process.argv.length; i++) {
    switch (process.argv[i]) {
        case '--server':
            serverAddress = process.argv[i + 1];
            break;
        case '--name':
            networkName = process.argv[i + 1];
            break;
        case '--help':
            console.log('use --help to view options');
            break;
    }
}


if (serverAddress != '') {
    new TIDEProxy(serverAddress, networkName);
}
else {
    console.log('use --help to view options');
}

