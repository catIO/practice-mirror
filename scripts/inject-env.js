/**
 * Injects Netlify (or shell) env vars into app.js at build time.
 * Run before deploy: GOOGLE_CLIENT_ID=xxx node scripts/inject-env.js
 * On Netlify, set GOOGLE_CLIENT_ID in Site configuration → Environment variables.
 */
const fs = require('fs');
const path = require('path');

const appPath = path.join(__dirname, '..', 'app.js');
let js = fs.readFileSync(appPath, 'utf8');

const clientId = process.env.GOOGLE_CLIENT_ID || '';
if (!clientId && process.env.NODE_ENV === 'production') {
  console.warn('GOOGLE_CLIENT_ID is not set; YouTube upload will show a config message.');
}
// Only replace the fallback string literal (': '__GOOGLE_CLIENT_ID__''), not the property name
const escaped = clientId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
js = js.replace(/: '__GOOGLE_CLIENT_ID__'/g, ": '" + escaped + "'");

fs.writeFileSync(appPath, js);
console.log('Injected GOOGLE_CLIENT_ID into app.js');
