const esbuild = require('esbuild')

esbuild.build({
  entryPoints: ['src/ESP32Serial/node.ts'],
  bundle: true,
  outdir: 'lib/ESP32Serial',
  packages: 'bundle',
    platform: 'node',
    external: ['serialport'],
}).then(() => console.log('Bundle build complete'))
.catch(() => {
    process.exit(1);
});