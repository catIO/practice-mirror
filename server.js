const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.woff': 'application/font-woff',
  '.ttf': 'application/font-ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'application/font-otf',
  '.wasm': 'application/wasm'
};

function proxyYouTubeUpload(req, body, res) {
  const auth = req.headers.authorization;
  const title = req.headers['x-title'] || 'Practice recording';
  const privacy = req.headers['x-privacy'] || 'private';
  const contentType = req.headers['content-type'] || 'video/webm';

  if (!auth || !body || body.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing Authorization or body' }));
    return;
  }

  const metadata = JSON.stringify({
    snippet: { title, description: 'Recorded with Practice Mirror' },
    status: { privacyStatus: privacy }
  });

  const initOpts = {
    hostname: 'www.googleapis.com',
    path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    method: 'POST',
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': contentType,
      'X-Upload-Content-Length': String(body.length),
      'Content-Length': Buffer.byteLength(metadata, 'utf8')
    }
  };

  const initReq = https.request(initOpts, (initRes) => {
    if (initRes.statusCode !== 200) {
      let data = '';
      initRes.on('data', (chunk) => { data += chunk; });
      initRes.on('end', () => {
        res.writeHead(initRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data || initRes.statusMessage);
      });
      return;
    }

    const uploadUrl = initRes.headers.location;
    if (!uploadUrl) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No upload URL from YouTube' }));
      return;
    }

    // If client provided a body, we do the upload here (backwards compatibility).
    // If not (new two-step flow), we return the uploadUrl for the client to handle.
    if (body && body.length > 0) {
      const parsed = url.parse(uploadUrl);
      const putOpts = {
        hostname: parsed.hostname,
        path: parsed.path,
        method: 'PUT',
        headers: {
          'Authorization': auth,
          'Content-Type': contentType,
          'Content-Length': body.length
        }
      };
      const putReq = https.request(putOpts, (putRes) => {
        res.writeHead(putRes.statusCode, putRes.headers);
        putRes.pipe(res);
      });
      putReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      putReq.end(body);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ uploadUrl }));
    }
  });
  initReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
  initReq.end(metadata);
}

function serveFile(filePath, res) {
  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = MIME_TYPES[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Sorry, error: ' + error.code + '\n');
      }
    } else {
      res.writeHead(200, { 
        'Content-Type': contentType,
        'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      });
      res.end(content, extname === '.html' || extname === '.css' || extname === '.js' ? 'utf-8' : undefined);
    }
  });
}

http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (req.method === 'POST' && pathname === '/api/youtube-upload') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      proxyYouTubeUpload(req, Buffer.concat(chunks), res);
    });
    req.on('error', () => {
      res.writeHead(500);
      res.end();
    });
    return;
  }

  let filePath = '.' + (pathname === '/' ? '/index.html' : pathname);
  serveFile(filePath, res);
}).listen(8085, '127.0.0.1');
console.log('Server running at http://127.0.0.1:8085/');
