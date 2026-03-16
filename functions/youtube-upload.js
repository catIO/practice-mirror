const https = require('https');
const url = require('url');

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks (Netlify limit is 6MB)

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'PUT') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const auth = event.headers.authorization;
  const title = event.headers['x-title'] || 'Practice recording';
  const privacy = event.headers['x-privacy'] || 'private';
  const contentType = event.headers['content-type'] || 'video/webm';
  const uploadSessionUrl = event.headers['x-upload-url'];
  const chunkOffset = parseInt(event.headers['x-chunk-offset'] || '0', 10);
  const totalSize = parseInt(event.headers['x-total-size'] || '0', 10);

  if (!auth) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing Authorization' }) };
  }

  const body = event.body
    ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')
    : null;

  // --- INIT MODE: No upload URL yet, create one ---
  if (!uploadSessionUrl) {
    const metadata = JSON.stringify({
      snippet: { title, description: 'Recorded with Practice Mirror' },
      status: { privacyStatus: privacy }
    });

    try {
      const sessionUrl = await new Promise((resolve, reject) => {
        const opts = {
          hostname: 'www.googleapis.com',
          path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
          method: 'POST',
          headers: {
            'Authorization': auth,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': contentType,
            ...(totalSize ? { 'X-Upload-Content-Length': String(totalSize) } : {}),
            'Content-Length': Buffer.byteLength(metadata, 'utf8')
          }
        };
        const req = https.request(opts, (res) => {
          if (res.statusCode !== 200) {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => reject(new Error(`Init error (${res.statusCode}): ${d}`)));
            return;
          }
          resolve(res.headers.location);
        });
        req.on('error', reject);
        req.end(metadata);
      });

      if (!sessionUrl) throw new Error('No upload URL from YouTube');

      // If body is also provided, upload the first (or only) chunk immediately
      if (body && body.length > 0) {
        const result = await uploadChunk(sessionUrl, auth, contentType, body, 0, body.length, totalSize || body.length);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadUrl: sessionUrl, chunkResult: result })
        };
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadUrl: sessionUrl })
      };
    } catch (err) {
      console.error('Init error:', err);
      return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
    }
  }

  // --- CHUNK MODE: Upload a chunk to the session URL ---
  if (!body || body.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No chunk body provided' }) };
  }

  try {
    const result = await uploadChunk(
      uploadSessionUrl, auth, contentType, body, chunkOffset,
      chunkOffset + body.length, totalSize
    );
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };
  } catch (err) {
    console.error('Chunk upload error:', err);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};

function uploadChunk(sessionUrl, auth, contentType, chunk, start, end, total) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(sessionUrl);
    const chunkEnd = end - 1; // Content-Range is inclusive
    const opts = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'PUT',
      headers: {
        'Authorization': auth,
        'Content-Type': contentType,
        'Content-Length': chunk.length,
        'Content-Range': `bytes ${start}-${chunkEnd}/${total}`
      }
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        // 308 = Resume Incomplete (more chunks needed), 200/201 = done
        if (res.statusCode === 308 || res.statusCode === 200 || res.statusCode === 201) {
          resolve({ status: res.statusCode, range: res.headers.range, body: data });
        } else {
          reject(new Error(`Chunk failed (${res.statusCode}): ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end(chunk);
  });
}
