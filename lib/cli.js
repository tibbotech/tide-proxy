"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tide_proxy_1 = require("./tide-proxy");
let serverAddress = '';
let networkName = 'MyNetwork';
const LISTEN_PORT = 3535;
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
new tide_proxy_1.TIDEProxy(serverAddress, networkName, LISTEN_PORT);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2NsaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLDZDQUF5QztBQUd6QyxJQUFJLGFBQWEsR0FBRyxFQUFFLENBQUM7QUFDdkIsSUFBSSxXQUFXLEdBQUcsV0FBVyxDQUFDO0FBQzlCLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQztBQUV6QixLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUU7SUFDMUMsUUFBUSxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFO1FBQ3JCLEtBQUssVUFBVTtZQUNYLGFBQWEsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztZQUNwQyxNQUFNO1FBQ1YsS0FBSyxRQUFRO1lBQ1QsV0FBVyxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBQ2xDLE1BQU07UUFDVixLQUFLLFFBQVE7WUFDVCxPQUFPLENBQUMsR0FBRyxDQUFDLDRCQUE0QixDQUFDLENBQUM7WUFDMUMsTUFBTTtLQUNiO0NBQ0o7QUFHRCxJQUFJLHNCQUFTLENBQUMsYUFBYSxFQUFFLFdBQVcsRUFBRSxXQUFXLENBQUMsQ0FBQyJ9