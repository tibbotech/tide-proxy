"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tide_proxy_1 = require("./tide-proxy");
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
    new tide_proxy_1.TIDEProxy(serverAddress, networkName);
}
else {
    console.log('use --help to view options');
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2NsaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLDZDQUF5QztBQUd6QyxJQUFJLGFBQWEsR0FBRyxFQUFFLENBQUM7QUFDdkIsSUFBSSxXQUFXLEdBQUcsV0FBVyxDQUFDO0FBRTlCLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtJQUMxQyxRQUFRLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUU7UUFDckIsS0FBSyxVQUFVO1lBQ1gsYUFBYSxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBQ3BDLE1BQU07UUFDVixLQUFLLFFBQVE7WUFDVCxXQUFXLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7WUFDbEMsTUFBTTtRQUNWLEtBQUssUUFBUTtZQUNULE9BQU8sQ0FBQyxHQUFHLENBQUMsNEJBQTRCLENBQUMsQ0FBQztZQUMxQyxNQUFNO0tBQ2I7Q0FDSjtBQUdELElBQUksYUFBYSxJQUFJLEVBQUUsRUFBRTtJQUNyQixJQUFJLHNCQUFTLENBQUMsYUFBYSxFQUFFLFdBQVcsQ0FBQyxDQUFDO0NBQzdDO0tBQ0k7SUFDRCxPQUFPLENBQUMsR0FBRyxDQUFDLDRCQUE0QixDQUFDLENBQUM7Q0FDN0MifQ==