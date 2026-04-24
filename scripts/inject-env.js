/**
 * Injects Netlify (or shell) env vars into app.js at build time.
 * Run before deploy: GOOGLE_CLIENT_ID=xxx node scripts/inject-env.js
 * On Netlify, set GOOGLE_CLIENT_ID in Site configuration → Environment variables.
 */
const fs = require('fs');
const path = require('path');

const appPath = path.join(__dirname, '..', 'app.js');
const swPath = path.join(__dirname, '..', 'sw.js');

let appJs = fs.readFileSync(appPath, 'utf8');
let swJs = fs.readFileSync(swPath, 'utf8');

const clientId = process.env.GOOGLE_CLIENT_ID || '';
if (!clientId && process.env.NODE_ENV === 'production') {
  console.warn('GOOGLE_CLIENT_ID is not set; YouTube upload will show a config message.');
}

// 1. Inject GOOGLE_CLIENT_ID
const escaped = clientId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
appJs = appJs.replace(/'__GOOGLE_CLIENT_ID__'/g, "'" + escaped + "'");

// 2. Inject Version (Timestamp)
const version = 'v' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14); // e.g., v20240321123045
appJs = appJs.replace(/'__APP_VERSION__'/g, "'" + version + "'");
swJs = swJs.replace(/'__CACHE_VERSION__'/g, "'" + version + "'");

fs.writeFileSync(appPath, appJs);
fs.writeFileSync(swPath, swJs);

console.log(`Injected GOOGLE_CLIENT_ID and version ${version} into app.js and sw.js`);
