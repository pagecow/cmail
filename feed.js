'use strict';

/* ============================================================
   Cmail — "For you": a personalized feed of the mail you care about.

   The Gmail-shaped app (main.js) stays what it was: folders, the
   conversation list, the thread reader. This file adds the one
   thing it never had — a feed.

   It learns from two things and keeps both in Cmail's own SQLite
   database ("cmail"):
     1. what you TELL the AI you want to see   → prefs.interests
     2. what you DO with your mail             → events + cards
        (opened, starred, replied to, ignored, muted)

   A run ranks the newest unranked messages with the ChatOSS model
   layer (capability "chatApi" — no API keys), writes a summary for
   the long ones, and renders them as tiles: rows on a desktop pane,
   one column on a phone. Everything about a card (reply, star,
   archive, "not interested") happens inside the card.

   Additive by design: nothing here is required by main.js, and
   every hook is guarded with `window.CFeed &&`.
   ============================================================ */

(function () {

const DB = 'cmail';              // this app's private database
const SCAN = 40;                 // newest inbox messages looked at per refresh
const BATCH = 12;                // messages (re)ranked per AI run — bounds the cost
const SHORT = 520;               // <= this many characters: the card shows the mail itself
const TEXT_CAP = 12000;          // body text kept per card (so "see full email" works offline)
const PROMPT_TEXT = 1400;        // body characters sent to the model per message
const READ_SINK = 6;             // a card you have already read sits a little below the unread ones
const AUTO_MS = 20 * 60 * 1000;  // don't re-scan more often than this on open
const VIEWS = ['grid', 'rows', 'columns'];
const FILTERS = ['all', 'unread'];

const $id = (id) => document.getElementById(id);
const enc = encodeURIComponent;

const F = {
  initPromise: null,
  ready: false,
  dbError: '',
  started: false,
  active: false,
  cards: [],
  muted: [],
  affinity: new Map(),
  interests: '',
  model: '',
  seeded: false,
  busy: false,
  models: null,
  favicons: true,
  navCount: 0,
  lastRun: 0,
  statusTimer: null,
  // View state — how the feed looks and what it shows (both remembered in prefs).
  view: 'grid',                  // grid | rows | columns
  filter: 'all',                 // all | unread
  // Cards the reader has opened with “See full email”. Rebuilding the grid used
  // to collapse them again — reading an email and losing it mid-paragraph.
  expanded: new Set(),
  bodyScroll: new Map(),         // msg_id → how far into the text the reader was
  replies: new Map(),            // msg_id → a reply being written on that card
  // msg_id → the real message as blocks (paragraphs/quotes). The stored body_text
  // is a flattened copy, so this is fetched the first time a mail is opened.
  blocks: new Map(),
  blockTried: new Set(),         // don't re-fetch a mail we already tried this session
  quotesOpen: new Set(),         // msg_id → quoted history revealed by the reader
  scroll: { top: 0, left: 0 },   // where the feed pane itself was scrolled
  renderSig: '',                 // what the grid currently paints (skip needless rebuilds)
  domIds: new Set(),
};

/* ---------------- the database ---------------- */

function fdb(sql, params) { return window.chatoss.db.exec(DB, sql, params || []); }
function fq(sql, params) { return window.chatoss.db.query(DB, sql, params || []); }

async function initDb() {
  if (F.initPromise) return F.initPromise;
  F.initPromise = (async () => {
    try {
      if (!window.chatoss.db) throw new Error('the sqlite bridge is not available');
      await fdb('CREATE TABLE IF NOT EXISTS prefs (' +
        'key TEXT PRIMARY KEY, value TEXT)');
      await fdb('CREATE TABLE IF NOT EXISTS cards (' +
        'msg_id TEXT PRIMARY KEY, thread_id TEXT, from_name TEXT, from_email TEXT, ' +
        'subject TEXT, snippet TEXT, date_ms INTEGER, is_long INTEGER DEFAULT 0, ' +
        'summary TEXT, body_text TEXT, score REAL, topic TEXT, reason TEXT, ' +
        'starred INTEGER DEFAULT 0, read_at INTEGER, replied_at INTEGER, unread INTEGER, ' +
        'hidden INTEGER DEFAULT 0, ai_at INTEGER, attempts INTEGER DEFAULT 0, ' +
        'rfc_message_id TEXT, reply_to TEXT)');
      // Added in 0.5.1: Gmail's own unread flag (NULL = never synced yet).
      try { await fdb('ALTER TABLE cards ADD COLUMN unread INTEGER'); } catch (e) { /* already there */ }
      await fdb('CREATE TABLE IF NOT EXISTS events (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT, thread_id TEXT, ' +
        'from_email TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL)');
      await fdb('CREATE TABLE IF NOT EXISTS muted (' +
        'email TEXT PRIMARY KEY, name TEXT, at INTEGER)');
      await fdb('CREATE INDEX IF NOT EXISTS events_email ON events (from_email)');
      F.ready = true;
    } catch (e) {
      F.dbError = e && e.message ? e.message : String(e);
    }
  })();
  return F.initPromise;
}

async function getPref(key, fallback) {
  try {
    const rows = await fq('SELECT value FROM prefs WHERE key = ?', [key]);
    return rows.length ? rows[0].value : fallback;
  } catch (e) {
    return fallback;
  }
}

function setPref(key, value) {
  return fdb('INSERT OR REPLACE INTO prefs (key, value) VALUES (?, ?)', [key, String(value)])
    .catch(() => 0);
}

function logEvent(kind, o) {
  const d = o || {};
  return fdb('INSERT INTO events (msg_id, thread_id, from_email, kind, at) VALUES (?,?,?,?,?)',
    [d.msgId || null, d.threadId || null, d.email || null, kind, Date.now()]).catch(() => 0);
}

/* ---------------- small helpers ---------------- */

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

/* Model output is prose shaped like JSON — pull the object out of it. */
function extractJson(text) {
  const s = String(text || '').replace(/```[a-z]*/gi, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

/* Trim the markdown the model likes to add to plain-text fields. */
function plain(s, max) {
  let out = String(s == null ? '' : s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (max && out.length > max) out = out.slice(0, max - 1).replace(/[,;:\s]+$/, '') + '…';
  return out;
}

function senderOf(meta) {
  return parseFrom(getHeader(meta.payload, 'From'));
}

function bodyTextOf(msg, fallback) {
  if (!msg) return fallback || '';
  const body = getMessageBody(msg);
  const text = body.kind === 'html' ? htmlToText(body.content) : body.content;
  const out = String(text || '').replace(/[ \t]+\n/g, '\n').trim();
  return out || fallback || '';
}

function statusText(text, warn) {
  const el = $id('feed-status');
  if (!el) return;
  if (F.statusTimer) { clearTimeout(F.statusTimer); F.statusTimer = null; }
  el.textContent = text || '';
  el.className = 'statusline' + (warn ? ' status-warn' : '');
}

function setSub(text) {
  const el = $id('feed-sub');
  if (el) el.textContent = text || '';
}

/* ---------------- cards: load + rank ---------------- */

async function loadCards() {
  try {
    const rows = await fq('SELECT * FROM cards WHERE hidden = 0 ORDER BY date_ms DESC LIMIT 400');
    const muted = await fq('SELECT * FROM muted ORDER BY at DESC');
    const aff = await fq('SELECT from_email, ' +
      "SUM(CASE WHEN kind = 'reply' THEN 3 WHEN kind = 'star' THEN 2 " +
      "WHEN kind IN ('open','read') THEN 1 WHEN kind = 'not_interested' THEN -3 ELSE 0 END) AS w " +
      'FROM events WHERE from_email IS NOT NULL GROUP BY from_email');
    F.muted = muted;
    F.affinity = new Map(aff.map((r) => [r.from_email, Number(r.w || 0)]));
    F.cards = rows.map((r) => Object.assign({}, r, {
      display: displayScore(r),
    }));
    // Drop view state for mail that is no longer in the feed.
    const live = new Set(F.cards.map((c) => c.msg_id));
    for (const id of Array.from(F.expanded)) if (!live.has(id)) F.expanded.delete(id);
    for (const id of Array.from(F.bodyScroll.keys())) if (!live.has(id)) F.bodyScroll.delete(id);
    for (const id of Array.from(F.replies.keys())) if (!live.has(id)) F.replies.delete(id);
    for (const id of Array.from(F.blocks.keys())) if (!live.has(id)) F.blocks.delete(id);
    for (const id of Array.from(F.quotesOpen)) if (!live.has(id)) F.quotesOpen.delete(id);
    F.navCount = F.cards.filter(isUnread).length;
  } catch (e) {
    F.cards = [];
    F.navCount = 0;
  }
}

function displayScore(c) {
  let s = Number(c.score);
  if (!isFinite(s)) s = 45;
  const aff = F.affinity.get(c.from_email) || 0;
  s += clamp(aff * 1.5, -10, 10);
  if (!isUnread(c)) s -= READ_SINK;
  return s;
}

/* Gmail's own unread flag once Cmail has seen it; before the first sync (or
   offline), fall back to Cmail's "you opened this" record. */
function isUnread(c) {
  return c.unread == null ? !c.read_at : Number(c.unread) === 1;
}

/* ---------------- feed refresh ---------------- */

async function refreshFeed(opts) {
  const o = opts || {};
  if (F.busy) return;
  if (!hasRefresh) { renderFeed(); return; }
  if (!F.ready) await initDb();
  if (!F.ready) { renderFeed(); return; }

  F.busy = true;
  statusText('Checking for new mail…');
  try {
    // 1. One list call: ids + threadIds of the newest inbox mail, newest first.
    const data = await gmailRequest('messages?maxResults=' + SCAN + '&labelIds=INBOX');
    const list = data.messages || [];
    const newest = new Map();                 // threadId → its newest inbox message
    for (const m of list) if (!newest.has(m.threadId)) newest.set(m.threadId, m);

    // 1b. Which of those threads still have unread mail, per Gmail itself. One
    //     extra list call; if it fails, the stored flags are left alone.
    let unreadThreads = null;
    try {
      const u = await gmailRequest('messages?maxResults=' + SCAN + '&labelIds=INBOX&q=is%3Aunread');
      unreadThreads = new Set();
      for (const m of (u.messages || [])) if (m.threadId) unreadThreads.add(m.threadId);
    } catch (e) { /* keep whatever the cards already say */ }

    const cardRows = await fq('SELECT msg_id, thread_id, hidden, date_ms, ai_at, attempts, unread FROM cards');
    const cardByThread = new Map();
    for (const c of cardRows) if (!cardByThread.has(c.thread_id)) cardByThread.set(c.thread_id, c);

    // 1c. Re-sync the read state of the threads we are looking at, so mail read
    //     in Gmail itself (or read here) is never stale in the feed.
    if (unreadThreads) {
      for (const tid of newest.keys()) {
        const card = cardByThread.get(tid);
        if (!card) continue;
        const want = unreadThreads.has(tid) ? 1 : 0;
        const cur = card.unread == null ? null : Number(card.unread);
        if (cur !== want) {
          await fdb('UPDATE cards SET unread = ? WHERE thread_id = ?', [want, tid]).catch(() => 0);
        }
      }
    }

    const cardIds = new Set(cardRows.map((c) => c.msg_id));
    // Cards flagged for re-ranking (new interests, "Rebuild feed") come first.
    const rerank = new Set(cardRows
      .filter((c) => !c.ai_at && Number(c.attempts || 0) < 3)
      .map((c) => c.thread_id));

    // 2. Messages that need ranking: brand new threads, a thread with newer mail
    //    than the card Cmail holds, or a card the reader asked to re-rank.
    const pending = [];
    for (const [tid, m] of newest) {
      const card = cardByThread.get(tid);
      if (!card) pending.push(m);
      else if (!card.hidden && (rerank.has(tid) || !cardIds.has(m.id))) pending.push(m);
    }
    pending.sort((a, b) => {
      const ra = rerank.has(a.threadId) ? 0 : 1;
      const rb = rerank.has(b.threadId) ? 0 : 1;
      return ra - rb;
    });
    const batch = pending.slice(0, BATCH);

    // 3. Mail that left the inbox: verify the handful of candidates before dropping.
    const stale = cardRows.filter((c) => !c.hidden && !newest.has(c.thread_id)).slice(0, 10);
    let gone = 0;
    for (const c of stale) {
      if (!(await threadInInbox(c.thread_id))) {
        await fdb('DELETE FROM cards WHERE msg_id = ?', [c.msg_id]).catch(() => 0);
        gone++;
      }
    }

    if (batch.length) {
      statusText('Reading ' + batch.length + ' new message' + (batch.length === 1 ? '' : 's') + '…');
      const ranked = await analyzeBatch(batch);
      if (ranked) {
        statusText('Feed updated — ' + ranked + ' new highlight' + (ranked === 1 ? '' : 's') + '.');
        F.statusTimer = setTimeout(() => statusText(''), 6000);
      }
    } else if (!o.silent) {
      statusText(gone ? 'Feed updated.' : '');
    }
    await setPref('lastRun', Date.now());
    F.lastRun = Date.now();
  } catch (e) {
    statusText('Could not update the feed: ' + (e && e.message ? e.message : e), true);
  } finally {
    F.busy = false;
    await loadCards();
    renderFeed();
    updateNav();
    // A rebuild/tune re-ranks in waves of BATCH — keep going while any remain.
    const depth = o.depth || 0;
    if (o.chain && depth < 4) {
      const left = await fq('SELECT COUNT(*) AS n FROM cards WHERE ai_at IS NULL AND attempts < 3')
        .catch(() => [{ n: 0 }]);
      if (left[0] && Number(left[0].n) > 0) {
        refreshFeed({ silent: true, chain: true, depth: depth + 1 });
      } else if (o.statusEl) {
        setElStatus(o.statusEl, 'Feed rebuilt.', 'ok');
      }
    } else if (o.statusEl) {
      setElStatus(o.statusEl, 'Feed rebuilt.', 'ok');
    }
  }
}

async function threadInInbox(threadId) {
  // Prefer the card's own message: messages.get ALWAYS returns labelIds, while
  // threads.get?format=minimal does not reliably carry them — and reading a
  // missing labelIds list as "no INBOX" deleted the whole feed.
  try {
    const rows = await fq('SELECT msg_id FROM cards WHERE thread_id = ? LIMIT 1', [threadId]);
    if (rows.length) return messageInInbox(rows[0].msg_id);
  } catch (e) { /* fall through to the thread check */ }
  try {
    const t = await gmailRequest('threads/' + enc(threadId) + '?format=minimal');
    const msgs = t.messages || [];
    if (!msgs.length) return false;
    if (msgs.some((m) => (m.labelIds || []).indexOf('INBOX') !== -1)) return true;
    // No labels anywhere in the response → unknowable: keep the card.
    return !msgs.some((m) => Array.isArray(m.labelIds));
  } catch (e) {
    return !isMissingError(e);
  }
}

/* A definitive "this mail is gone" check: labelIds and a 404 are both real
   answers; a timeout or any other error is not, and must never delete a card. */
async function messageInInbox(msgId) {
  try {
    const m = await gmailRequest('messages/' + enc(msgId) + '?format=minimal');
    return (m.labelIds || []).indexOf('INBOX') !== -1;
  } catch (e) {
    return !isMissingError(e);
  }
}

function isMissingError(e) {
  return /not found|404/i.test(String((e && e.message) || e));
}

/* ---------------- ranking with the model ---------------- */

async function analyzeBatch(list) {
  // Metadata (From/Subject/Date/Message-ID/Reply-To) for the batch — in parallel.
  const metas = (await Promise.all(list.map((m) =>
    gmailRequest('messages/' + enc(m.id) +
      '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date' +
      '&metadataHeaders=Message-ID&metadataHeaders=Reply-To').catch(() => null)
  ))).filter(Boolean);
  if (!metas.length) return 0;

  const mutedSet = new Set(F.muted.map((r) => r.email));
  const usable = metas.filter((m) => !mutedSet.has(senderOf(m).email));
  if (!usable.length) return 0;

  // Bodies — only for this batch, capped. One retry each: a single flaky fetch
  // must not silently reduce a card to the 200-character Gmail snippet.
  const fetchFull = async (id) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await gmailRequest('messages/' + enc(id) + '?format=full');
      } catch (e) {
        await new Promise((r) => setTimeout(r, 350));
      }
    }
    return null;
  };
  const bodies = await Promise.all(usable.map((m) => fetchFull(m.id)));
  const items = usable.map((m, i) => {
    const text = bodyTextOf(bodies[i], m.snippet || '').slice(0, TEXT_CAP);
    return {
      meta: m,
      text,
      isLong: text.length > SHORT,
      to: senderOf(m),
      payloadFor: bodies[i],
    };
  });

  const ranks = await rankWithModel(items);
  let saved = 0;
  for (const it of items) {
    const r = ranks.get(it.meta.id) || null;
    try {
      await saveCard(it, r);
      saved++;
    } catch (e) { /* keep going — one bad row must not stop the batch */ }
  }
  return saved;
}

async function rankWithModel(items) {
  const out = new Map();
  let modelId = F.model;
  try {
    if (!modelId) modelId = await window.chatoss.chat.getDefaultModel();
    if (!window.chatoss.chat || !window.chatoss.chat.runTurn) throw new Error('no chat bridge');
    const prompt = await buildPrompt(items);
    const res = await window.chatoss.chat.runTurn({
      model: modelId || undefined,
      messages: [
        { role: 'system', content: 'You are the curator of a personalized email feed. You answer with raw JSON only — never prose, never a code fence.' },
        { role: 'user', content: prompt },
      ],
    });
    const parsed = extractJson(res && res.content);
    const list = parsed && (parsed.items || parsed.results || (Array.isArray(parsed) ? parsed : null));
    if (!list || !list.length) throw new Error('the model did not return usable JSON');
    for (const r of list) {
      if (r && r.id != null) out.set(String(r.id), r);
    }
  } catch (e) {
    statusText('AI ranking unavailable — ranking locally.', true);
  }
  return out;
}

async function buildPrompt(items) {
  const engaged = await fq(
    'SELECT from_email, ' +
    "SUM(CASE WHEN kind = 'reply' THEN 1 ELSE 0 END) AS replies, " +
    "SUM(CASE WHEN kind = 'star' THEN 1 ELSE 0 END) AS stars, " +
    "SUM(CASE WHEN kind IN ('open','read') THEN 1 ELSE 0 END) AS opens " +
    'FROM events WHERE from_email IS NOT NULL GROUP BY from_email ' +
    'ORDER BY (replies * 4 + stars * 3 + opens) DESC LIMIT 10').catch(() => []);
  const ignored = await fq(
    'SELECT from_email, COUNT(*) AS seen, ' +
    'SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread ' +
    'FROM cards WHERE hidden = 0 AND from_email IS NOT NULL ' +
    'GROUP BY from_email HAVING seen >= 2 ORDER BY unread DESC, seen DESC LIMIT 8').catch(() => []);
  const recent = await fq(
    'SELECT subject, from_name FROM cards WHERE hidden = 0 ' +
    'AND (read_at IS NOT NULL OR replied_at IS NOT NULL) ' +
    'ORDER BY date_ms DESC LIMIT 8').catch(() => []);

  const lines = [];
  lines.push('You curate a personal mail feed ("For you") inside the Cmail email app.');
  lines.push('For every email below, judge how glad this person would be to SEE it in their feed, and summarise the long ones.');
  lines.push('');
  lines.push('WHO: ' + ((profile && profile.emailAddress) || 'this Gmail account'));
  lines.push('WHAT THEY SAID THEY WANT TO SEE: ' +
    (F.interests.trim() || '(nothing yet — infer it from the behaviour below)'));
  if (engaged.length) {
    lines.push('SENDERS THEY ENGAGE WITH: ' + engaged.map((r) =>
      r.from_email + ' (' + r.replies + ' replies, ' + r.stars + ' stars, ' + r.opens + ' opens)').join('; '));
  }
  if (ignored.length) {
    lines.push('SENDERS THEY OFTEN LEAVE UNREAD: ' + ignored.map((r) =>
      r.from_email + ' (' + r.unread + ' of ' + r.seen + ' unread)').join('; '));
  }
  if (recent.length) {
    lines.push('RECENTLY ENGAGED WITH: ' + recent.map((r) =>
      '"' + String(r.subject || '').slice(0, 70) + '"' + (r.from_name ? ' from ' + r.from_name : '')).join('; '));
  }
  lines.push('');
  lines.push('EMAILS:');
  lines.push(JSON.stringify(items.map((it) => ({
    id: it.meta.id,
    from: (it.to.name || '') + (it.to.email ? ' <' + it.to.email + '>' : ''),
    subject: getHeader(it.meta.payload, 'Subject'),
    date: getHeader(it.meta.payload, 'Date'),
    needs_summary: it.isLong,
    text: it.text.slice(0, PROMPT_TEXT),
  }))));
  lines.push('');
  lines.push('Reply with ONLY a JSON object, no prose and no code fence:');
  lines.push('{"items":[{"id":"<the same id>","score":0-100,"topic":"2-4 words",' +
    '"reason":"<under 12 words: why this is (or is not) for them>",' +
    '"summary":"<1-3 plain sentences, only when needs_summary is true; otherwise empty>"}]}');
  lines.push('Rules:');
  lines.push('- score 80-100 = they would be sorry to miss it; 50-79 = nice to see; 0-49 = noise ' +
    '(receipts, one-time codes, automated notices, promos and newsletters they ignore).');
  lines.push('- Weigh WHAT THEY SAID they want to see heavily; it outranks past behaviour.');
  lines.push('- Use only facts that appear in the email. No markdown, no links, no invented details.');
  lines.push('- Every email id must appear exactly once in "items".');
  return lines.join('\n');
}

async function saveCard(it, rank) {
  const meta = it.meta;
  const from = it.to;
  const subject = getHeader(meta.payload, 'Subject') || '(no subject)';
  const isLong = it.isLong;
  const score = rank && isFinite(Number(rank.score)) ? clamp(Number(rank.score), 0, 100) : null;
  const summary = rank ? plain(rank.summary, 700) : '';
  const row = {
    msg_id: meta.id,
    thread_id: meta.threadId || meta.id,
    from_name: from.name,
    from_email: from.email,
    subject,
    snippet: meta.snippet || '',
    date_ms: Number(meta.internalDate || 0),
    is_long: isLong ? 1 : 0,
    summary: summary || null,
    body_text: it.text ? it.text.slice(0, TEXT_CAP) : (meta.snippet || ''),
    score: score == null ? heuristicScore(it) : score,
    topic: rank ? plain(rank.topic, 40) : '',
    reason: rank ? plain(rank.reason, 120) : '',
    ai_at: Date.now(),
    attempts: rank ? 1 : 0,
    rfc_message_id: getHeader(meta.payload, 'Message-ID') || null,
    reply_to: getHeader(meta.payload, 'Reply-To') || null,
  };
  // Keep what the reader already did to this card (matched by message, else by thread).
  let old = await fq('SELECT starred, read_at, replied_at, unread, attempts FROM cards WHERE msg_id = ?', [row.msg_id]);
  if (!old.length) {
    old = await fq('SELECT starred, read_at, replied_at, unread, attempts FROM cards WHERE thread_id = ? ' +
      'ORDER BY date_ms DESC LIMIT 1', [row.thread_id]);
  }
  const keep = old.length ? old[0] : { starred: 0, read_at: null, replied_at: null, unread: null, attempts: 0 };
  // Gmail's read state for THIS message (labelIds always rides on the resource);
  // fall back to what the row already knew when the response is label-less.
  const unread = Array.isArray(meta.labelIds)
    ? (meta.labelIds.indexOf('UNREAD') !== -1 ? 1 : 0)
    : (keep.unread == null ? null : Number(keep.unread));
  const attempts = Number(keep.attempts || 0) + 1;
  await fdb('DELETE FROM cards WHERE msg_id = ?', [row.msg_id]);
  await fdb('INSERT INTO cards (msg_id, thread_id, from_name, from_email, subject, snippet, ' +
    'date_ms, is_long, summary, body_text, score, topic, reason, starred, read_at, replied_at, ' +
    'unread, hidden, ai_at, attempts, rfc_message_id, reply_to) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)',
    [row.msg_id, row.thread_id, row.from_name, row.from_email, row.subject, row.snippet,
      row.date_ms, row.is_long, row.summary, row.body_text, row.score, row.topic, row.reason,
      keep.starred || 0, keep.read_at || null, keep.replied_at || null, unread,
      rank ? row.ai_at : null, attempts, row.rfc_message_id, row.reply_to]);
  if (rank) {
    await fdb('DELETE FROM cards WHERE thread_id = ? AND msg_id <> ?', [row.thread_id, row.msg_id]);
  }
}

/* No model? Still a feed: rank by the interests text + sender history. */
function heuristicScore(it) {
  let score = 40;
  const hay = (it.meta.snippet || '') + ' ' + it.text;
  const words = F.interests.toLowerCase().split(/[^a-z0-9@.]{3,}/)
    .map((w) => w.trim()).filter((w) => w.length > 3);
  const lower = hay.toLowerCase();
  for (const w of words) if (lower.indexOf(w) !== -1) score += 8;
  score += clamp((F.affinity.get(it.to.email) || 0) * 3, -15, 15);
  if (/no-?reply|receipt|invoice|billing@|noreply@/i.test(it.to.email)) score -= 10;
  return clamp(score, 5, 95);
}

/* ---------------- rendering ---------------- */

function renderFeed(force) {
  const grid = $id('feed-grid');
  const onboard = $id('feed-onboard');
  if (!grid) return;
  if (F.dbError) {
    if (onboard) onboard.hidden = true;
    setSub('');
    grid.innerHTML = '';
    F.domIds = new Set();
    grid.appendChild(emptyState('spam', 'Could not open the feed database', F.dbError));
    F.renderSig = 'db-error';
    return;
  }
  if (!F.ready) {
    if (onboard) onboard.hidden = true;
    setSub('Loading…');
    return;
  }
  if (!hasRefresh) {
    if (onboard) onboard.hidden = true;
    setSub('');
    grid.innerHTML = '';
    F.domIds = new Set();
    grid.appendChild(connectEmptyState());
    F.renderSig = 'no-account';
    return;
  }
  const showOnboard = !F.seeded && !F.cards.length;
  if (onboard) onboard.hidden = !showOnboard;
  // All / Unread — read mail is part of the feed too; Unread is just a lens on it.
  // A mail you have OPEN stays put in either lens: reading it must never make it
  // disappear out from under you mid-paragraph.
  const shown = F.cards.filter((c) =>
    F.filter === 'all' || isUnread(c) || F.expanded.has(c.msg_id));
  const ranked = shown.slice().sort((a, b) =>
    (b.display - a.display) || ((b.date_ms || 0) - (a.date_ms || 0)));
  setSub(ranked.length
    ? (F.filter === 'unread'
        ? ranked.length + ' unread' + (F.cards.length ? ' of ' + F.cards.length : '')
        : ranked.length + (ranked.length === 1 ? ' highlight' : ' highlights')) +
      (F.lastRun ? ' · updated ' + gmailDate(new Date(F.lastRun).toISOString()) : '')
    : '');

  // Nothing that is painted changed: keep the DOM — and everything the reader
  // has open inside it — exactly as it is. Rebuilding here is what used to throw
  // away a card's full email (and its scroll position) mid-read.
  const sig = (ranked.length
    ? ranked.map(cardSignature).join('|')
    : 'empty|' + (F.busy ? 'busy' : 'idle') + '|' + (F.seeded ? 'seeded' : 'new') +
      '|' + F.cards.length) + '|' + F.filter + '|' + F.view;
  const intact = ranked.length === F.domIds.size &&
    ranked.every((c) => F.domIds.has(c.msg_id));
  if (!force && sig === F.renderSig && intact) return;
  F.renderSig = sig;

  // Remember where the reader was, then put them back after the rebuild.
  const scroller = $id('feed-scroll');
  if (scroller) { F.scroll.top = scroller.scrollTop; F.scroll.left = scroller.scrollLeft; }
  grid.querySelectorAll('.cm-card').forEach((el) => {
    const body = el.querySelector('.cm-card-body');
    if (body && body.scrollTop) F.bodyScroll.set(el.dataset.id, body.scrollTop);
  });

  grid.innerHTML = '';
  F.domIds = new Set();
  if (!ranked.length && !showOnboard && !F.busy) {
    if (F.filter === 'unread' && F.cards.length) {
      grid.appendChild(emptyState('mailOpen', 'Nothing unread right now',
        'Every mail in the feed is read. Switch to All to see the mail you have already read.'));
    } else {
      grid.appendChild(emptyState('sparkle', F.seeded ? 'Nothing new right now' : 'No highlights yet',
        F.seeded
          ? 'Cmail has nothing to highlight. Tap refresh in the toolbar to look again.'
          : 'Tap refresh in the toolbar and Cmail will read your newest mail.'));
    }
  }
  const frag = document.createDocumentFragment();
  for (const c of ranked) { frag.appendChild(buildCard(c)); F.domIds.add(c.msg_id); }
  grid.appendChild(frag);

  grid.querySelectorAll('.cm-card').forEach((el) => {
    const top = F.bodyScroll.get(el.dataset.id);
    if (top) {
      const body = el.querySelector('.cm-card-body');
      if (body) body.scrollTop = top;
    }
  });
  if (scroller) { scroller.scrollTop = F.scroll.top; scroller.scrollLeft = F.scroll.left; }
}

/* Everything a card's DOM depends on — if none of it moved, the grid is already
   right and a rebuild would only cost the reader their place. */
function cardSignature(c) {
  return [
    c.msg_id, Math.round(Number(c.display) || 0), c.starred ? 1 : 0, c.replied_at ? 1 : 0,
    isUnread(c) ? 1 : 0, c.subject || '', c.reason || '', c.topic || '', c.date_ms || 0,
    String(c.summary || ''), String(c.body_text || '').length,
  ].join('~');
}

/* ---------------- rendering a mail as a mail ---------------- */

/* The stored body_text is a flattened copy of the message: textContent dropped
   every block boundary, so a real mail arrived as one wall of text. Render the
   blocks fetched from the actual message when we have them, and recover what
   structure the text still carries when we don't. */
function blocksFor(c) {
  const cached = F.blocks.get(c.msg_id);
  if (cached && cached.length) return cached;
  return textToBlocks(c.body_text || c.snippet || '');
}

function buildBlockEl(b) {
  const line = document.createElement('p');
  line.className = 'cm-line' + (b.kind === 'li' ? ' is-li' : '');
  if (b.kind === 'li') {
    const dot = document.createElement('span');
    dot.className = 'cm-bullet';
    dot.textContent = '•';
    dot.setAttribute('aria-hidden', 'true');
    line.appendChild(dot);
  }
  const text = document.createElement('span');
  text.className = 'cm-line-text';
  text.textContent = b.text;    // text only: mail HTML never becomes live DOM here
  line.appendChild(text);
  return line;
}

/* Paragraphs, bullets, and the quoted history behind a bar. The quote is
   collapsed behind a “…” pill the way Gmail does it — the mail you are reading
   should never be buried under the mail you have already read. */
function paintBlocks(bodyEl, blocks, msgId) {
  const keepTop = bodyEl.scrollTop;
  bodyEl.textContent = '';
  const firstQuote = blocks.findIndex((b) => b.quote);
  const collapse = firstQuote > 0;     // an all-quote mail has nothing to hide behind
  const quote = collapse ? document.createElement('div') : null;
  if (collapse) quote.className = 'cm-quote';
  blocks.forEach((b, i) => {
    const line = buildBlockEl(b);
    if (collapse && i >= firstQuote) quote.appendChild(line);
    else bodyEl.appendChild(line);
  });
  if (collapse) {
    const shown = F.quotesOpen.has(msgId);
    quote.hidden = !shown;
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'cm-quote-pill';
    pill.textContent = shown ? 'Hide quoted text' : '…';
    const label = shown ? 'Hide quoted text' : 'Show quoted text';
    pill.title = label;
    pill.setAttribute('aria-label', label);
    pill.onclick = (e) => {
      e.stopPropagation();
      const nowOpen = quote.hidden;
      quote.hidden = !nowOpen;
      if (nowOpen) F.quotesOpen.add(msgId); else F.quotesOpen.delete(msgId);
      pill.textContent = nowOpen ? 'Hide quoted text' : '…';
      pill.title = nowOpen ? 'Hide quoted text' : 'Show quoted text';
      pill.setAttribute('aria-label', pill.title);
    };
    bodyEl.appendChild(pill);
    bodyEl.appendChild(quote);
  }
  bodyEl.scrollTop = keepTop;
}

/* Fetch a mail's real body the first time it is opened, so the card shows the
   message itself rather than the flattened copy kept for ranking. One try per
   mail per session; offline, the stored text keeps the card readable. */
async function ensureBlocks(c) {
  if (F.blocks.has(c.msg_id) || F.blockTried.has(c.msg_id)) return;
  F.blockTried.add(c.msg_id);
  let blocks = [];
  try {
    const full = await gmailRequest('messages/' + enc(c.msg_id) + '?format=full');
    const body = getMessageBody(full);
    blocks = body.kind === 'html' ? htmlToBlocks(body.content) : textToBlocks(body.content);
  } catch (e) {
    return;                    // offline or gone: the stored text is still there
  }
  if (!blocks.length) return;
  F.blocks.set(c.msg_id, blocks);

  // Repair the stored row too, so the structured version is what survives a
  // restart (and what a later read gets offline).
  const flat = blocks.map((b) => (b.quote ? b.text.replace(/^/gm, '> ') : b.text)).join('\n\n');
  if (flat && flat !== c.body_text) {
    c.body_text = flat.slice(0, TEXT_CAP);
    fdb('UPDATE cards SET body_text = ? WHERE msg_id = ?', [c.body_text, c.msg_id]).catch(() => 0);
  }

  // The grid may have been rebuilt while the fetch was in flight: repaint
  // whichever copy of this card is on screen now.
  if (!F.expanded.has(c.msg_id)) return;
  const gridEl = $id('feed-grid');
  if (!gridEl) return;
  gridEl.querySelectorAll('.cm-card').forEach((el) => {
    if (el.dataset.id === c.msg_id && el.cmRepaint) el.cmRepaint();
  });
}

function buildCard(c) {
  const el = document.createElement('article');
  // A card the reader opened stays open across re-renders (refresh, tab switch…).
  let summaryMode = !!c.is_long && !F.expanded.has(c.msg_id);
  el.className = 'cm-card ' + (isUnread(c) ? 'is-unread' : 'is-read') +
    (summaryMode ? '' : ' is-expanded');
  el.dataset.id = c.msg_id;

  el.innerHTML =
    '<div class="cm-card-head">' +
      '<span class="cm-card-av"></span>' +
      '<span class="cm-card-who">' +
        '<span class="cm-card-name truncate"></span>' +
        '<span class="cm-card-meta truncate"></span>' +
      '</span>' +
      '<span class="cm-card-dot" title="Unread" aria-label="Unread"></span>' +
      '<button type="button" class="cm-card-x" title="Not interested"></button>' +
    '</div>' +
    '<h3 class="cm-card-subject"></h3>' +
    (c.reason ? '<div class="cm-card-why"></div>' : '') +
    '<div class="cm-card-body"></div>' +
    '<div class="cm-card-foot">' +
      '<button type="button" class="cm-card-btn is-primary cm-card-reply-btn">' + svgIcon('reply') +
        '<span>Reply</span></button>' +
      (c.is_long ? '<button type="button" class="cm-card-btn cm-card-see">' + svgIcon('mailOpen') +
        '<span>See full email</span></button>' : '') +
      '<span class="spacer"></span>' +
      '<button type="button" class="cm-icon-btn cm-icon-btn-sm cm-card-open" title="Open the conversation in Cmail">' +
        svgIcon('openIn') + '</button>' +
      '<button type="button" class="cm-icon-btn cm-icon-btn-sm cm-card-star" title="Star"></button>' +
      '<button type="button" class="cm-icon-btn cm-icon-btn-sm cm-card-archive" title="Archive">' +
        svgIcon('archive') + '</button>' +
    '</div>' +
    '<div class="cm-card-reply" hidden>' +
      '<textarea class="cm-card-reply-input" rows="3" spellcheck="false"></textarea>' +
      '<div class="cm-card-reply-foot">' +
        '<span class="cm-card-reply-status statusline"></span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="btn btn-sm cm-card-reply-cancel">Cancel</button>' +
        '<button type="button" class="btn btn-sm btn-primary cm-card-reply-send">Send</button>' +
      '</div>' +
    '</div>';

  el.querySelector('.cm-card-name').textContent = c.from_name || c.from_email || '(no sender)';
  const metaBits = [];
  if (c.topic) metaBits.push(c.topic);
  metaBits.push(gmailDate(new Date(Number(c.date_ms) || Date.now()).toISOString()));
  el.querySelector('.cm-card-meta').textContent = metaBits.join(' · ');
  el.querySelector('.cm-card-subject').textContent = c.subject || '(no subject)';
  if (c.reason) el.querySelector('.cm-card-why').textContent = c.reason;
  setIcon(el.querySelector('.cm-card-x'), 'close');
  setIcon(el.querySelector('.cm-card-star'), c.starred ? 'starFilled' : 'star');
  el.querySelector('.cm-card-star').classList.toggle('is-starred', !!c.starred);
  el.querySelector('.cm-card-reply-input').placeholder =
    'Reply to ' + (c.from_name || c.from_email || 'the sender') + '…';

  const avatar = el.querySelector('.cm-card-av');
  const initial = document.createElement('span');
  initial.className = 'cm-card-initial';
  initial.textContent = avatarInitial(c.from_name, c.from_email);
  avatar.appendChild(initial);
  const domain = String(c.from_email || '').split('@')[1] || '';
  if (domain && F.favicons) {
    const img = document.createElement('img');
    img.className = 'cm-card-fav';
    img.alt = '';
    img.onload = () => avatar.classList.add('has-fav');
    img.src = 'https://www.google.com/s2/favicons?domain=' + enc(domain) + '&sz=64';
    avatar.appendChild(img);
  }

  const bodyEl = el.querySelector('.cm-card-body');
  const foot = el.querySelector('.cm-card-foot');
  // Long mail that was cut off in the prompt: the rest lives in the conversation.
  const moreHint = document.createElement('button');
  moreHint.type = 'button';
  moreHint.className = 'cm-card-more';
  moreHint.hidden = true;
  moreHint.textContent = 'Long message — open the conversation to read all of it';
  moreHint.onclick = (e) => { e.stopPropagation(); openConversation(c); };
  foot.parentNode.insertBefore(moreHint, foot);

  const paintBody = () => {
    // Keep the reader's place in the text across a repaint (blocks arriving, a
    // quote toggled, the grid rebuilding under an open card…).
    const keepTop = bodyEl.scrollTop;
    const open = !summaryMode;
    bodyEl.textContent = '';
    el.classList.toggle('is-expanded', open);
    bodyEl.classList.toggle('is-text', open);
    if (open) {
      const blocks = blocksFor(c);
      if (blocks.length) paintBlocks(bodyEl, blocks, c.msg_id);
      else bodyEl.textContent = '(This message has no text.)';
    } else {
      bodyEl.textContent = c.summary || c.snippet || '(This message has no text.)';
    }
    if (keepTop) bodyEl.scrollTop = keepTop;
    // The stored text is cut at TEXT_CAP — but only while that cut text is what
    // the card is showing: once the whole message has been fetched, none is.
    const cut = String(c.body_text || '').length >= TEXT_CAP - 1;
    moreHint.hidden = !(open && cut && !F.blocks.has(c.msg_id));
  };
  paintBody();

  // Long mail: the card shows the summary until you ask for the whole thing.
  const seeBtn = el.querySelector('.cm-card-see');
  const paintSee = () => {
    if (seeBtn) {
      seeBtn.querySelector('span').textContent = summaryMode
        ? 'See full email'
        : (c.summary ? 'Show summary' : 'Show less');
    }
  };
  if (seeBtn) {
    seeBtn.onclick = (e) => {
      e.stopPropagation();
      summaryMode = !summaryMode;
      if (summaryMode) F.expanded.delete(c.msg_id);
      else F.expanded.add(c.msg_id);
      paintSee();
      paintBody();
      if (!summaryMode) {
        markCardRead(c, el);
        ensureBlocks(c);       // the real message, fetched and styled on first open
      }
    };
    paintSee();     // a card rebuilt while open keeps its “Show summary” label
  }
  // ensureBlocks() repaints through this when the fetched blocks land.
  el.cmRepaint = () => { paintSee(); paintBody(); };

  // Clicking the mail itself opens the conversation — but selecting text is not
  // a click, and a card you are READING in full must not navigate away on a
  // stray click: that is what made the full email seem to vanish.
  const openOnClick = (e) => {
    if (F.expanded.has(c.msg_id)) return;
    const sel = window.getSelection ? String(window.getSelection()) : '';
    if (sel) return;
    openConversation(c);
  };
  el.querySelector('.cm-card-subject').onclick = openOnClick;
  bodyEl.onclick = openOnClick;
  el.querySelector('.cm-card-x').onclick = (e) => { e.stopPropagation(); notInterested(c, el); };
  el.querySelector('.cm-card-open').onclick = (e) => { e.stopPropagation(); openConversation(c); };
  el.querySelector('.cm-card-archive').onclick = (e) => { e.stopPropagation(); archiveCard(c, el); };
  el.querySelector('.cm-card-star').onclick = (e) => { e.stopPropagation(); starCard(c, el); };

  const replyWrap = el.querySelector('.cm-card-reply');
  const replyInput = el.querySelector('.cm-card-reply-input');
  // A half-written reply must not vanish when the grid rebuilds under it.
  const draft = F.replies.get(c.msg_id);
  if (draft) {
    replyWrap.hidden = false;
    replyInput.value = draft;
  }
  replyInput.addEventListener('input', () => {
    if (replyInput.value) F.replies.set(c.msg_id, replyInput.value);
    else F.replies.delete(c.msg_id);
  });
  el.querySelector('.cm-card-reply-btn').onclick = (e) => {
    e.stopPropagation();
    replyWrap.hidden = false;
    setTimeout(() => replyInput.focus(), 0);
  };
  el.querySelector('.cm-card-reply-cancel').onclick = (e) => {
    e.stopPropagation();
    replyWrap.hidden = true;
    replyInput.value = '';
    F.replies.delete(c.msg_id);
    setElStatus(el.querySelector('.cm-card-reply-status'), '');
  };
  el.querySelector('.cm-card-reply-send').onclick = (e) => {
    e.stopPropagation();
    sendCardReply(c, el, replyWrap, replyInput);
  };
  replyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendCardReply(c, el, replyWrap, replyInput);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      replyWrap.hidden = true;
    }
    e.stopPropagation();
  });
  return el;
}

/* NB: named this way on purpose — main.js already owns a global setStatus(id,…). */
function setElStatus(el, text, warn) {
  if (!el) return;
  el.textContent = text || '';
  el.className = 'statusline' + (warn ? ' status-warn' : '');
}

/* ---------------- card actions ---------------- */

/* Opening the real conversation — the feed comes back on the way out. */
function openConversation(c) {
  returnToFeed = true;                       // main.js sends ← / Escape back here
  openThread(c.thread_id || c.msg_id);
}

async function markCardRead(c, el) {
  if (c.read_at) return;
  c.read_at = Date.now();
  c.unread = 0;
  // Ranking is deliberately NOT recomputed here: reading a card must not make it
  // slide down the feed (or out of an unread-only view) while you are reading it.
  if (el) { el.classList.remove('is-unread'); el.classList.add('is-read'); }
  logEvent('read', { msgId: c.msg_id, threadId: c.thread_id, email: c.from_email });
  fdb('UPDATE cards SET read_at = ?, unread = 0 WHERE msg_id = ?', [c.read_at, c.msg_id]).catch(() => 0);
  try {
    // Clear the whole conversation, exactly like main.js does when one is opened.
    const path = c.thread_id ? 'threads/' + enc(c.thread_id) : 'messages/' + enc(c.msg_id);
    await gmailRequest(path + '/modify',
      { method: 'POST', body: { removeLabelIds: ['UNREAD'] } });
  } catch (e) { /* the mail just stays bold */ }
  updateNav();
}

async function starCard(c, el) {
  const btn = el.querySelector('.cm-card-star');
  const starred = !c.starred;
  c.starred = starred ? 1 : 0;
  setIcon(btn, starred ? 'starFilled' : 'star');
  btn.classList.toggle('is-starred', starred);
  if (starred) logEvent('star', { msgId: c.msg_id, threadId: c.thread_id, email: c.from_email });
  fdb('UPDATE cards SET starred = ? WHERE msg_id = ?', [c.starred, c.msg_id]).catch(() => 0);
  try {
    await gmailRequest('messages/' + enc(c.msg_id) + '/modify', {
      method: 'POST',
      body: { addLabelIds: starred ? ['STARRED'] : [], removeLabelIds: starred ? [] : ['STARRED'] },
    });
    showToast(starred ? 'Starred' : 'Star removed');
  } catch (e) {
    c.starred = starred ? 0 : 1;
    setIcon(btn, c.starred ? 'starFilled' : 'star');
    btn.classList.toggle('is-starred', !!c.starred);
    showToast('Could not star it: ' + e.message, true);
  }
}

async function archiveCard(c, el) {
  el.classList.add('is-busy');
  try {
    await gmailRequest('threads/' + enc(c.thread_id) + '/modify',
      { method: 'POST', body: { removeLabelIds: ['INBOX'] } });
    logEvent('archive', { msgId: c.msg_id, threadId: c.thread_id, email: c.from_email });
    await fdb('DELETE FROM cards WHERE msg_id = ?', [c.msg_id]).catch(() => 0);
    el.remove();
    F.cards = F.cards.filter((x) => x.msg_id !== c.msg_id);
    F.expanded.delete(c.msg_id);
    F.bodyScroll.delete(c.msg_id);
    F.domIds.delete(c.msg_id);
    updateNav();
    renderFeed();
    showToast('Archived');
  } catch (e) {
    el.classList.remove('is-busy');
    showToast('Could not archive it: ' + e.message, true);
  }
}

async function notInterested(c, el) {
  logEvent('not_interested', { msgId: c.msg_id, threadId: c.thread_id, email: c.from_email });
  F.affinity.set(c.from_email, (F.affinity.get(c.from_email) || 0) - 3);
  try {
    await fdb('UPDATE cards SET hidden = 1 WHERE msg_id = ?', [c.msg_id]);
  } catch (e) { /* hidden in this session only */ }
  F.cards = F.cards.filter((x) => x.msg_id !== c.msg_id);
  F.expanded.delete(c.msg_id);
  F.bodyScroll.delete(c.msg_id);
  F.domIds.delete(c.msg_id);
  el.remove();
  updateNav();
  renderFeed();
  showToast('Got it — fewer like this');
}

async function sendCardReply(c, el, wrap, input) {
  const text = input.value.trim();
  const statusEl = el.querySelector('.cm-card-reply-status');
  const sendBtn = el.querySelector('.cm-card-reply-send');
  if (!text) {
    setElStatus(statusEl, 'Write something first.', true);
    input.focus();
    return;
  }
  sendBtn.disabled = true;
  setElStatus(statusEl, 'Sending…');
  try {
    let to = c.reply_to || c.from_email;
    let rfcId = c.rfc_message_id;
    if (!to || !rfcId) {
      const m = await gmailRequest('messages/' + enc(c.msg_id) +
        '?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Message-ID');
      const from = parseFrom(getHeader(m.payload, 'From'));
      const replyTo = parseFrom(getHeader(m.payload, 'Reply-To'));
      to = c.reply_to || replyTo.email || from.email;
      rfcId = c.rfc_message_id || getHeader(m.payload, 'Message-ID') || null;
      fdb('UPDATE cards SET reply_to = ?, rfc_message_id = ? WHERE msg_id = ?',
        [c.reply_to || replyTo.email || null, rfcId, c.msg_id]).catch(() => 0);
    }
    const raw = buildRawMessage(to, replySubject(c.subject), text, { inReplyTo: rfcId || undefined });
    await gmailRequest('messages/send', {
      method: 'POST',
      body: { raw, threadId: c.thread_id || undefined },
    });
    logEvent('reply', { msgId: c.msg_id, threadId: c.thread_id, email: c.from_email });
    c.replied_at = Date.now();
    fdb('UPDATE cards SET replied_at = ? WHERE msg_id = ?', [c.replied_at, c.msg_id]).catch(() => 0);
    wrap.hidden = true;
    input.value = '';
    F.replies.delete(c.msg_id);
    const badge = document.createElement('span');
    badge.className = 'cm-card-badge';
    badge.textContent = 'Replied ✓';
    const foot = el.querySelector('.cm-card-foot');
    if (foot && !foot.querySelector('.cm-card-badge')) foot.insertBefore(badge, foot.firstChild);
    showToast('Reply sent to ' + to);
    markCardRead(c, el);
  } catch (e) {
    setElStatus(statusEl, 'Send failed: ' + e.message, true);
  }
  sendBtn.disabled = false;
}

/* ---------------- hooks from main.js ---------------- */

/* You opened a conversation: that is the strongest "I care" signal we get. */
function recordOpen(threadId, msgs) {
  if (!F.ready || !threadId) return;
  const latest = msgs && msgs.length ? msgs[msgs.length - 1] : null;
  const from = latest ? parseFrom(getHeader(latest.payload, 'From')) : null;
  logEvent('open', {
    msgId: latest ? latest.id : null,
    threadId,
    email: from ? from.email : null,
  });
  const card = F.cards.find((c) => c.thread_id === threadId && isUnread(c));
  if (card) {
    card.read_at = Date.now();
    card.unread = 0;               // main.js clears UNREAD in Gmail on open
    fdb('UPDATE cards SET read_at = ?, unread = 0 WHERE msg_id = ?', [card.read_at, card.msg_id]).catch(() => 0);
    updateNav();
    renderFeed();
  }
}

/* You replied from the normal composer — same signal. */
function recordReply(threadId, email) {
  if (!F.ready || !threadId) return;
  logEvent('reply', { threadId, email });
  const card = F.cards.find((c) => c.thread_id === threadId);
  if (card && !card.replied_at) {
    card.replied_at = Date.now();
    fdb('UPDATE cards SET replied_at = ? WHERE msg_id = ?', [card.replied_at, card.msg_id]).catch(() => 0);
  }
}

/* Gmail just got connected — the feed can read mail now. */
function onConnected() {
  open();
  if (F.seeded) refreshFeed({ silent: true });
}

/* ---------------- the view itself ---------------- */

function isActive() { return F.active; }

function open() {
  F.active = true;
  const feed = $id('feed-view');
  if (feed) feed.hidden = false;
  const list = $id('list-view');
  if (list) list.hidden = true;
  const thread = $id('thread-view');
  if (thread) thread.hidden = true;
  if (typeof currentThread !== 'undefined') currentThread = null;
  if (typeof renderFolders === 'function') renderFolders();
  renderFeed();
}

function hideView() {
  F.active = false;
  const feed = $id('feed-view');
  if (feed) feed.hidden = true;
}

function navCount() { return F.navCount; }

function updateNav() {
  if (typeof renderFolders === 'function') renderFolders();
}

/* ---------------- how the feed looks ---------------- */

/* All / Unread — read mail belongs on this screen too; Unread is a lens on it. */
function setFilter(mode) {
  F.filter = FILTERS.indexOf(mode) === -1 ? 'all' : mode;
  setPref('filter', F.filter);
  applyChrome();
  renderFeed(true);
}

/* Tiles that wrap · one mail per row · full-height columns you scroll across. */
function setView(mode) {
  F.view = VIEWS.indexOf(mode) === -1 ? 'grid' : mode;
  setPref('view', F.view);
  const scroller = $id('feed-scroll');
  // A pane that scrolls sideways has no use for the other axis' old position.
  if (scroller) {
    if (F.view === 'columns') { scroller.scrollTop = 0; F.scroll.top = 0; }
    else { scroller.scrollLeft = 0; F.scroll.left = 0; }
  }
  applyChrome();
}

function applyChrome() {
  const scroller = $id('feed-scroll');
  const grid = $id('feed-grid');
  for (const el of [scroller, grid]) {
    if (!el) continue;
    el.classList.toggle('is-columns', F.view === 'columns');
    el.classList.toggle('is-rows', F.view === 'rows');
  }
  // .is-active is the platform's own selected state for .seg-item, so the pill
  // keeps its theme-correct colours rather than a hardcoded one.
  document.querySelectorAll('#feed-viewmode [data-view]').forEach((b) => {
    const on = b.dataset.view === F.view;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  document.querySelectorAll('#feed-filter [data-filter]').forEach((b) => {
    const on = b.dataset.filter === F.filter;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

/* ---------------- tuning ---------------- */

async function loadModels() {
  if (F.models) return F.models;
  F.models = [];
  try {
    const list = await window.chatoss.chat.listModels();
    F.models = (list || []).filter((m) => m && m.available !== false);
  } catch (e) {
    F.models = [];
  }
  return F.models;
}

async function openTune() {
  const modal = $id('feed-tune-modal');
  if (!modal) return;
  modal.hidden = false;
  setElStatus($id('feed-tune-status'), '');
  $id('feed-clear-confirm').hidden = true;
  $id('feed-interests-modal').value = F.interests;
  const sel = $id('feed-model');
  sel.innerHTML = '<option value="">ChatOSS default model</option>';
  const models = await loadModels();
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name + (m.source ? ' · ' + m.source : '');
    sel.appendChild(opt);
  }
  sel.value = F.model && models.some((m) => m.id === F.model) ? F.model : '';
  renderMuted();
  const rows = await fq('SELECT COUNT(*) AS n FROM cards').catch(() => [{ n: 0 }]);
  const evs = await fq('SELECT COUNT(*) AS n FROM events').catch(() => [{ n: 0 }]);
  $id('feed-data-hint').textContent =
    'Cmail has ranked ' + (rows[0] ? rows[0].n : 0) + ' messages and learned from ' +
    (evs[0] ? evs[0].n : 0) + ' actions. Nothing leaves your machine except the ranking request itself.';
}

function renderMuted() {
  const el = $id('feed-muted');
  el.innerHTML = '';
  if (!F.muted.length) {
    const d = document.createElement('div');
    d.className = 'faint';
    d.style.fontSize = '12.5px';
    d.textContent = 'No muted senders. Cards you mark “not interested” teach Cmail instead.';
    el.appendChild(d);
    return;
  }
  for (const m of F.muted) {
    const row = document.createElement('div');
    row.className = 'cm-muted-row';
    const name = document.createElement('span');
    name.className = 'truncate';
    name.textContent = (m.name ? m.name + ' · ' : '') + m.email;
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm';
    btn.textContent = 'Unmute';
    btn.onclick = async () => {
      await fdb('DELETE FROM muted WHERE email = ?', [m.email]).catch(() => 0);
      F.muted = F.muted.filter((x) => x.email !== m.email);
      renderMuted();
      showToast('Unmuted ' + m.email);
    };
    row.appendChild(name);
    row.appendChild(spacer);
    row.appendChild(btn);
    el.appendChild(row);
  }
}

async function saveTune() {
  const interests = $id('feed-interests-modal').value.trim();
  const model = $id('feed-model').value;
  const changed = interests !== F.interests;
  F.interests = interests;
  F.model = model;
  F.seeded = true;
  await setPref('interests', interests);
  await setPref('model', model);
  await setPref('seeded', 1);
  $id('feed-tune-modal').hidden = true;
  if (changed) {
    await fdb('UPDATE cards SET ai_at = NULL, attempts = 0').catch(() => 0);
    showToast('Interests saved — re-ranking your feed');
    open();
    refreshFeed({ chain: true });
  } else {
    showToast('Feed settings saved');
  }
}

async function rebuildFeed() {
  await fdb('UPDATE cards SET ai_at = NULL, attempts = 0').catch(() => 0);
  setElStatus($id('feed-tune-status'), 'Re-ranking everything…');
  await refreshFeed({ silent: true, chain: true, statusEl: $id('feed-tune-status') });
}

/* ---------------- wiring + start ---------------- */

function wire() {
  const on = (id, fn) => {
    const el = $id(id);
    if (el) el.onclick = fn;
  };
  on('feed-refresh', () => refreshFeed());
  on('feed-tune', openTune);
  on('feed-tune-close', () => { $id('feed-tune-modal').hidden = true; });
  on('feed-tune-save', saveTune);
  on('feed-rebuild', rebuildFeed);
  on('feed-clear', () => { $id('feed-clear-confirm').hidden = false; });
  on('feed-clear-no', () => { $id('feed-clear-confirm').hidden = true; });
  on('feed-clear-yes', clearFeedData);
  on('feed-build', () => {
    const text = $id('feed-interests').value.trim();
    F.interests = text;
    setPref('interests', text);
    setPref('seeded', 1);
    F.seeded = true;
    $id('feed-onboard').hidden = true;
    refreshFeed();
  });
  on('feed-skip', () => {
    F.seeded = true;
    setPref('seeded', 1);
    $id('feed-onboard').hidden = true;
    refreshFeed();
  });

  // All / Unread and the three layouts (one delegated listener each).
  const seg = (id, attr, fn) => {
    const el = $id(id);
    if (el) el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[' + attr + ']');
      if (b) fn(b.getAttribute(attr));
    });
  };
  seg('feed-filter', 'data-filter', setFilter);
  seg('feed-viewmode', 'data-view', setView);

  // Column view scrolls sideways: let a plain wheel do it, like a rack of mail.
  const scroller = $id('feed-scroll');
  if (scroller) {
    scroller.addEventListener('wheel', (e) => {
      if (F.view !== 'columns') return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (!scroller.scrollWidth || scroller.scrollWidth <= scroller.clientWidth) return;
      scroller.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }
  if (typeof paintIcons === 'function') paintIcons(document);
  probeFavicons();
  applyChrome();
}

async function clearFeedData() {
  try {
    await fdb('DELETE FROM cards');
    await fdb('DELETE FROM events');
    await fdb('DELETE FROM muted');
  } catch (e) { /* nothing to clear */ }
  F.cards = [];
  F.muted = [];
  F.affinity = new Map();
  F.navCount = 0;
  $id('feed-clear-confirm').hidden = true;
  setElStatus($id('feed-tune-status'), 'Feed history cleared.', 'ok');
  renderMuted();
  renderFeed();
  updateNav();
  showToast('Feed history cleared');
}

function probeFavicons() {
  try {
    const img = new Image();
    img.onload = () => { F.favicons = true; };
    img.onerror = () => { F.favicons = false; };
    img.src = 'https://www.google.com/s2/favicons?domain=gmail.com&sz=64';
  } catch (e) { F.favicons = false; }
}

async function start() {
  if (F.started) return;
  F.started = true;
  wire();
  open();                                   // the feed is the default tab
  await initDb();
  if (F.ready) {
    F.interests = await getPref('interests', '');
    F.model = await getPref('model', '');
    F.seeded = (await getPref('seeded', '0')) === '1';
    F.lastRun = Number(await getPref('lastRun', 0)) || 0;
    const view = await getPref('view', 'grid');
    const filter = await getPref('filter', 'all');
    F.view = VIEWS.indexOf(view) === -1 ? 'grid' : view;
    F.filter = FILTERS.indexOf(filter) === -1 ? 'all' : filter;
    applyChrome();
    await loadCards();
  }
  renderFeed();
  updateNav();
  // Don't spend model calls before the reader has actually engaged with the feed
  // (the onboarding panel is what triggers the first build).
  if (hasRefresh && F.seeded && (!F.lastRun || Date.now() - F.lastRun > AUTO_MS)) {
    refreshFeed({ silent: true });
  }
}

window.CFeed = {
  start,
  open,
  hideView,
  isActive,
  navCount,
  refresh: refreshFeed,
  recordOpen,
  recordReply,
  onConnected,
  openTune,
  renderFeed,
  setView,
  setFilter,
  applyChrome,
  reload: loadCards,
  _db: { exec: fdb, query: fq },
  _state: F,
};

})();
