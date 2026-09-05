/**
 * token-manager.js
 * -----------------
 * Keeps the Costco id_token fresh using the refresh_token grant (the same
 * call temp.js demonstrated), so the price-adjustment checker doesn't need
 * a hand-pasted idToken that dies every ~15 minutes.
 *
 * Reads/writes auth.json in place. Call getValidIdToken() before any
 * authenticated request — it only hits the network when the current
 * id_token is expired or about to be; otherwise it just returns the
 * cached one instantly.
 *
 * NOTE: auth.json holds a live ~90-day refresh token for your Costco
 * account. Treat it like a password: don't commit it to version control,
 * don't paste it anywhere else, keep it readable only by you.
 */

const fs = require('fs');
const crypto = require('crypto');

const REFRESH_BUFFER_SECONDS = 90; // refresh a bit before it actually expires

function decodeJwtPayload(jwt) {
  const payload = jwt.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function decodeClientInfo(clientInfoB64) {
  return JSON.parse(Buffer.from(clientInfoB64, 'base64url').toString('utf8'));
}

function loadAuth(authPath) {
  if (!fs.existsSync(authPath)) {
    throw new Error(
      `${authPath} not found. Run temp.js once (logged into costco.com) to bootstrap it, ` +
      `then this script will keep it fresh on its own.`
    );
  }
  return JSON.parse(fs.readFileSync(authPath, 'utf8'));
}

function saveAuth(authPath, auth) {
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
}

function isExpiringSoon(idToken) {
  const { exp } = decodeJwtPayload(idToken);
  return exp - Math.floor(Date.now() / 1000) < REFRESH_BUFFER_SECONDS;
}

// Derives the token endpoint + anchor mailbox from the current id_token /
// client_info instead of hardcoding them, so this isn't tied to one
// specific captured request.
// bugged
async function refreshTokens(auth) {
  const claims = decodeJwtPayload(auth.id_token);
  const { utid } = decodeClientInfo(auth.client_info);
  const policy = claims.acr.toLowerCase();

  const tokenUrl = `https://signin.costco.com/${utid}/${policy}/oauth2/v2.0/token`;
  const anchorMailbox = `Oid:${claims.sub}-${policy}@${utid}`;

  console.log(anchorMailbox)
  const body = new URLSearchParams({
    client_id: claims.aud,
    scope: 'openid profile offline_access',
    grant_type: 'refresh_token',
    client_info: '1',
    'x-client-SKU': 'msal.js.browser',
    'x-client-VER': '2.32.1',
    'x-ms-lib-capability': 'retry-after, h429',
    'client-request-id': crypto.randomUUID(),
    refresh_token: auth.refresh_token,
    'X-AnchorMailbox': anchorMailbox,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.5",
        "cache-control": "no-cache",
        "content-type": "application/x-www-form-urlencoded;charset=utf-8",
        "origin": "https://www.costco.com",
        "pragma": "no-cache",
        "priority": "u=1, i",
        "referer": "https://www.costco.com/",
        "sec-ch-ua": '"Brave";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Linux"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "sec-gpc": "1",
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token refresh failed: ${res.status} ${res.statusText} ${text}`.trim());
  }

  const fresh = await res.json();
  return { ...auth, ...fresh }; // fresh id_token/refresh_token/etc. win
}

/**
 * Returns a valid id_token, transparently refreshing (and persisting back
 * to auth.json) first if the current one is expired or close to it.
 */
async function getValidIdToken(authPath = './auth.json') {
  let auth = loadAuth(authPath);

  if (isExpiringSoon(auth.id_token)) {
    auth = await refreshTokens(auth);
    saveAuth(authPath, auth);
  }

  return auth.id_token;
}

module.exports = { getValidIdToken };