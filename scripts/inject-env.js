/**
 * Injects Netlify (or shell) env vars into app.js at build time.
 * Run before deploy: GOOGLE_CLIENT_ID=xxx node scripts/inject-env.js
 * On Netlify, set GOOGLE_CLIENT_ID in Site configuration → Environment variables.
 */
const fs = require('fs');
const path = require('path');

const appPath = path.join(__dirname, '..', 'app.js');
const swPath = path.join(__dirname, '..', 'sw.js');
const indexPath = path.join(__dirname, '..', 'index.html');

let appJs = fs.readFileSync(appPath, 'utf8');
let swJs = fs.readFileSync(swPath, 'utf8');
let indexHtml = fs.readFileSync(indexPath, 'utf8');

const clientId = process.env.GOOGLE_CLIENT_ID || '';
if (!clientId && process.env.NODE_ENV === 'production') {
  console.warn('GOOGLE_CLIENT_ID is not set; YouTube upload will show a config message.');
}

// 1. Inject GOOGLE_CLIENT_ID
const escaped = clientId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
appJs = appJs.replace(/(const GOOGLE_CLIENT_ID = ')[^']*(';)/, `$1${escaped}$2`);

// 2. Inject Version (Timestamp)
const version = 'v' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14); // e.g., v20240321123045
appJs = appJs.replace(/(const APP_VERSION = ')[^']*(';)/, `$1${version}$2`);
swJs = swJs.replace(/(const CACHE_NAME = ')[^']*(';)/, `$1${version}$2`);
indexHtml = indexHtml.replace(/v=[^"']+/g, `v=${version}`);

fs.writeFileSync(appPath, appJs);
fs.writeFileSync(swPath, swJs);
fs.writeFileSync(indexPath, indexHtml);

console.log(`Injected GOOGLE_CLIENT_ID and version ${version} into app.js, sw.js, and index.html`);
