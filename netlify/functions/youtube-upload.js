const https = require('https');

/**
 * Netlify Function: youtube-upload
 * Handles Step 1 of the Resumable YouTube Upload flow: 
 * requesting a unique upload URL from Google.
 * 
 * We do NOT handle the binary data here because Netlify Functions 
 * have a 6MB payload limit. The actual binary upload happens 
 * directly from the browser to Google.
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const auth = event.headers.authorization;
  const title = event.headers['x-title'] || 'Practice recording';
  const privacy = event.headers['x-privacy'] || 'private';
  const contentType = event.headers['content-type'] || 'video/webm';

  if (!auth) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing Authorization header' })
    };
  }

  const metadata = JSON.stringify({
    snippet: { 
      title, 
      description: 'Recorded with Practice Mirror' 
    },
    status: { 
      privacyStatus: privacy 
    }
  });

  try {
    // Request a resumable upload URL from Google
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
          initRes.on('end', () => reject(new Error(data || initRes.statusMessage)));
          return;
        }
        // The unique upload URL is in the 'location' header
        resolve(initRes.headers.location);
      });
      initReq.on('error', reject);
      initReq.end(metadata);
    });

    if (!uploadUrl) {
      throw new Error('No upload URL from YouTube');
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' // Redirects already handled in netlify.toml, but good for safety
      },
      body: JSON.stringify({ uploadUrl })
    };

  } catch (err) {
    console.error('YouTube Init Error:', err);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message })
    };
  }
};
