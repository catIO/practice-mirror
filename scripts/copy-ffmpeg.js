const fs = require('fs');
const path = require('path');

const destDir = path.join(__dirname, '../vendor');
fs.mkdirSync(path.join(destDir, 'umd'), { recursive: true });

// @ffmpeg/core - UMD for importScripts, ESM for dynamic import fallback (module worker)
const coreUmd = path.join(__dirname, '../node_modules/@ffmpeg/core/dist/umd');
const coreEsm = path.join(__dirname, '../node_modules/@ffmpeg/core/dist/esm');
if (fs.existsSync(coreUmd)) {
  fs.copyFileSync(path.join(coreUmd, 'ffmpeg-core.js'), path.join(destDir, 'umd', 'ffmpeg-core.js'));
  fs.copyFileSync(path.join(coreUmd, 'ffmpeg-core.wasm'), path.join(destDir, 'ffmpeg-core.wasm'));
}
if (fs.existsSync(coreEsm)) {
  fs.mkdirSync(path.join(destDir, 'esm'), { recursive: true });
  fs.copyFileSync(path.join(coreEsm, 'ffmpeg-core.js'), path.join(destDir, 'esm', 'ffmpeg-core.js'));
  if (!fs.existsSync(path.join(destDir, 'ffmpeg-core.wasm'))) {
    fs.copyFileSync(path.join(coreEsm, 'ffmpeg-core.wasm'), path.join(destDir, 'ffmpeg-core.wasm'));
  }
}

// @ffmpeg/ffmpeg - main lib + worker (must be same-origin for COEP)
const ffmpegDir = path.join(__dirname, '../node_modules/@ffmpeg/ffmpeg/dist/umd');
if (fs.existsSync(ffmpegDir)) {
  fs.copyFileSync(path.join(ffmpegDir, 'ffmpeg.js'), path.join(destDir, 'ffmpeg.js'));
  fs.copyFileSync(path.join(ffmpegDir, '814.ffmpeg.js'), path.join(destDir, '814.ffmpeg.js'));
}

console.log('FFmpeg files copied to vendor/');
