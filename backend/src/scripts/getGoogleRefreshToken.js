/* eslint-disable no-console */
// One-time helper: obtain GOOGLE_REFRESH_TOKEN for Harshavardhan's Google Calendar.
// 1. Put GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in backend/.env
//    and GOOGLE_REDIRECT_URI=http://localhost:3005/oauth2callback (also add it in Google Cloud Console)
// 2. npm run google:token  → open the printed URL, sign in, approve.
// 3. Copy the printed refresh token into GOOGLE_REFRESH_TOKEN.
require('dotenv').config();
const http = require('http');
const { google } = require('googleapis');

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3005/oauth2callback';
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env first.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri);
const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // forces a refresh token to be issued
  scope: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'],
});

const { port, pathname } = new URL(redirectUri);
http.createServer(async (req, res) => {
  const u = new URL(req.url, redirectUri);
  if (u.pathname !== pathname) return res.end();
  try {
    const { tokens } = await oauth2.getToken(u.searchParams.get('code'));
    res.end('Done! You can close this tab and return to the terminal.');
    console.log('\n✅ GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
  } catch (err) {
    res.end('Error: ' + err.message);
    console.error(err);
  }
  process.exit(0);
}).listen(Number(port) || 80, () => {
  console.log('Open this URL in your browser and approve access:\n\n' + url + '\n');
});
