# Practice Mirror

An offline-first practice tool designed to help musicians record practice sessions for instant self-evaluations or for sharing with a teacher via direct YouTube uploads. Part of the [Practice Mate](https://practice-mate.app/) suite of tools.

---

## Key Features

- **Latency-Free Visual Feedback:** Mirror mode allows real-time study of bow positioning, hand placement, and embouchure.
- **Local Video Recording:** Capture practice sessions directly in your browser. All processing is done locally via client-side WebAssembly (FFmpeg).
- **YouTube Archiving:** Sign in via Google OAuth to upload recordings straight to your YouTube channel as private/unlisted videos.
- **Offline First (PWA):** Once loaded, the application operates fully offline, making it reliable in music rehearsal rooms without internet.

---

## Quick Start

### 1. Install Dependencies
Run the package installation script to set up local assets:
```bash
npm install
```

### 2. Configure Local Development API keys
To run Google Sign-in and YouTube Uploads locally, you must provide your Google Client ID:
1. Copy the example configuration file:
   ```bash
   cp config.local.example.js config.local.js
   ```
2. Open `config.local.js` and enter your Client ID:
   ```javascript
   window.__GOOGLE_CLIENT_ID__ = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
   ```

### 3. Start the Server
Run the local node delivery server:
```bash
npm start
```
By default, the server is available at **`http://127.0.0.1:8085/`**.
*(Note: If you run into a port-in-use error, start the server on a custom port like `PORT=8086 npm start`).*

---

## File Structure

- `index.html` — The main full-screen interactive app UI.
- `app.js` — Core application logic (camera capture, canvas render, FFmpeg orchestration, Google client uploads).
- `style.css` — Modern glassmorphic style theme variables and layouts.
- `server.js` — Development HTTP server with headers enabled for Cross-Origin-Embedder-Policy (COEP/COOP) required by WebAssembly.
- `about.html` — Explains the Practice Mate ecosystem and tools.
- `privacy.html` — Contains YouTube API usage and user data retention policies.
- `terms.html` — Houses user usage disclaimers and third-party API acknowledgements.

---

## Deployment & OAuth Verification

To successfully launch this app on Netlify with functional Google integrations:

1. **Deploy to Production:** Push your branch or run your build configuration to Netlify (refer to `netlify.toml`).
2. **Domain Verification:** 
   - Add your production URL (e.g. `https://practice-mirror.netlify.app/`) in [Google Search Console](https://search.google.com/search-console).
   - Use the **HTML meta tag** verification method. The meta tag is pre-integrated on line 7 of `index.html`.
3. **Submit Verification in GCP:**
   - Once ownership is verified in Search Console, configure the OAuth Consent Screen in your Google Cloud Project with the absolute links to your `/privacy.html` and `/terms.html`.
   - Submit for verification. The automated/manual review will check the presence of your policy links in the homepage footer.
