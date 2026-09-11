'use strict';

/* ============================================================
   Cmail — ChatOSS Mail
   A Gmail CRUD client: list, read, send, star, archive, trash.
   Auth: Google OAuth desktop flow with manual code paste.
   ============================================================ */

const SCOPES = 'https://www.googleapis.com/auth/gmail.modify';
const DEFAULT_REDIRECT = 'http://127.0.0.1:5173/';
const SECRET_CLIENT_ID = 'cmail.clientId';
const SECRET_CLIENT_SECRET = 'cmail.clientSecret';
const SECRET_REFRESH = 'cmail.refreshToken';
const STATE_KEY = 'cmail.state';

const SYSTEM_FOLDERS = [
  { id: 'INBOX', name: 'Inbox' },
  { id: 'STARRED', name: 'Starred' },
  { id: 'SENT', name: 'Sent' },
  { id: 'DRAFT', name: 'Drafts' },
  { id: 'IMPORTANT', name: 'Important' },
  { id: 'SPAM', name: 'Spam' },
  { id: 'TRASH', name: 'Trash' },
  { id: 'ALL', name: 'All Mail' },
];

let accessToken = null;
let hasRefresh = false;
let currentFolder = 'INBOX';
let pageToken = null;
let resultEstimate = 0;
let messages = [];
let currentMessage = null;
let labels = [];
let labelCounts = {};
let appVersion = null;        // filled from the manifest by checkForUpdates()
let profile = null;
let busy = false;

const $ = (id) => document.getElementById(id);

/* ---------------- encoding helpers ---------------- */

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64url(str) {
  return b64encode(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeB64url(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function encodeHeaderWord(s) {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return '=?UTF-8?B?' + b64encode(s) + '?=';
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ---------------- Gmail payload helpers ---------------- */

function getHeader(payload, name) {
  const h = ((payload && payload.headers) || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function collectParts(payload, out) {
  if (!payload) return;
  if (payload.parts && payload.parts.length) {
    for (const p of payload.parts) collectParts(p, out);
  } else {
    out.push(payload);
  }
}

function safeDecodeBody(part) {
  // Gmail API ALWAYS returns MessagePartBody.data base64url-encoded, no matter
  // what Content-Transfer-Encoding the original email had — always decode it.
  try { return decodeB64url(part.body.data); } catch (e) { return String(part.body.data || ''); }
}

function getMessageBody(message) {
  const parts = [];
  collectParts(message.payload, parts);
  const withData = parts.filter(p => p.body && p.body.data);
  // Prefer HTML (what modern emails intend you to see), fall back to plain text.
  const html = withData.find(p => p.mimeType === 'text/html');
  const text = withData.find(p => p.mimeType === 'text/plain');
  if (html) return { kind: 'html', content: safeDecodeBody(html) };
  if (text) return { kind: 'text', content: safeDecodeBody(text) };
  const any = withData[0];
  if (any) return { kind: 'text', content: safeDecodeBody(any) };
  return { kind: 'text', content: '' };
}

function getAttachments(message) {
  const parts = [];
  collectParts(message.payload, parts);
  return parts
    .filter(p => p.filename && p.filename.trim())
    .map(p => ({
      filename: p.filename,
      size: p.body ? p.body.size : 0,
      // Actual bytes live behind messages.attachments.get — body.data is empty.
      attachmentId: p.body ? p.body.attachmentId || null : null,
      mimeType: p.mimeType || 'application/octet-stream',
    }));
}

/* ---------------- HTTP ---------------- */

async function oauthTokenRequest(params) {
  const res = await window.chatoss.http.request({
    url: 'https://oauth2.googleapis.com/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (res.status !== 200) {
    let msg = 'Token request failed (HTTP ' + res.status + ')';
    try {
      const j = JSON.parse(res.body);
      if (j.error_description) msg = j.error_description;
      else if (j.error) msg = j.error;
    } catch (e) { /* keep default */ }
    throw new Error(msg);
  }
  return JSON.parse(res.body);
}

/* ---------------- credential store (keychain + scopedData fallback) ---------------- */

async function getClientId() {
  const field = $('set-client-id').value.trim();
  if (field) return field;
  const fromSecrets = await window.chatoss.secrets.get(SECRET_CLIENT_ID).catch(() => '');
  if (fromSecrets) return fromSecrets;
  const state = await window.chatoss.scopedData.get(STATE_KEY) || {};
  return state.clientId || '';
}

async function getClientSecret() {
  const field = $('set-client-secret').value.trim();
  if (field) return field;
  const fromSecrets = await window.chatoss.secrets.get(SECRET_CLIENT_SECRET).catch(() => '');
  if (fromSecrets) return fromSecrets;
  const state = await window.chatoss.scopedData.get(STATE_KEY) || {};
  return state.clientSecret || '';
}

async function getRefreshToken() {
  const fromSecrets = await window.chatoss.secrets.get(SECRET_REFRESH).catch(() => null);
  if (fromSecrets) return fromSecrets;
  const state = await window.chatoss.scopedData.get(STATE_KEY) || {};
  return state.refreshToken || null;
}

async function getRedirect() {
  const field = $('set-redirect').value.trim();
  if (field) return field;
  const state = await window.chatoss.scopedData.get(STATE_KEY) || {};
  if (state.redirect) return state.redirect;
  return DEFAULT_REDIRECT;
}

async function saveCredentials(clientId, clientSecret, redirect) {
  if (clientId) await window.chatoss.secrets.set(SECRET_CLIENT_ID, clientId).catch(() => {});
  if (clientSecret) await window.chatoss.secrets.set(SECRET_CLIENT_SECRET, clientSecret).catch(() => {});
  const state = await window.chatoss.scopedData.get(STATE_KEY) || {};
  if (clientId) state.clientId = clientId;
  if (clientSecret) state.clientSecret = clientSecret;
  if (redirect) state.redirect = redirect;
  await window.chatoss.scopedData.set(STATE_KEY, state);
}

async function saveRefreshToken(token) {
  await window.chatoss.secrets.set(SECRET_REFRESH, token).catch(() => {});
  const state = await window.chatoss.scopedData.get(STATE_KEY) || {};
  state.refreshToken = token;
  await window.chatoss.scopedData.set(STATE_KEY, state);
}

async function clearRefreshToken() {
  await window.chatoss.secrets.delete(SECRET_REFRESH).catch(() => {});
  const state = await window.chatoss.scopedData.get(STATE_KEY) || {};
  delete state.refreshToken;
  await window.chatoss.scopedData.set(STATE_KEY, state);
}

async function getAccessToken() {
  if (accessToken) return accessToken;
  const refresh = await getRefreshToken();
  if (!refresh) return null;
  const clientId = await getClientId();
  const clientSecret = await getClientSecret();
  const data = await oauthTokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refresh,
    grant_type: 'refresh_token',
  });
  accessToken = data.access_token;
  return accessToken;
}

function apiError(res) {
  let msg = 'Gmail API error (HTTP ' + res.status + ')';
  try {
    const j = JSON.parse(res.body);
    if (j.error && j.error.message) msg = j.error.message;
  } catch (e) { /* keep default */ }
  return msg;
}

async function gmailRequest(path, opts = {}) {
  const method = opts.method || 'GET';
  const doRequest = async (token) => {
    return window.chatoss.http.request({
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/' + path,
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : (method === 'POST' ? '{}' : undefined),
    });
  };
  let token = await getAccessToken();
  if (!token) throw new Error('Not connected to Gmail.');
  let res = await doRequest(token);
  if (res.status === 401) {
    accessToken = null; // force a refresh
    token = await getAccessToken();
    if (!token) throw new Error('Not connected to Gmail.');
    res = await doRequest(token);
  }
  if (res.status >= 400) throw new Error(apiError(res));
  return res.body ? JSON.parse(res.body) : null;
}

/* ---------------- auth flow ---------------- */

async function startAuth() {
  const clientId = $('set-client-id').value.trim();
  const clientSecret = $('set-client-secret').value.trim();
  const redirect = $('set-redirect').value.trim() || DEFAULT_REDIRECT;
  if (!clientId || !clientSecret) {
    setStatus('settings-status', 'Enter your OAuth Client ID and Client Secret first.', 'warn');
    return;
  }
  await saveCredentials(clientId, clientSecret, redirect);
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  $('auth-url').value = url;
  $('auth-step2').hidden = false;
  $('auth-code-url').value = '';
  try {
    await window.chatoss.openExternal.open(url);
    setStatus('settings-status', 'Sign in with Google in your browser, then paste the redirect URL below.', '');
  } catch (e) {
    setStatus('settings-status', 'Could not open your browser automatically — copy the link and open it yourself.', 'warn');
  }
}

async function finishAuth() {
  const raw = $('auth-code-url').value.trim();
  let code = null;
  let err = null;
  try {
    const u = new URL(raw);
    if (u.searchParams.get('error')) err = 'Google returned an error: ' + u.searchParams.get('error');
    else code = u.searchParams.get('code');
  } catch (e) { /* not a URL — maybe a bare code */ }
  if (!code && !err && /^[A-Za-z0-9._~\/-]+$/.test(raw) && raw.length > 10) code = raw;
  if (err) { setStatus('settings-status', err, 'warn'); return; }
  if (!code) {
    setStatus('settings-status', 'No "code" found in that URL. Paste the full address-bar URL you were redirected to.', 'warn');
    return;
  }
  const clientId = await getClientId();
  const clientSecret = await getClientSecret();
  if (!clientId || !clientSecret) {
    setStatus('settings-status', 'Client ID or Secret is missing — fill them in above and try again.', 'warn');
    return;
  }
  const redirect = await getRedirect();
  setStatus('settings-status', 'Exchanging code for tokens…');
  try {
    const data = await oauthTokenRequest({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    });
    if (data.refresh_token) await saveRefreshToken(data.refresh_token);
    accessToken = data.access_token;
    hasRefresh = true;
    $('auth-step2').hidden = true;
    $('auth-code-url').value = '';
    setStatus('settings-status', 'Connected! Loading your inbox…', 'ok');
    await afterConnect();
    setStatus('settings-status', 'Connected as ' + (profile ? profile.emailAddress : 'your account') + '.', 'ok');
  } catch (e) {
    setStatus('settings-status', 'Sign-in failed: ' + e.message, 'warn');
  }
}

async function disconnect() {
  await clearRefreshToken();
  accessToken = null;
  hasRefresh = false;
  profile = null;
  messages = [];
  currentMessage = null;
  pageToken = null;
  pageHistory = [null];
  resultEstimate = 0;
  labels = [];
  labelCounts = {};
  renderAccount();
  showList();                       // also leaves the conversation view
  renderFolders();
  renderListHead();
  $('msg-empty-title').textContent = 'No conversation selected';
  $('msg-empty-text').textContent = '';
  $('settings-connected').hidden = true;
  setStatus('settings-status', 'Disconnected. Your Client ID and Secret are kept.', '');
}

/* ---------------- data loading ---------------- */

async function afterConnect() {
  try {
    profile = await gmailRequest('profile');
    await loadLabels();
    await loadFolder(currentFolder, false);
    renderAccount();
  } catch (e) {
    setStatus('list-status', e.message, 'warn');
  }
}

async function loadLabels() {
  const data = await gmailRequest('labels');
  labels = (data.labels || []).filter(l => l.type === 'user');
  labelCounts = {};
  for (const l of data.labels || []) {
    labelCounts[l.id] = { unread: l.messagesUnread || 0, total: l.messagesTotal || 0 };
  }
  renderFolders();
}

async function loadFolder(folderId, nextPage) {
  if (busy) return;
  if (!hasRefresh) {
    setStatus('list-status', 'Connect your Gmail account first.', 'warn');
    return;
  }
  busy = true;
  setStatus('list-status', 'Loading…');
  try {
    const params = new URLSearchParams();
    params.set('maxResults', '25');
    if (folderId !== 'ALL') params.set('labelIds', folderId);
    const q = $('search-input').value.trim();
    if (q) params.set('q', q);
    if (nextPage && pageToken) params.set('pageToken', pageToken);
    const data = await gmailRequest('messages?' + params.toString());
    const ids = (data.messages || []).map(m => m.id);
    pageToken = data.nextPageToken || null;
    resultEstimate = data.resultSizeEstimate || resultEstimate;
    let details = [];
    if (ids.length) {
      // Gmail API has NO messages.batchGet endpoint (only batchDelete/batchModify)
      // — fetch each message's metadata with parallel messages.get calls.
      const results = await Promise.all(ids.map(id =>
        gmailRequest('messages/' + encodeURIComponent(id) +
          '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date')
          .catch(() => null)
      ));
      details = results.filter(Boolean);
    }
    messages = nextPage ? messages.concat(details) : details;
    renderList();
    setStatus('list-status', messages.length ? '' : 'No messages.');
  } catch (e) {
    setStatus('list-status', e.message, 'warn');
    renderListError(e.message);
  } finally {
    busy = false;
  }
}

/* ============================================================
   Cmail — Gmail-style interface layer
   Full-width conversation list and a full-width thread view
   (click a row → the thread replaces the list, ← goes back).
   Talks to the Gmail API through the helpers defined above.
   ============================================================ */

/* ---------------- icons ---------------- */

const ICON_PATHS = {
  compose: '<path d="M4 20h4l11.6-11.6a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.6 6.4l3 3"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="M20.5 20.5l-5-5"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',
  inbox: '<path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M3 13h5l2 3h4l2-3h5"/>',
  star: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  starFilled: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="currentColor" stroke="none"/>',
  send: '<path d="M21.5 3.6L2.9 11.3l6.7 2.4 2.4 6.8z"/><path d="M21.5 3.6L9.6 13.7"/>',
  draft: '<path d="M6.5 3.5h7l5 5v12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z"/><path d="M13.5 3.5v5h5"/>',
  important: '<path d="M7.5 4h9a1 1 0 0 1 1 1v15.5l-5.5-3.7-5.5 3.7V5a1 1 0 0 1 1-1z"/>',
  spam: '<path d="M8.2 3.5h7.6l4.7 4.7v7.6l-4.7 4.7H8.2l-4.7-4.7V8.2z"/><path d="M12 8v5"/><path d="M12 16.2h.01"/>',
  trash: '<path d="M4 6.8h16"/><path d="M9.5 6.8V4.6h5v2.2"/><path d="M6.6 6.8l.9 12.2a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l.9-12.2"/><path d="M10.4 10.6v6M13.6 10.6v6"/>',
  archive: '<path d="M3.5 8.5h17V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/><path d="M2.5 4.5h19v4h-19z"/><path d="M10 12.5h4"/>',
  mail: '<path d="M3.5 6.5h17v11h-17z"/><path d="M3.5 7l8.5 6.3L20.5 7"/>',
  mailOpen: '<path d="M3.5 9.8l8.5-6.1 8.5 6.1v7.7h-17z"/><path d="M3.5 9.8l8.5 6.2 8.5-6.2"/>',
  reply: '<path d="M9.5 7.5L4.5 12l5 4.5"/><path d="M4.5 12h9a6 6 0 0 1 6 6v1"/>',
  forward: '<path d="M14.5 7.5l5 4.5-5 4.5"/><path d="M19.5 12h-9a6 6 0 0 0-6 6v1"/>',
  restore: '<path d="M4.5 8.5h10.5a4.5 4.5 0 0 1 0 9H8.5"/><path d="M8 5L4.5 8.5 8 12"/>',
  settings: '<path d="M4 7.5h8M16.5 7.5H20M4 16.5h3.5M12 16.5h8"/><circle cx="14" cy="7.5" r="2.2"/><circle cx="9.5" cy="16.5" r="2.2"/>',
  label: '<path d="M3.6 4.5h8.2l8.6 8.6a1.3 1.3 0 0 1 0 1.9l-5 5a1.3 1.3 0 0 1-1.9 0L4.9 11.4a1.3 1.3 0 0 1-.4-.9z"/><path d="M7.9 8.2h.01"/>',
  labelFilled: '<path d="M3.6 4.5h8.2l8.6 8.6a1.3 1.3 0 0 1 0 1.9l-5 5a1.3 1.3 0 0 1-1.9 0L4.9 11.4a1.3 1.3 0 0 1-.4-.9z" fill="currentColor" stroke="none"/>' +
    '<circle cx="8" cy="8.3" r="1.15" fill="#fff" stroke="none"/>',
  paperclip: '<path d="M19.5 11.6l-8.2 8.2a4.9 4.9 0 0 1-6.9-6.9l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7"/>',
  chevron: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  back: '<path d="M20 12H5"/><path d="M11.5 5.5L5 12l6.5 6.5"/>',
  chevronLeft: '<path d="M14.5 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
};

function svgIcon(name) {
  const p = ICON_PATHS[name];
  if (!p) return '';
  return '<svg class="cm-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
}

function paintIcons(root) {
  (root || document).querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = svgIcon(el.getAttribute('data-icon'));
  });
}

function setIcon(el, name) {
  if (!el) return;
  el.dataset.icon = name;
  el.innerHTML = svgIcon(name);
}

/* ---------------- avatars ---------------- */

const AVATAR_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#00838f', '#c5221f', '#6a1b9a'];

function hashString(s) {
  const str = String(s || '');
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function avatarColor(seed) {
  return AVATAR_COLORS[hashString(seed) % AVATAR_COLORS.length];
}

function avatarInitial(name, email) {
  const s = String(name || email || '?').trim();
  return (s.charAt(0) || '?').toUpperCase();
}

function paintAvatar(el, name, email) {
  if (!el) return;
  el.textContent = avatarInitial(name, email);
  el.style.background = avatarColor(email || name);
}

/* ---------------- address + date parsing ---------------- */

function parseFrom(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].replace(/^["']|["']$/g, '').trim();
    return { name: name || m[2], email: m[2] };
  }
  return { name: s || '(no sender)', email: /@/.test(s) ? s : '' };
}

function isMine(email) {
  return !!(profile && email &&
    String(email).toLowerCase() === String(profile.emailAddress || '').toLowerCase());
}

function displayName(address) {
  const p = parseFrom(address);
  return isMine(p.email) ? 'me' : p.name;
}

function toLine(raw) {
  const list = String(raw || '').split(',').map((x) => x.trim()).filter(Boolean).map(displayName);
  if (!list.length) return 'me';
  if (list.length > 3) return list.slice(0, 3).join(', ') + ' and ' + (list.length - 3) + ' more';
  return list.join(', ');
}

function gmailDate(raw) {
  const d = new Date(raw);
  if (!raw || isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}

function fullDate(raw) {
  const d = new Date(raw);
  if (!raw || isNaN(d.getTime())) return '';
  return d.toLocaleString([], {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/* ---------------- quoting for replies ---------------- */

function htmlToText(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    doc.querySelectorAll('script,style,head').forEach((n) => n.remove());
    return (doc.body ? doc.body.textContent : '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (e) {
    return '';
  }
}

function quoteText(msg, from) {
  const body = getMessageBody(msg);
  const raw = body.kind === 'html' ? htmlToText(body.content) : body.content;
  const lines = String(raw || '').split('\n').slice(0, 40).map((l) => '> ' + l);
  const when = fullDate(getHeader(msg.payload, 'Date'));
  const who = from.name || from.email || 'you';
  return '\n\nOn ' + (when || 'an earlier date') + ', ' + who + ' wrote:\n' +
    (lines.length ? lines.join('\n') : '>');
}

function replySubject(subject) {
  const s = String(subject || '').trim();
  return /^re:/i.test(s) ? s : 'Re: ' + (s || '(no subject)');
}

function forwardSubject(subject) {
  const s = String(subject || '').trim();
  return /^fwd?:/i.test(s) ? s : 'Fwd: ' + (s || '(no subject)');
}

/* ---------------- state ---------------- */

const PAGE_SIZE = 25;          // matches maxResults in loadFolder()
let pageHistory = [null];      // token used to fetch each visited page (page 1 = none)
let focusedId = null;          // keyboard cursor (a thread id)
let selectedThreadId = null;   // last opened conversation, highlighted on return
let currentThread = null;      // { id, threadId, messages: [full messages, oldest first] }
let expandedIds = {};          // message id → expanded in the thread view
let readTimer = null;          // Gmail marks a conversation read shortly after you open it
let composeMode = 'new';
let composeThreadId = null;
let composeReferences = null;
let sendAnyway = false;      // set once the user confirms an empty-body send

/* ---------------- account + folders ---------------- */

function renderAccount() {
  const av = $('account-avatar');
  const emailEl = $('account-email');
  const subEl = $('account-status');
  if (profile) {
    paintAvatar(av, '', profile.emailAddress);
    emailEl.textContent = profile.emailAddress;
    emailEl.title = profile.emailAddress;
    subEl.textContent = 'Manage account';
  } else if (hasRefresh) {
    av.textContent = '\u2026';
    av.style.background = 'var(--muted)';
    emailEl.textContent = 'Connected';
    emailEl.title = '';
    subEl.textContent = 'Loading\u2026';
  } else {
    av.textContent = '?';
    av.style.background = 'var(--muted)';
    emailEl.textContent = 'Not connected';
    emailEl.title = '';
    subEl.textContent = 'Connect Gmail\u2026';
  }
  subEl.className = 'cm-account-sub' + (hasRefresh ? '' : ' is-cta');
}

const FOLDER_ICONS = {
  INBOX: 'inbox', STARRED: 'star', SENT: 'send', DRAFT: 'draft',
  IMPORTANT: 'important', SPAM: 'spam', TRASH: 'trash', ALL: 'mail',
};

function folderName(id) {
  const sys = SYSTEM_FOLDERS.find((f) => f.id === id);
  if (sys) return sys.name;
  const l = labels.find((x) => x.id === id);
  return l ? l.name : id;
}

function safeColor(c) {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : null;
}

function renderFolders() {
  const el = $('folder-list');
  el.innerHTML = '';
  const add = (id, name, iconName, color) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cm-nav-item' + (id === currentFolder ? ' is-selected' : '') +
      (color ? ' is-labeled' : '');
    const icon = color
      ? '<span class="cm-nav-icon" style="color:' + color + '">' + svgIcon('labelFilled') + '</span>'
      : '<span class="cm-nav-icon">' + svgIcon(iconName) + '</span>';
    b.innerHTML = icon +
      '<span class="cm-nav-label truncate"></span><span class="cm-nav-count"></span>';
    b.querySelector('.cm-nav-label').textContent = name;
    const c = labelCounts[id];
    if (c && c.unread > 0) {
      b.querySelector('.cm-nav-count').textContent = c.unread > 999 ? '999+' : String(c.unread);
    }
    b.onclick = () => selectFolder(id);
    el.appendChild(b);
  };
  for (const f of SYSTEM_FOLDERS) add(f.id, f.name, FOLDER_ICONS[f.id] || 'mail', null);
  const sep = document.createElement('div');
  sep.className = 'cm-nav-sep';
  sep.textContent = 'Labels';
  el.appendChild(sep);
  if (hasRefresh) {
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'cm-nav-item cm-nav-create';
    create.innerHTML = '<span class="cm-nav-icon">' + svgIcon('plus') + '</span>' +
      '<span class="cm-nav-label">Create new label</span>';
    create.onclick = openNewLabel;
    el.appendChild(create);
  }
  for (const l of labels) add(l.id, l.name, 'label', safeColor(l.color && l.color.backgroundColor));
}

function renderListHead() {
  $('list-title').textContent = folderName(currentFolder);
  const c = labelCounts[currentFolder];
  $('list-count').textContent = c && c.unread > 0 ? c.unread + ' unread' : '';
}

function showList() {
  if (readTimer) { clearTimeout(readTimer); readTimer = null; }
  currentThread = null;
  currentMessage = null;
  $('thread-view').hidden = true;
  $('list-view').hidden = false;
  renderList();
  renderPagination();
}

function selectFolder(id) {
  currentFolder = id;
  pageToken = null;
  pageHistory = [null];
  selectedThreadId = null;
  focusedId = null;
  messages = [];
  showList();
  renderFolders();
  renderListHead();
  showSkeleton();
  loadFolder(id, false);
}

/* ---------------- list rendering (one row per conversation) ---------------- */

function showSkeleton() {
  const el = $('msg-list');
  el.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const row = document.createElement('div');
    row.className = 'cm-skel-row';
    row.innerHTML = '<span class="cm-skel cm-skel-a"></span><span class="cm-skel cm-skel-b"></span>';
    el.appendChild(row);
  }
  el.scrollTop = 0;
}

function emptyState(iconName, title, text) {
  const box = document.createElement('div');
  box.className = 'cm-empty';
  box.innerHTML = '<div class="cm-empty-art">' + svgIcon(iconName) + '</div>' +
    '<div class="cm-empty-title"></div><div class="cm-empty-text"></div>';
  box.querySelector('.cm-empty-title').textContent = title;
  box.querySelector('.cm-empty-text').textContent = text;
  return box;
}

function connectEmptyState() {
  const box = emptyState('mail', 'Connect your Gmail', 'Sign in once and Cmail keeps your inbox in sync.');
  const wrap = document.createElement('div');
  wrap.className = 'cm-empty-actions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary';
  btn.textContent = 'Connect Gmail\u2026';
  btn.onclick = openSettings;
  wrap.appendChild(btn);
  box.appendChild(wrap);
  return box;
}

/* Gmail's list is a list of CONVERSATIONS: messages sharing a threadId
   collapse into one row showing the participants and the message count. */
function threadGroups() {
  const map = new Map();
  for (const m of messages) {
    const key = m.threadId || m.id;
    let g = map.get(key);
    if (!g) {
      g = { id: key, threadId: m.threadId || null, messages: [] };
      map.set(key, g);
    }
    g.messages.push(m);
  }
  const groups = Array.from(map.values());
  // The list API returns newest-first, but do not rely on that: sort each group
  // explicitly so messages[0] is ALWAYS the newest message of the conversation —
  // the row's sender, subject, snippet, date and read state all come from it.
  for (const g of groups) {
    g.messages.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0));
  }
  return groups;
}

function groupUnread(g) { return g.messages.some((m) => (m.labelIds || []).includes('UNREAD')); }
function groupStarred(g) { return g.messages.some((m) => (m.labelIds || []).includes('STARRED')); }
function groupIds(g) { return g.messages.map((m) => m.id); }

function groupSenderLabel(g) {
  const names = [];
  for (const m of g.messages) {
    const n = displayName(getHeader(m.payload, 'From'));
    if (n && names.indexOf(n) === -1) names.push(n);
    if (names.length >= 3) break;
  }
  return names.join(', ') || '(no sender)';
}

function renderList() {
  const el = $('msg-list');
  el.innerHTML = '';
  if (!hasRefresh) {
    el.appendChild(connectEmptyState());
    renderPagination();
    return;
  }
  const groups = threadGroups();
  if (!groups.length) {
    el.appendChild(emptyState('mail', 'Nothing here',
      'There are no conversations in ' + folderName(currentFolder) + '.'));
    renderPagination();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const g of groups) frag.appendChild(buildRow(g));
  el.appendChild(frag);
  renderPagination();
}

function renderListError(message) {
  const el = $('msg-list');
  el.innerHTML = '';
  el.appendChild(emptyState('spam', 'Could not load mail', message));
  renderPagination();
}

function buildRow(g) {
  const newest = g.messages[0];
  const unread = groupUnread(g);
  const starred = groupStarred(g);
  const subject = getHeader(newest.payload, 'Subject') || '(no subject)';
  const row = document.createElement('div');
  row.className = 'cm-row' + (unread ? ' is-unread' : '') +
    (g.id === selectedThreadId ? ' is-selected' : '') +
    (g.id === focusedId ? ' is-focused' : '');
  row.dataset.id = g.id;
  row.innerHTML =
    '<button type="button" class="cm-star' + (starred ? ' is-starred' : '') + '" ' +
      'title="' + (starred ? 'Remove star' : 'Star') + '">' + svgIcon(starred ? 'starFilled' : 'star') + '</button>' +
    '<span class="cm-sender truncate"></span>' +
    '<span class="cm-count"></span>' +
    '<span class="cm-line truncate">' +
      '<span class="cm-subject"></span><span class="cm-snippet"></span>' +
    '</span>' +
    '<span class="cm-row-date"></span>' +
    '<div class="cm-row-actions">' +
      '<button type="button" class="cm-row-act" data-act="archive" title="Archive">' + svgIcon('archive') + '</button>' +
      '<button type="button" class="cm-row-act" data-act="trash" title="Delete">' + svgIcon('trash') + '</button>' +
      '<button type="button" class="cm-row-act" data-act="read" title="' +
        (unread ? 'Mark as read' : 'Mark as unread') + '">' + svgIcon(unread ? 'mailOpen' : 'mail') + '</button>' +
    '</div>';
  row.querySelector('.cm-sender').textContent = groupSenderLabel(g);
  if (g.messages.length > 1) row.querySelector('.cm-count').textContent = String(g.messages.length);
  row.querySelector('.cm-row-date').textContent = gmailDate(getHeader(newest.payload, 'Date'));
  row.querySelector('.cm-subject').textContent = subject;
  row.querySelector('.cm-snippet').textContent = newest.snippet ? ' - ' + newest.snippet : '';
  row.onclick = () => openThread(g.id);
  row.querySelector('.cm-star').onclick = (e) => {
    e.stopPropagation();
    toggleStarGroup(g);
  };
  row.querySelectorAll('.cm-row-act').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'archive') archiveGroup(g);
      else if (act === 'trash') trashGroup(g);
      else toggleReadGroup(g);
    };
  });
  return row;
}

function markFocusedRow() {
  document.querySelectorAll('#msg-list .cm-row').forEach((r) => {
    r.classList.toggle('is-focused', r.dataset.id === focusedId);
  });
}

/* ---------------- pagination (Gmail's “1–25 of N” bar) ---------------- */

function renderPagination() {
  const rangeEl = $('page-range');
  if (!rangeEl) return;
  const offset = (pageHistory.length - 1) * PAGE_SIZE;
  if (!messages.length) {
    rangeEl.textContent = '';
  } else {
    const to = offset + messages.length;
    rangeEl.textContent = (offset + 1) + '\u2013' + to +
      (resultEstimate ? ' of ' + resultEstimate.toLocaleString() : '');
  }
  // loadFolder renders the list while `busy` is still true, so busy must not
  // gate the arrows here — "Older" would stay disabled after every load.
  $('btn-newer').disabled = pageHistory.length < 2;
  $('btn-older').disabled = !pageToken;
}

async function goOlderPage() {
  if (!pageToken || busy) return;
  pageHistory.push(pageToken);
  messages = [];                 // each page replaces the last, like Gmail
  showSkeleton();
  await loadFolder(currentFolder, true);
}

async function goNewerPage() {
  if (pageHistory.length < 2 || busy) return;
  pageHistory.pop();
  pageToken = pageHistory[pageHistory.length - 1];
  messages = [];
  showSkeleton();
  await loadFolder(currentFolder, true);
}

/* ---------------- thread view ---------------- */

function showThreadPlaceholder(title, text) {
  $('msg-view').hidden = true;
  $('msg-empty').hidden = false;
  $('msg-empty-title').textContent = title;
  $('msg-empty-text').textContent = text || '';
}

function threadOpen() {
  return currentThread && !$('thread-view').hidden;
}

function openGroup() {
  if (!currentThread) return null;
  return { id: currentThread.id, threadId: currentThread.threadId, messages: currentThread.messages };
}

/* The NEWEST message of the open conversation: the one that represents the
   thread's current state (chips), the one reply/forward target, and the one
   Gmail expands when a conversation opens. */
function latestMessage() {
  if (!currentThread || !currentThread.messages.length) return null;
  return currentThread.messages[currentThread.messages.length - 1];
}

/* Gmail shows a conversation's subject without its Re:/Fwd: prefixes. A reply
   can also arrive with an EMPTY subject while the thread has one, so walk from
   the newest message back until a real subject turns up — taking it from the
   oldest message showed "(no subject)" for threads whose first mail had none. */
function stripSubjectPrefixes(s) {
  let out = String(s || '');
  let prev;
  do {
    prev = out;
    out = out.replace(/^\s*(re|fwd|fw)\s*:\s*/i, '');
  } while (out && out !== prev);
  return out.trim();
}

function threadSubject() {
  if (!currentThread) return '(no subject)';
  let fallback = '';
  for (let i = currentThread.messages.length - 1; i >= 0; i--) {
    const raw = getHeader(currentThread.messages[i].payload, 'Subject');
    if (!raw || !raw.trim()) continue;
    const stripped = stripSubjectPrefixes(raw);
    if (stripped) return stripped;          // a subject with real content wins
    if (!fallback) fallback = raw.trim();
  }
  return fallback || '(no subject)';
}

/* A conversation's labels are the union of its messages' labels — the thread
   lives in the inbox even when the newest message is one you sent. */
function threadLabelIds() {
  const out = [];
  if (!currentThread) return out;
  for (const m of currentThread.messages) {
    for (const id of (m.labelIds || [])) {
      if (out.indexOf(id) === -1) out.push(id);
    }
  }
  return out;
}

async function openThread(threadId) {
  selectedThreadId = threadId;
  focusedId = threadId;
  $('list-view').hidden = true;
  $('thread-view').hidden = false;
  showThreadPlaceholder('Loading conversation\u2026', '');
  if (readTimer) { clearTimeout(readTimer); readTimer = null; }
  try {
    const t = await gmailRequest('threads/' + encodeURIComponent(threadId) + '?format=full');
    const list = (t.messages || []).slice().sort((a, b) =>
      (Number(a.internalDate || 0) - Number(b.internalDate || 0)));
    currentThread = { id: threadId, threadId, messages: list };
    currentMessage = latestMessage();
    // Gmail opens a conversation with its NEWEST message expanded and the older
    // ones collapsed — expanding the oldest hid the mail you just received
    // behind a collapsed row.
    expandedIds = {};
    if (currentMessage) expandedIds[currentMessage.id] = true;
    renderThread();
    scheduleMarkRead();
  } catch (e) {
    showThreadPlaceholder('Could not open conversation', e.message);
  }
}

function scheduleMarkRead() {
  const unread = currentThread.messages.filter((m) => (m.labelIds || []).includes('UNREAD'));
  if (!unread.length) return;
  const tid = currentThread.id;
  readTimer = setTimeout(async () => {
    readTimer = null;
    if (!currentThread || currentThread.id !== tid) return;
    try {
      if (currentThread.threadId) {
        await gmailRequest('threads/' + encodeURIComponent(tid) + '/modify', {
          method: 'POST', body: { removeLabelIds: ['UNREAD'] },
        });
      } else {
        await Promise.all(unread.map((m) => gmailRequest(
          'messages/' + encodeURIComponent(m.id) + '/modify',
          { method: 'POST', body: { removeLabelIds: ['UNREAD'] } })));
      }
      applyLabelsToIds(unread.map((m) => m.id), [], ['UNREAD'], false);
    } catch (e) { /* not fatal — the row just stays bold */ }
  }, 1500);
}

const CHIP_LABELS = {
  INBOX: 'Inbox', IMPORTANT: 'Important', STARRED: 'Starred', SENT: 'Sent',
  DRAFT: 'Draft', SPAM: 'Spam', TRASH: 'Trash',
};

function renderChips(m, labelIds) {
  const el = $('msg-chips');
  el.innerHTML = '';
  const names = [];
  const from = parseFrom(getHeader(m.payload, 'From'));
  const myDomain = profile && profile.emailAddress ? String(profile.emailAddress).split('@')[1] : '';
  const theirDomain = from.email ? from.email.split('@')[1] : '';
  if (myDomain && theirDomain && theirDomain.toLowerCase() !== myDomain.toLowerCase()) {
    names.push('External');
  }
  for (const id of (labelIds || m.labelIds || [])) {
    if (id === 'UNREAD' || id.indexOf('CATEGORY_') === 0) continue;
    const userLabel = labels.find((l) => l.id === id);
    const n = CHIP_LABELS[id] || (userLabel ? userLabel.name : null);
    if (n && names.indexOf(n) === -1) names.push(n);
    if (names.length >= 5) break;
  }
  for (const n of names) {
    const chip = document.createElement('span');
    chip.className = 'cm-chip' + (n === 'External' ? ' is-warn' : '');
    chip.textContent = n;
    el.appendChild(chip);
  }
  el.hidden = !names.length;
}

function renderThread() {
  if (!currentThread || !currentThread.messages.length) {
    showThreadPlaceholder('This conversation is empty', '');
    return;
  }
  const msgs = currentThread.messages;
  const latest = latestMessage() || msgs[0];   // the thread's current state
  $('msg-empty').hidden = true;
  $('msg-view').hidden = false;

  $('thread-subject').textContent = threadSubject();
  renderChips(latest, threadLabelIds());

  const inTrash = msgs.some((m) => (m.labelIds || []).includes('TRASH'));
  const unread = msgs.some((m) => (m.labelIds || []).includes('UNREAD'));
  $('btn-archive').hidden = inTrash;
  $('btn-trash').hidden = inTrash;
  $('btn-untrash').hidden = !inTrash;
  setIcon($('btn-read'), unread ? 'mailOpen' : 'mail');
  $('btn-read').title = unread ? 'Mark as read' : 'Mark as unread';

  const wrap = $('thread-messages');
  wrap.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const m of msgs) frag.appendChild(buildThreadMessage(m));
  wrap.appendChild(frag);
  wrap.scrollTop = 0;
  // Open at the newest message (Gmail does the same): in a long thread the
  // expanded message sits below the fold, so bring it into view.
  const newestEl = wrap.lastElementChild;
  if (newestEl) newestEl.scrollIntoView({ block: 'nearest' });
}

function buildThreadMessage(m) {
  const from = parseFrom(getHeader(m.payload, 'From'));
  const starred = (m.labelIds || []).includes('STARRED');
  const expanded = !!expandedIds[m.id];
  const el = document.createElement('div');
  el.className = 'cm-th-msg' + (expanded ? ' is-expanded' : '');
  el.dataset.id = m.id;
  el.innerHTML =
    '<div class="cm-th-head">' +
      '<span class="cm-avatar cm-avatar-sm"></span>' +
      '<span class="cm-th-line">' +
        '<span class="cm-th-name"></span>' +
        '<span class="cm-th-to"></span>' +
        '<span class="cm-th-snippet truncate"></span>' +
      '</span>' +
      '<span class="cm-th-date"></span>' +
      '<button type="button" class="cm-icon-btn cm-icon-btn-sm cm-th-star" title="' +
        (starred ? 'Remove star' : 'Star') + '"></button>' +
      '<button type="button" class="cm-icon-btn cm-icon-btn-sm cm-th-reply" title="Reply">' +
        svgIcon('reply') + '</button>' +
    '</div>' +
    '<div class="cm-th-content"></div>';

  paintAvatar(el.querySelector('.cm-avatar'), from.name, from.email);
  el.querySelector('.cm-th-name').textContent = from.name;
  el.querySelector('.cm-th-to').textContent = 'to ' + toLine(getHeader(m.payload, 'To'));
  el.querySelector('.cm-th-snippet').textContent = m.snippet || '';
  const dateRaw = getHeader(m.payload, 'Date');
  el.querySelector('.cm-th-date').textContent = fullDate(dateRaw);
  el.querySelector('.cm-th-date').title = dateRaw || '';
  setIcon(el.querySelector('.cm-th-star'), starred ? 'starFilled' : 'star');
  el.querySelector('.cm-th-star').classList.toggle('is-starred', starred);

  el.querySelector('.cm-th-star').onclick = (e) => {
    e.stopPropagation();
    toggleMessageStar(m);
  };
  el.querySelector('.cm-th-reply').onclick = (e) => {
    e.stopPropagation();
    openCompose('reply', m);
  };
  const content = el.querySelector('.cm-th-content');
  // Bodies are built lazily: a collapsed message must not spin up an iframe
  // (and pull its remote images) until the reader actually opens it.
  const fillContent = () => {
    if (content.dataset.filled) return;
    content.dataset.filled = '1';
    const body = getMessageBody(m);
    if (body.kind === 'html') {
      const frame = document.createElement('iframe');
      frame.className = 'cm-th-iframe';
      // sandbox (no allow-scripts) keeps email HTML from ever reaching the
      // ChatOSS bridge; the cost is that its height cannot be measured, so
      // tall messages scroll inside the frame.
      frame.setAttribute('sandbox', '');
      frame.setAttribute('title', 'Message body');
      frame.srcdoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
        'html{color-scheme:light}' +
        'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;' +
        'line-height:1.6;color:#1a1a1a;background:#fff;margin:20px;overflow-wrap:break-word;word-wrap:break-word}' +
        'img{max-width:100%;height:auto}table{max-width:100%}a{color:#1a73e8}' +
        '</style></head><body>' + body.content + '</body></html>';
      content.appendChild(frame);
    } else {
      const pre = document.createElement('div');
      pre.className = 'cm-th-text';
      pre.textContent = body.content || '(This message has no body.)';
      content.appendChild(pre);
    }
    const atts = getAttachments(m);
    if (atts.length) {
      const attEl = document.createElement('div');
      attEl.className = 'cm-th-atts';
      for (const a of atts) {
        const card = document.createElement('div');
        card.className = 'cm-att';
        card.title = a.filename;
        card.innerHTML = '<span class="cm-att-ic">' + svgIcon('paperclip') + '</span>' +
          '<span class="cm-att-name truncate"></span><span class="cm-att-size"></span>';
        card.querySelector('.cm-att-name').textContent = a.filename;
        card.querySelector('.cm-att-size').textContent = a.size ? formatSize(a.size) : '';
        card.title = a.filename + ' \u2014 click to save it to ChatOSS Drive';
        card.onclick = () => downloadAttachment(m, a, card);
        attEl.appendChild(card);
      }
      content.appendChild(attEl);
    }
  };

  el.querySelector('.cm-th-head').onclick = () => {
    expandedIds[m.id] = !expandedIds[m.id];
    const isOpen = !!expandedIds[m.id];
    el.classList.toggle('is-expanded', isOpen);
    if (isOpen) {
      fillContent();
      content.scrollIntoView({ block: 'nearest' });
    }
  };

  if (expanded) fillContent();
  return el;
}

function setStatus(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'statusline' + (kind === 'warn' ? ' status-warn' : kind === 'ok' ? ' status-ok' : '');
}

/* Gmail's bottom-left toast. The statuslines live inside the list view, so
   actions taken from the conversation view need their own feedback. */
let toastTimer = null;

function showToast(text, isError) {
  const el = $('cm-toast');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-error', !!isError);
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; toastTimer = null; }, 4200);
}

/* ---------------- actions (thread level, like Gmail) ---------------- */

function reloadList() {
  return loadFolder(currentFolder, false);
}

function applyLabelsToIds(ids, add, remove, rerenderThread) {
  const set = new Set(ids);
  const apply = (m) => {
    if (!m || !set.has(m.id)) return;
    const s = new Set(m.labelIds || []);
    (add || []).forEach((l) => s.add(l));
    (remove || []).forEach((l) => s.delete(l));
    m.labelIds = Array.from(s);
  };
  messages.forEach(apply);
  if (currentThread) currentThread.messages.forEach(apply);
  renderList();
  if (rerenderThread !== false && threadOpen()) renderThread();
}

function dropIdsFromList(ids) {
  const set = new Set(ids);
  const before = messages.length;
  messages = messages.filter((m) => !set.has(m.id));
  if (before === messages.length) return;
  if (set.has(focusedId)) focusedId = null;
  renderList();
}

function adjustUnreadCounts(msgs, wasUnread, nowUnread) {
  if (wasUnread === nowUnread) return;
  const delta = (nowUnread ? 1 : -1) * msgs.length;
  const touched = new Set();
  for (const m of msgs) for (const id of (m.labelIds || [])) touched.add(id);
  for (const id of touched) {
    const c = labelCounts[id];
    if (c) c.unread = Math.max(0, (c.unread || 0) + delta);
  }
  renderFolders();
  renderListHead();
}

function groupModify(g, add, remove) {
  if (g.threadId) {
    return gmailRequest('threads/' + encodeURIComponent(g.threadId) + '/modify', {
      method: 'POST', body: { addLabelIds: add, removeLabelIds: remove },
    });
  }
  return Promise.all(g.messages.map((m) => gmailRequest(
    'messages/' + encodeURIComponent(m.id) + '/modify',
    { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } })));
}

function groupTrash(g, untrash) {
  const verb = untrash ? 'untrash' : 'trash';
  if (g.threadId) {
    return gmailRequest('threads/' + encodeURIComponent(g.threadId) + '/' + verb, { method: 'POST' });
  }
  return Promise.all(g.messages.map((m) => gmailRequest(
    'messages/' + encodeURIComponent(m.id) + '/' + verb, { method: 'POST' })));
}

async function toggleStarGroup(g) {
  const starred = groupStarred(g);
  const add = starred ? [] : ['STARRED'];
  const remove = starred ? ['STARRED'] : [];
  applyLabelsToIds(groupIds(g), add, remove);
  try {
    await groupModify(g, add, remove);
  } catch (e) {
    setStatus('list-status', e.message, 'warn');
    applyLabelsToIds(groupIds(g), remove, add);
  }
}

async function toggleMessageStar(m) {
  const starred = (m.labelIds || []).includes('STARRED');
  const add = starred ? [] : ['STARRED'];
  const remove = starred ? ['STARRED'] : [];
  applyLabelsToIds([m.id], add, remove);
  try {
    await gmailRequest('messages/' + encodeURIComponent(m.id) + '/modify', {
      method: 'POST', body: { addLabelIds: add, removeLabelIds: remove },
    });
  } catch (e) {
    setStatus('list-status', e.message, 'warn');
    applyLabelsToIds([m.id], remove, add);
  }
}

async function toggleReadGroup(g) {
  const unread = groupUnread(g);
  const add = unread ? [] : ['UNREAD'];
  const remove = unread ? ['UNREAD'] : [];
  applyLabelsToIds(groupIds(g), add, remove);
  adjustUnreadCounts(g.messages, unread, !unread);
  try {
    await groupModify(g, add, remove);
  } catch (e) {
    setStatus('list-status', e.message, 'warn');
    applyLabelsToIds(groupIds(g), remove, add);
    adjustUnreadCounts(g.messages, !unread, unread);
  }
}

async function archiveGroup(g) {
  const open = currentThread && currentThread.id === g.id;
  if (currentFolder === 'INBOX') dropIdsFromList(groupIds(g));
  else applyLabelsToIds(groupIds(g), [], ['INBOX']);
  if (open) showList();
  try {
    await groupModify(g, [], ['INBOX']);
    setStatus('list-status', 'Conversation archived.');
  } catch (e) {
    setStatus('list-status', e.message, 'warn');
    reloadList();
  }
}

async function trashGroup(g) {
  const open = currentThread && currentThread.id === g.id;
  if (currentFolder !== 'TRASH') dropIdsFromList(groupIds(g));
  if (open) showList();
  try {
    await groupTrash(g, false);
    setStatus('list-status', 'Conversation moved to Trash.');
  } catch (e) {
    setStatus('list-status', e.message, 'warn');
    reloadList();
  }
}

async function untrashGroup(g) {
  try {
    await groupTrash(g, true);
    if (currentFolder === 'TRASH') {
      dropIdsFromList(groupIds(g));
      showList();
    } else {
      applyLabelsToIds(groupIds(g), [], ['TRASH']);
    }
    setStatus('list-status', 'Conversation restored to your inbox.');
  } catch (e) {
    setStatus('list-status', e.message, 'warn');
  }
}

/* ---------------- labels (create + apply) ---------------- */

/* Gmail accepts label colors only from its own fixed palette, and only in the
   combinations its picker offers — an invalid pair fails labels.create with a
   400. The pairs below are Gmail's own, verified against the live API. */
const LABEL_COLORS = [
  { name: 'Red', text: '#ffffff', bg: '#fb4c2f' },
  { name: 'Orange', text: '#ffffff', bg: '#ffad47' },
  { name: 'Green', text: '#ffffff', bg: '#16a766' },
  { name: 'Teal', text: '#ffffff', bg: '#43d692' },
  { name: 'Blue', text: '#ffffff', bg: '#4a86e8' },
  { name: 'Purple', text: '#ffffff', bg: '#a479e2' },
  { name: 'Pink', text: '#ffffff', bg: '#f691b3' },
  { name: 'Gray', text: '#ffffff', bg: '#666666' },
];

let newLabelColor = null;

function openNewLabel() {
  $('newlabel-name').value = '';
  setStatus('newlabel-status', '');
  newLabelColor = null;
  renderSwatches();
  $('newlabel-modal').hidden = false;
  setTimeout(() => $('newlabel-name').focus(), 0);
}

function renderSwatches() {
  const el = $('newlabel-colors');
  el.innerHTML = '';
  const mk = (bg, name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cm-swatch' + (newLabelColor === bg ? ' is-selected' : '') + (bg ? '' : ' is-none');
    b.title = name;
    if (bg) b.style.background = bg;
    else b.textContent = '\u00d7';
    b.onclick = () => { newLabelColor = bg; renderSwatches(); };
    el.appendChild(b);
  };
  mk(null, 'No color');
  for (const c of LABEL_COLORS) mk(c.bg, c.name);
}

async function createLabel() {
  const name = $('newlabel-name').value.trim();
  if (!name) {
    setStatus('newlabel-status', 'Give the label a name.', 'warn');
    $('newlabel-name').focus();
    return;
  }
  if (labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
    setStatus('newlabel-status', 'You already have a label called \u201c' + name + '\u201d.', 'warn');
    return;
  }
  const btn = $('newlabel-create');
  btn.disabled = true;
  setStatus('newlabel-status', 'Creating\u2026');
  const body = { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' };
  const color = LABEL_COLORS.find((c) => c.bg === newLabelColor);
  if (color) body.color = { textColor: color.text, backgroundColor: color.bg };
  try {
    let created;
    try {
      created = await gmailRequest('labels', { method: 'POST', body });
    } catch (e) {
      if (!color) throw e;
      // A color Gmail dislikes must never stop the label from being created.
      delete body.color;
      created = await gmailRequest('labels', { method: 'POST', body });
    }
    await loadLabels();
    $('newlabel-modal').hidden = true;
    showToast('Label \u201c' + ((created && created.name) || name) + '\u201d created');
    if (!$('labels-modal').hidden) renderLabelsModal();
  } catch (e) {
    setStatus('newlabel-status', 'Could not create the label: ' + e.message, 'warn');
  } finally {
    btn.disabled = false;
  }
}

function openLabelsModal() {
  if (!currentThread) return;
  $('labels-modal').hidden = false;
  setStatus('labels-status', '');
  renderLabelsModal();
}

function threadHasLabel(id) {
  return currentThread.messages.some((m) => (m.labelIds || []).indexOf(id) !== -1);
}

function renderLabelsModal() {
  const el = $('labels-list');
  el.innerHTML = '';
  if (!labels.length) {
    const d = document.createElement('div');
    d.className = 'cm-labels-empty faint';
    d.textContent = 'No labels yet \u2014 create one with \u201cNew label\u201d.';
    el.appendChild(d);
    return;
  }
  for (const l of labels) {
    const row = document.createElement('label');
    row.className = 'cm-label-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'checkbox';
    box.checked = threadHasLabel(l.id);
    box.onchange = () => toggleThreadLabel(l, box);
    const dot = document.createElement('span');
    dot.className = 'cm-label-dot';
    const col = safeColor(l.color && l.color.backgroundColor);
    if (col) dot.style.background = col;
    else dot.classList.add('is-none');
    const nm = document.createElement('span');
    nm.className = 'cm-label-name truncate';
    nm.textContent = l.name;
    row.appendChild(box);
    row.appendChild(dot);
    row.appendChild(nm);
    el.appendChild(row);
  }
}

async function toggleThreadLabel(l, box) {
  const g = openGroup();
  if (!g) return;
  const add = box.checked ? [l.id] : [];
  const remove = box.checked ? [] : [l.id];
  applyLabelsToIds(groupIds(g), add, remove, false);
  const lm = latestMessage();
  if (lm) renderChips(lm, threadLabelIds());
  box.disabled = true;
  setStatus('labels-status', (box.checked ? 'Applying \u201c' : 'Removing \u201c') + l.name + '\u201d\u2026');
  try {
    await groupModify(g, add, remove);
    setStatus('labels-status', box.checked ? 'Label applied.' : 'Label removed.', 'ok');
  } catch (e) {
    box.checked = !box.checked;
    applyLabelsToIds(groupIds(g), remove, add, false);
    if (lm) renderChips(lm, threadLabelIds());
    setStatus('labels-status', 'Could not update the label: ' + e.message, 'warn');
  }
  box.disabled = false;
}

/* ---------------- attachments ---------------- */

function safeFileName(name) {
  const s = String(name || 'attachment')
    .replace(/[\\/]/g, '_')                    // a drive key never contains separators
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return (s || 'attachment').slice(0, 120);
}

function b64urlToB64(s) {
  const b64 = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return b64 + pad;
}

/* Attachment bytes are only available through messages.attachments.get, and
   drive.writeFile takes base64 — so decode here, save into ChatOSS Drive. */
async function downloadAttachment(m, att, card) {
  if (!att.attachmentId || card.dataset.busy) return;
  const sizeEl = card.querySelector('.cm-att-size');
  card.dataset.busy = '1';
  card.classList.add('is-busy');
  sizeEl.textContent = 'Saving\u2026';
  try {
    const res = await gmailRequest('messages/' + encodeURIComponent(m.id) +
      '/attachments/' + encodeURIComponent(att.attachmentId));
    if (!res || !res.data) throw new Error('the attachment came back empty');
    const path = 'Attachments/' + safeFileName(att.filename);
    await window.chatoss.drive.mkdir('Attachments').catch(() => {});
    await window.chatoss.drive.writeFile(path, b64urlToB64(res.data), { binary: true, mime: att.mimeType });
    card.classList.add('is-saved');
    sizeEl.textContent = 'Saved to Drive';
    showToast('Saved \u201c' + att.filename + '\u201d to ChatOSS Drive \u203a Attachments');
  } catch (e) {
    sizeEl.textContent = att.size ? formatSize(att.size) : '';
    showToast('Could not save the attachment: ' + e.message, true);
  }
  delete card.dataset.busy;
  card.classList.remove('is-busy');
}

/* ---------------- check for updates ---------------- */

/* A .aip app cannot replace its own files, so "check for updates" compares the
   repo's app.json (and the latest release tag) with this app's manifest and
   points the user at the GitHub release — same flow as Term Coder. */
const UPDATE_REPO = 'pagecow/cmail';
const UPDATE_APP_JSON_URL = 'https://raw.githubusercontent.com/' + UPDATE_REPO + '/main/app.json';
const UPDATE_RELEASE_API_URL = 'https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest';
const UPDATE_RELEASES_PAGE = 'https://github.com/' + UPDATE_REPO + '/releases';
const APP_VERSION = '0.4.2';   // fallback only — the manifest is the source of truth

/* "1.2.3" / "v1.2.3" → [1, 2, 3]; null when there is no leading number. */
function parseVersion(v) {
  const m = String(v == null ? '' : v).trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0, parseInt(m[3], 10) || 0];
}

/* >0 when a is newer than b, <0 when b is newer, 0 when equal or unparseable. */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/* This app's own version, from its manifest. */
async function ownVersion() {
  try {
    const m = await window.chatoss.manifest.get();
    if (m && m.version) return String(m.version);
  } catch (e) { /* fall through to the constant */ }
  return APP_VERSION;
}

/* The latest published version, or null when nothing could be read.
   Primary: the repo's app.json on main (the ?t= cache-buster forces a CDN
   cache miss). Fallback: the latest release tag. */
async function fetchLatestVersion() {
  const getJson = async (url, headers) => {
    const res = await window.chatoss.http.request(headers ? { url, headers } : { url });
    if (!res || res.status !== 200 || !res.body) return null;
    try { return JSON.parse(res.body); } catch (e) { return null; }
  };
  try {
    const json = await getJson(UPDATE_APP_JSON_URL + '?t=' + Date.now());
    if (json && json.version) return String(json.version);
  } catch (e) { /* try the next source */ }
  try {
    // The raw host doesn't care, but GitHub's API answers 403 ("forbidden by
    // administrative rules") to any request without a User-Agent.
    const json = await getJson(UPDATE_RELEASE_API_URL, {
      'User-Agent': 'Cmail/' + APP_VERSION,
      Accept: 'application/vnd.github+json',
    });
    if (json && (json.tag_name || json.name)) return String(json.tag_name || json.name);
  } catch (e) { /* nothing left to try */ }
  return null;
}

async function checkForUpdates() {
  const btn = $('btn-updates');
  if (!btn || btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    appVersion = await ownVersion();
    const remote = await fetchLatestVersion();
    if (!remote) {
      showToast('Couldn’t check for updates — check your connection', true);
    } else if (compareVersions(remote, appVersion) > 0) {
      $('update-version').textContent = 'Cmail ' + remote + ' is available — you have ' + appVersion + '.';
      $('update-modal').hidden = false;
    } else {
      showToast('Cmail is up to date (' + appVersion + ')');
    }
  } catch (e) {
    showToast('Couldn’t check for updates: ' + e.message, true);
  }
  btn.disabled = false;
  btn.textContent = label;
}

function openReleasesPage() {
  $('update-modal').hidden = true;
  try {
    window.chatoss.openExternal.open(UPDATE_RELEASES_PAGE).catch(() => {
      showToast('Couldn’t open the release page', true);
    });
  } catch (e) {
    showToast('Couldn’t open the release page: ' + e.message, true);
  }
}

/* ---------------- compose ---------------- */

function composeOpen() {
  return !$('compose-panel').hidden;
}

function composeHasContent() {
  return !!($('compose-to').value.trim() || $('compose-subject').value.trim() || $('compose-body').value.trim());
}

function clearComposeFields() {
  $('compose-to').value = '';
  $('compose-subject').value = '';
  $('compose-body').value = '';
  $('compose-confirm').hidden = true;
  $('compose-send-confirm').hidden = true;
  composeThreadId = null;
  composeReferences = null;
  composeMode = 'new';
  sendAnyway = false;
}

function openCompose(mode, m) {
  const panel = $('compose-panel');
  panel.hidden = false;
  panel.classList.remove('is-minimized');
  $('compose-confirm').hidden = true;
  $('compose-send-confirm').hidden = true;
  sendAnyway = false;
  setStatus('compose-status', '');
  composeMode = mode || 'new';
  composeThreadId = null;
  composeReferences = null;

  if ((composeMode === 'reply' || composeMode === 'forward') && m) {
    const from = parseFrom(getHeader(m.payload, 'From'));
    const subject = getHeader(m.payload, 'Subject') || '';
    if (composeMode === 'reply') {
      // The reply body starts EMPTY — the point of the composer is to write
      // and send your own message, not to re-send the original text.
      // Reply-To wins over From when the sender asked for replies elsewhere.
      const replyTo = parseFrom(getHeader(m.payload, 'Reply-To'));
      $('compose-to').value = replyTo.email || from.email || from.name;
      $('compose-subject').value = replySubject(subject);
      $('compose-body').value = '';
      composeThreadId = m.threadId || null;
      composeReferences = getHeader(m.payload, 'Message-ID') || null;
      $('compose-title').textContent = 'Reply';
      setTimeout(() => $('compose-body').focus(), 0);
    } else {
      $('compose-to').value = '';
      $('compose-subject').value = forwardSubject(subject);
      $('compose-body').value = quoteText(m, from);
      $('compose-title').textContent = 'Forward';
      setTimeout(() => $('compose-to').focus(), 0);
    }
  } else {
    clearComposeFields();
    $('compose-title').textContent = 'New message';
    setTimeout(() => $('compose-to').focus(), 0);
  }
}

function closeCompose(force) {
  const panel = $('compose-panel');
  if (panel.hidden) return;
  if (!force && composeHasContent()) {
    $('compose-confirm').hidden = false;
    return;
  }
  panel.hidden = true;
  panel.classList.remove('is-minimized');
  $('compose-confirm').hidden = true;
  clearComposeFields();
  setStatus('compose-status', '');
}

function wrapBase64(s) {
  return String(s).replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
}

function buildRawMessage(to, subject, body, opts) {
  const o = opts || {};
  const headers = [
    'To: ' + to,
    'Subject: ' + encodeHeaderWord(subject),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  if (o.inReplyTo) {
    headers.push('In-Reply-To: ' + o.inReplyTo);
    headers.push('References: ' + o.inReplyTo);
  }
  // The header block MUST end with an empty line before the body starts.
  const head = headers.join('\r\n') + '\r\n\r\n';
  return base64url(head + wrapBase64(b64encode(body)));
}

async function sendMail() {
  const to = $('compose-to').value.trim();
  const subject = $('compose-subject').value.trim();
  const body = $('compose-body').value;
  const sentMode = composeMode;
  const sentThreadId = composeThreadId;
  if (!hasRefresh) {
    setStatus('compose-status', 'Connect your Gmail account first.', 'warn');
    return;
  }
  if (!to) {
    setStatus('compose-status', 'Add at least one recipient.', 'warn');
    $('compose-to').focus();
    return;
  }
  // A reply now starts empty — never fire off a blank message by accident.
  if (!body.trim() && !sendAnyway) {
    $('compose-send-confirm').hidden = false;
    setStatus('compose-status', 'There is no message text yet.', 'warn');
    return;
  }
  sendAnyway = false;
  $('compose-send-confirm').hidden = true;
  const btn = $('compose-send');
  btn.disabled = true;
  setStatus('compose-status', 'Sending\u2026');
  try {
    const raw = buildRawMessage(to, subject, body, { inReplyTo: composeReferences });
    const payload = { raw };
    if (composeThreadId) payload.threadId = composeThreadId;
    await gmailRequest('messages/send', { method: 'POST', body: payload });
    closeCompose(true);
    if (sentMode === 'reply' && sentThreadId && threadOpen() && currentThread.id === sentThreadId) {
      await openThread(sentThreadId);   // show your reply inside the conversation
    } else if (currentFolder === 'SENT' || currentFolder === 'INBOX' || currentFolder === 'ALL') {
      await reloadList();
    }
    setStatus('list-status', 'Message sent.');
    showToast('Message sent to ' + to);
  } catch (e) {
    setStatus('compose-status', 'Send failed: ' + e.message, 'warn');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- settings modal ---------------- */

async function openSettings() {
  $('settings-modal').hidden = false;
  $('settings-status').textContent = '';
  $('settings-status').className = 'statusline';
  $('auth-step2').hidden = true;
  const cid = await getClientId();
  const csec = await getClientSecret();
  const redirect = await getRedirect();
  $('set-client-id').value = cid || '';
  $('set-client-secret').value = csec || '';
  $('set-redirect').value = redirect || DEFAULT_REDIRECT;
  $('settings-connected').hidden = !hasRefresh;
  if (hasRefresh) {
    $('settings-account').textContent = profile ? 'Connected as ' + profile.emailAddress : 'Connected.';
  }
}

async function saveSettings() {
  const clientId = $('set-client-id').value.trim();
  const clientSecret = $('set-client-secret').value.trim();
  const redirect = $('set-redirect').value.trim() || DEFAULT_REDIRECT;
  await saveCredentials(clientId, clientSecret, redirect);
  setStatus('settings-status', 'Settings saved.', 'ok');
}

/* ---------------- keyboard shortcuts ---------------- */

function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function moveFocus(delta) {
  const rows = Array.from(document.querySelectorAll('#msg-list .cm-row'));
  if (!rows.length) return;
  let idx = rows.findIndex((r) => r.dataset.id === focusedId);
  if (idx < 0) idx = delta > 0 ? -1 : rows.length;
  idx = Math.max(0, Math.min(rows.length - 1, idx + delta));
  focusedId = rows[idx].dataset.id;
  markFocusedRow();
  rows[idx].scrollIntoView({ block: 'nearest' });
}

function handleKeydown(e) {
  if (e.key === 'Escape') {
    if (composeOpen()) { closeCompose(false); return; }
    if (!$('newlabel-modal').hidden) { $('newlabel-modal').hidden = true; return; }
    if (!$('labels-modal').hidden) { $('labels-modal').hidden = true; return; }
    if (!$('update-modal').hidden) { $('update-modal').hidden = true; return; }
    if (!$('settings-modal').hidden) { $('settings-modal').hidden = true; return; }
    if (threadOpen()) { showList(); return; }
    return;
  }
  if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;

  if (threadOpen()) {
    const g = openGroup();
    switch (e.key) {
      case '/':
        e.preventDefault();
        $('search-input').focus();
        break;
      case 'u':
        e.preventDefault();
        showList();
        break;
      case 'e':
        if (g) { e.preventDefault(); archiveGroup(g); }
        break;
      case '#':
      case 'Delete':
        if (g) { e.preventDefault(); trashGroup(g); }
        break;
      case 'r':
        if (currentMessage) { e.preventDefault(); openCompose('reply', currentMessage); }
        break;
      case 'f':
        if (currentMessage) { e.preventDefault(); openCompose('forward', currentMessage); }
        break;
      case 'l':
        e.preventDefault();
        openLabelsModal();
        break;
      default:
        break;
    }
    return;
  }

  const id = focusedId || null;
  switch (e.key) {
    case '/':
      e.preventDefault();
      $('search-input').focus();
      break;
    case 'c':
      e.preventDefault();
      openCompose('new');
      break;
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      moveFocus(1);
      break;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      moveFocus(-1);
      break;
    case 'Enter':
    case 'o':
      if (focusedId) { e.preventDefault(); openThread(focusedId); }
      break;
    case 's':
      if (id) {
        e.preventDefault();
        const g = threadGroups().find((x) => x.id === id);
        if (g) toggleStarGroup(g);
      }
      break;
    default:
      break;
  }
}

/* ---------------- wire up ---------------- */

function wire() {
  paintIcons(document);

  $('btn-connect').onclick = openSettings;
  $('btn-compose').onclick = () => openCompose('new');
  $('btn-refresh').onclick = () => {
    pageHistory = [null];
    messages = [];
    showSkeleton();
    reloadList();
  };

  $('btn-updates').onclick = checkForUpdates;
  $('update-close').onclick = () => { $('update-modal').hidden = true; };
  $('update-later').onclick = () => { $('update-modal').hidden = true; };
  $('update-open').onclick = openReleasesPage;

  $('btn-back').onclick = showList;
  $('btn-newer').onclick = goNewerPage;
  $('btn-older').onclick = goOlderPage;

  const openId = () => openGroup();
  $('btn-archive').onclick = () => { const g = openId(); if (g) archiveGroup(g); };
  $('btn-trash').onclick = () => { const g = openId(); if (g) trashGroup(g); };
  $('btn-untrash').onclick = () => { const g = openId(); if (g) untrashGroup(g); };
  $('btn-read').onclick = () => { const g = openId(); if (g) toggleReadGroup(g); };
  $('btn-reply').onclick = () => { if (currentMessage) openCompose('reply', currentMessage); };
  $('btn-forward').onclick = () => { if (currentMessage) openCompose('forward', currentMessage); };

  $('btn-label').onclick = openLabelsModal;
  $('labels-close').onclick = () => { $('labels-modal').hidden = true; };
  $('labels-done').onclick = () => { $('labels-modal').hidden = true; };
  $('labels-new').onclick = openNewLabel;
  $('newlabel-close').onclick = () => { $('newlabel-modal').hidden = true; };
  $('newlabel-cancel').onclick = () => { $('newlabel-modal').hidden = true; };
  $('newlabel-create').onclick = createLabel;
  $('newlabel-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createLabel(); });

  $('compose-close').onclick = () => closeCompose(false);
  $('compose-min').onclick = () => {
    const panel = $('compose-panel');
    panel.classList.toggle('is-minimized');
    if (!panel.classList.contains('is-minimized')) $('compose-body').focus();
  };
  $('compose-title').onclick = () => {
    const panel = $('compose-panel');
    if (panel.classList.contains('is-minimized')) $('compose-min').onclick();
  };
  $('compose-send').onclick = sendMail;
  $('compose-discard').onclick = () => {
    if (composeHasContent()) $('compose-confirm').hidden = false;
    else closeCompose(true);
  };
  $('compose-discard-yes').onclick = () => closeCompose(true);
  $('compose-discard-no').onclick = () => { $('compose-confirm').hidden = true; };
  $('compose-send-anyway').onclick = () => { sendAnyway = true; sendMail(); };
  $('compose-send-cancel').onclick = () => {
    sendAnyway = false;
    $('compose-send-confirm').hidden = true;
    setStatus('compose-status', '');
  };
  $('compose-body').addEventListener('input', () => {
    if ($('compose-body').value.trim()) $('compose-send-confirm').hidden = true;
  });

  $('settings-close').onclick = () => { $('settings-modal').hidden = true; };
  $('btn-save-settings').onclick = saveSettings;
  $('btn-start-auth').onclick = startAuth;
  $('btn-exchange').onclick = finishAuth;
  $('btn-paste').onclick = async () => {
    try {
      $('auth-code-url').value = await window.chatoss.clipboard.readText();
    } catch (e) {
      setStatus('settings-status', 'Clipboard read failed: ' + e.message, 'warn');
    }
  };
  $('btn-copy-url').onclick = async () => {
    try {
      await window.chatoss.clipboard.writeText($('auth-url').value);
      setStatus('settings-status', 'Link copied \u2014 paste it into your browser.', 'ok');
    } catch (e) {
      setStatus('settings-status', 'Copy failed: ' + e.message, 'warn');
    }
  };
  $('btn-disconnect').onclick = disconnect;

  const search = $('search-input');
  search.addEventListener('input', () => {
    $('btn-clear-search').hidden = !search.value;
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      pageToken = null;
      pageHistory = [null];
      messages = [];
      showList();
      showSkeleton();
      loadFolder(currentFolder, false);
    } else if (e.key === 'Escape') {
      search.value = '';
      $('btn-clear-search').hidden = true;
      search.blur();
    }
  });
  $('btn-clear-search').onclick = () => {
    search.value = '';
    $('btn-clear-search').hidden = true;
    pageToken = null;
    pageHistory = [null];
    messages = [];
    showSkeleton();
    loadFolder(currentFolder, false);
    search.focus();
  };

  document.addEventListener('keydown', handleKeydown);
}

async function boot() {
  wire();
  hasRefresh = !!(await getRefreshToken());
  renderAccount();
  renderFolders();
  renderListHead();
  renderList();
  if (hasRefresh) {
    try {
      profile = await gmailRequest('profile');
      await loadLabels();
      await loadFolder(currentFolder);
      renderAccount();
    } catch (e) {
      setStatus('list-status', e.message, 'warn');
    }
  }
}

boot();
