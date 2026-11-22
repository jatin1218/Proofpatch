import { build } from 'esbuild';
await Promise.all([
 build({entryPoints:['src/extension.ts'],bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode'],outfile:'dist/extension.js',sourcemap:true}),
 build({entryPoints:['webview/App.tsx'],bundle:true,platform:'browser',format:'iife',target:'es2022',outfile:'dist/webview.js',minify:true})
]);

await (await import('node:fs/promises')).copyFile('../../core/workspace/src/symbols/python-ast-worker.py','dist/python-ast-worker.py');
