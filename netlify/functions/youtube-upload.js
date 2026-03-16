const https = require('https');
const url = require('url');

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const auth = event.headers.authorization;
  const title = event.headers['x-title'] || 'Practice recording';
  const privacy = event.headers['x-privacy'] || 'private';
  const contentType = event.headers['content-type'] || 'video/webm';
  const body = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');

  if (!auth || !body || body.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing Authorization or body' })
    };
  }

  const metadata = JSON.stringify({
    snippet: { title, description: 'Recorded with Practice Mirror' },
    status: { privacyStatus: privacy }
  });

  try {
    // 1. Initialize Resumable Upload
    const uploadUrl = await new Promise((resolve, reject) => {
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
          initRes.on('data', (d) => data += d);
          initRes.on('end', () => reject(new Error(data || initRes.statusMessage)));
          return;
        }
        resolve(initRes.headers.location);
      });
      initReq.on('error', reject);
      initReq.end(metadata);
    });

    if (!uploadUrl) {
      throw new Error('No upload URL from YouTube');
    }

    // 2. Perform the actual binary upload (PUT)
    const parsed = url.parse(uploadUrl);
    const result = await new Promise((resolve, reject) => {
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
        let data = '';
        putRes.on('data', (d) => data += d);
        putRes.on('end', () => {
          resolve({
            statusCode: putRes.statusCode,
            headers: putRes.headers,
            body: data
          });
        });
      });
      putReq.on('error', reject);
      putReq.end(body);
    });

    return {
      statusCode: result.statusCode,
      headers: {
        'Content-Type': 'application/json'
      },
      body: result.body
    };

  } catch (err) {
    console.error('YouTube Proxy Error:', err);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message })
    };
  }
};
