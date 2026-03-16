const https = require('https');

/**
 * Netlify Function: youtube-upload
 * Step 1: Initialize a resumable upload and return the URL to the client.
 */
exports.handler = async (event) => {
  console.log('--- YouTube Upload Function Started ---');
  
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const auth = event.headers.authorization;
  const title = event.headers['x-title'] || 'Practice recording';
  const privacy = event.headers['x-privacy'] || 'private';
  const contentType = event.headers['content-type'] || 'video/webm';
  
  // FIX: Safely handle missing body
  const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : null;

  if (!auth) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing Authorization header' })
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
          'Content-Length': Buffer.byteLength(metadata, 'utf8')
        }
      };

      const initReq = https.request(initOpts, (initRes) => {
        if (initRes.statusCode !== 200) {
          let data = '';
          initRes.on('data', (d) => data += d);
          initRes.on('end', () => reject(new Error(`Google Init Error (${initRes.statusCode}): ${data}`)));
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

    // If client provided a body (local/small file), we could handle it here, 
    // but for production scalability we always return the URL for Step 2.
    if (body && body.length > 0 && body.length < 5000000) {
       // Optional: could handle small files here, but let's stick to two-step for consistency
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadUrl })
    };

  } catch (err) {
    console.error('YouTube Proxy Error:', err);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message })
    };
  }
};
