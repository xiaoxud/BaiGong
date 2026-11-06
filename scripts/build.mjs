import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({ absWorkingDir: root, entryPoints: ['web/app.js'], bundle: true, format: 'esm', platform: 'browser',
  target: ['chrome120', 'safari17'], outfile: 'web/app.bundle.js', minify: true, legalComments: 'eof',
});
console.log('百工配置界面已构建。');
