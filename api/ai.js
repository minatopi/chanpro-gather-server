'use strict';

const mysql = require('mysql2/promise');
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { createClient } = require('@supabase/supabase-js');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-6-luna';
const OPENAI_COMPARE_MODEL = process.env.OPENAI_COMPARE_MODEL || 'gpt-4.1-mini';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.6-flare';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '';
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const IP_HASH_SECRET = process.env.IP_HASH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const AXIOM_TOKEN = process.env.AXIOM_TOKEN || '';
const AXIOM_DATASET = process.env.AXIOM_DATASET || 'chanpro';

let pool;
let supabase;
const VOICES = new Set(['onyx', 'echo', 'nova', 'shimmer']);
const EXPRESSIONS = new Set(['normal', 'happy', 'sad', 'angry', 'surprised', 'sleepy', 'wink']);

/* ================= 管理サイト連携: 停止設定(app_settings) ================= */
// 管理サイトの「停止設定」と同じキー: server_enabled(全通信を拒否) / feature_ai_chat / feature_ai_image / feature_ai_upload
// admin / developer は機能停止の対象外(サーバー全体の停止は全員が対象)
const AI_FEATURES = {
  ai_chat: { label: 'AIチャット', actions: ['chat', 'speech', 'history', 'list', 'delete', 'settings', 'save-settings'] },
  ai_image: { label: 'AI画像生成', actions: ['image'] },
  ai_upload: { label: 'AI用の画像送信', actions: ['upload'] }
};
const FEATURE_OF_ACTION = {};
for (const [key, f] of Object.entries(AI_FEATURES)) for (const a of f.actions) FEATURE_OF_ACTION[a] = key;

let settingsCache = { at: 0, map: new Map() };
async function getSettings() {
  if (Date.now() - settingsCache.at < 5000) return settingsCache.map;
  const sb = getSupabase();
  if (!sb) return settingsCache.map;
  try {
    const { data, error } = await sb.from('app_settings').select('key,value');
    if (error) throw error;
    settingsCache = { at: Date.now(), map: new Map((data || []).map(r => [r.key, r.value])) };
  } catch (e) {
    settingsCache.at = Date.now() - 3000; // 取得に失敗したら数秒後に再試行。失敗時は「稼働中」として扱う
    console.warn('app_settings read failed:', e?.message || e);
  }
  return settingsCache.map;
}
const isOn = (map, key) => !(map.has(key) && map.get(key) === false);
const textSetting = (map, key, fallback) => (typeof map.get(key) === 'string' && map.get(key)) || fallback;

function getClientIp(req) {
  const headers = req.headers;
  const raw = headers['x-vercel-forwarded-for'] || headers['x-real-ip'] || headers['x-forwarded-for'] || req.socket?.remoteAddress;
  const ip = String(Array.isArray(raw) ? raw[0] : raw || '').split(',')[0].trim().replace(/^\[|\]$/g, '');
  return isIP(ip) ? ip : 'unknown';
}
function normalizeIp(ip) {
  let value = String(ip || '').trim().toLowerCase();
  if (value.startsWith('::ffff:')) value = value.slice(7);
  return value;
}
function hashIp(ip) {
  return crypto.createHash('sha256').update(IP_HASH_SECRET + ':' + normalizeIp(ip), 'utf8').digest('hex');
}
// BAN中のIPからはAI機能も使えない(secure.js と同じ banned_ip_addresses を参照)
async function assertIpNotBanned(ip) {
  const sb = getSupabase();
  if (!sb || !IP_HASH_SECRET || ip === 'unknown') return;
  const { data, error } = await sb.from('banned_ip_addresses').select('reason,expires_at').eq('ip_hash', hashIp(ip)).maybeSingle();
  if (error) { console.warn('ip ban check failed:', error.message); return; }
  if (data && (!data.expires_at || new Date(data.expires_at).getTime() > Date.now())) {
    throw Object.assign(new Error(data.reason || 'このIPアドレスからのアクセスは禁止されています'), { status: 403, code: 'ip_banned', event: 'ip_banned_request' });
  }
}

function getPool() {
  if (!process.env.TIDB_HOST || !process.env.TIDB_USER || !process.env.TIDB_PASSWORD || !process.env.TIDB_DATABASE) {
    throw new Error('TiDB環境変数 TIDB_HOST / TIDB_USER / TIDB_PASSWORD / TIDB_DATABASE を設定してください');
  }
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.TIDB_HOST,
      port: Number(process.env.TIDB_PORT || 4000),
      user: process.env.TIDB_USER,
      password: process.env.TIDB_PASSWORD,
      database: process.env.TIDB_DATABASE,
      ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      waitForConnections: true,
      // 接続を必要最小限にし、アイドル接続がメモリを占有し続けないようにする
      connectionLimit: 3,
      maxIdle: 1,
      idleTimeout: 30000,
      queueLimit: 20,
      enableKeepAlive: true
    });
  }
  return pool;
}

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
  }
  return supabase;
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function readSession(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !SESSION_SECRET) throw Object.assign(new Error('ログイン状態が切れました。再ログインしてください'), { status: 401 });
  const parts = token.split('.');
  if (parts.length !== 2) throw Object.assign(new Error('セッションが無効です'), { status: 401 });
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(parts[0]).digest('base64url');
  if (!safeEqual(signature, parts[1])) throw Object.assign(new Error('セッションが無効です'), { status: 401 });
  let data;
  try { data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch (_) { throw Object.assign(new Error('セッションが無効です'), { status: 401 }); }
  if (data.iss !== 'chanpro-gather' || !data.sub || Number(data.exp) <= Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error('セッションの有効期限が切れました。再ログインしてください'), { status: 401 });
  }
  return { id: String(data.sub), username: String(data.username || '') };
}

async function authenticate(req) {
  const session = readSession(req);
  const sb = getSupabase();
  // users は従来どおり Supabase に置いたまま、削除・BAN状態を毎回確認する
  if (sb) {
    const { data, error } = await sb.from('users')
      .select('id,username,role,ban_until')
      .eq('id', session.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error('ユーザーが見つかりません。再ログインしてください'), { status: 401 });
    if (data.ban_until && new Date(data.ban_until).getTime() > Date.now()) {
      throw Object.assign(new Error('このアカウントはBANされています'), { status: 403 });
    }
    return { ...session, username: data.username || session.username, role: data.role || 'user' };
  }
  return session;
}

async function rateLimit(db, ip, kind) {
  const [limit, seconds] = {
    image: [4, 1800], upload: [12, 600], speech: [30, 300], chat: [30, 300]
  }[kind];
  const normalized = normalizeIp(ip);
  const canonical = isIP(normalized) === 6 ? new URL('http://[' + normalized + ']').hostname : normalized;
  const key = crypto.createHmac('sha256', IP_HASH_SECRET || SESSION_SECRET).update(canonical).digest('hex');
  await db.execute(
    'INSERT IGNORE INTO ai_ip_limits (ip_key, action, window_start, request_count) VALUES (?, ?, UNIX_TIMESTAMP(), 0)',
    [key, kind]
  );
  const [result] = await db.execute(
    `UPDATE ai_ip_limits
        SET request_count = IF(window_start <= UNIX_TIMESTAMP() - ?, 1, request_count + 1),
            window_start = IF(window_start <= UNIX_TIMESTAMP() - ?, UNIX_TIMESTAMP(), window_start)
      WHERE ip_key = ? AND action = ?
        AND (window_start <= UNIX_TIMESTAMP() - ? OR request_count < ?)`,
    [seconds, seconds, key, kind, seconds, limit]
  );
  if (result.affectedRows !== 1) {
    throw Object.assign(new Error('\u5229\u7528\u56de\u6570\u306e\u4e0a\u9650\u306b\u9054\u3057\u307e\u3057\u305f\u3002\u6642\u9593\u3092\u304a\u3044\u3066\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002'), { status: 429, code: 'rate_limited' });
  }
}

function cleanText(value, max, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw Object.assign(new Error(`${label}を入力してください`), { status: 400 });
  if (text.length > max) throw Object.assign(new Error(`${label}は${max.toLocaleString('ja-JP')}文字以内にしてください`), { status: 400 });
  return text;
}

async function getOwnedConversation(db, conversationId, userId) {
  const id = String(conversationId || '');
  if (!/^\d{1,18}$/.test(id)) throw Object.assign(new Error('会話IDが不正です'), { status: 400 });
  const [rows] = await db.execute(
    'SELECT id, title FROM ai_conversations WHERE id = ? AND user_id = ? LIMIT 1',
    [id, userId]
  );
  if (!rows.length) throw Object.assign(new Error('会話が見つかりません'), { status: 404 });
  return rows[0];
}

async function createConversation(db, user, title) {
  const name = String(title || '新しいチャット').replace(/\s+/g, ' ').slice(0, 80) || '新しいチャット';
  const [result] = await db.execute(
    'INSERT INTO ai_conversations (user_id, title, created_at, updated_at) VALUES (?, ?, NOW(), NOW())',
    [user.id, name]
  );
  return { id: String(result.insertId), title: name };
}

async function saveMessage(db, { conversationId, userId, role, messageType = 'text', content = '', imageUrl = null, imageUrls = [] }) {
  const connection = await db.getConnection();
  try {
    await connection.query('BEGIN PESSIMISTIC');
    const [conversation] = await connection.execute(
      'SELECT id FROM ai_conversations WHERE id = ? AND user_id = ? FOR UPDATE', [conversationId, userId]
    );
    if (!conversation.length) throw Object.assign(new Error('\u4f1a\u8a71\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093'), { status: 404 });
    const [result] = await connection.execute(
      'INSERT INTO ai_messages (conversation_id,user_id,role,message_type,content,image_url,image_urls,created_at) VALUES (?,?,?,?,?,?,?,NOW())',
      [conversationId, userId, role, messageType, content, imageUrl, imageUrls.length ? JSON.stringify(imageUrls) : null]
    );
    const [rows] = await connection.execute(
      'SELECT id, role, message_type, content, image_url, image_urls, created_at FROM ai_messages WHERE id = ?', [result.insertId]
    );
    await connection.commit();
    return rows[0];
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function updateConversationTime(db, conversationId, userId) {
  await db.execute('UPDATE ai_conversations SET updated_at = NOW() WHERE id = ? AND user_id = ?', [conversationId, userId]);
}

async function handleList(db, user) {
  const [rows] = await db.execute(
    `SELECT id, title, created_at, updated_at
       FROM ai_conversations WHERE user_id = ?
      ORDER BY updated_at DESC, id DESC LIMIT 40`,
    [user.id]
  );
  return { ok: true, conversations: rows.map(row => ({ ...row, id: String(row.id) })) };
}

async function handleHistory(db, user, body) {
  const conversation = await getOwnedConversation(db, body.conversationId, user.id);
  const [rows] = await db.execute(
    `SELECT id, role, message_type, content, image_url, image_urls, created_at
       FROM (
         SELECT id, role, message_type, content, image_url, image_urls, created_at
           FROM ai_messages WHERE conversation_id = ? AND user_id = ?
          ORDER BY id DESC LIMIT 60
       ) recent ORDER BY id ASC`,
    [conversation.id, user.id]
  );
  return { ok: true, conversation: { ...conversation, id: String(conversation.id) }, messages: rows.map(row => ({ ...row, id: String(row.id) })) };
}

function readImageUrls(row) {
  let images = row.image_urls;
  if (typeof images === 'string') {
    try { images = JSON.parse(images); } catch { images = []; }
  }
  return Array.isArray(images) && images.length ? images : row.image_url ? [row.image_url] : [];
}

function inputImageUrls(body) {
  const images = body.imageUrls ?? (body.imageUrl ? [body.imageUrl] : []);
  if (!Array.isArray(images) || images.length > 4) {
    throw Object.assign(new Error('\u753b\u50cf\u306f4\u679a\u307e\u3067\u6dfb\u4ed8\u3067\u304d\u307e\u3059'), { status: 400 });
  }
  return [...new Set(images.map(validateImgBBUrl))];
}

async function callOpenAIChat(messages, user, customSystemPrompt, signal, voiceMode, model = OPENAI_CHAT_MODEL) {
  if (!OPENAI_API_KEY) throw Object.assign(new Error('Vercel環境変数 OPENAI_API_KEY が設定されていません'), { status: 503 });
  const formatted = messages.map(row => {
    const images = readImageUrls(row);
    if (row.role === 'user' && images.length) {
      return { role: row.role, content: [
        { type: 'text', text: String(row.content || 'この画像を確認してください').slice(0, 12000) },
        ...images.map(url => ({ type: 'image_url', image_url: { url, detail: 'auto' } }))
      ] };
    }
    return { role: row.role, content: String(row.content || '').slice(0, 12000) };
  });
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: (String(customSystemPrompt || '').trim() || 'あなたはChanProのAIアシスタントです。日本語で、わかりやすく、正確に回答してください。必要なら箇条書きで整理し、分からないことは分からないと伝えてください。ユーザーが画像を送った場合は、その画像の内容を確認して回答してください。').slice(0, 6000) },
        ...(voiceMode ? [{
          role: 'system',
          content: 'For the voice interface, start with exactly one label on its own line: [normal], [happy], [sad], [angry], [surprised], [sleepy] or [wink]. Pick the expression that best fits your reply, then write the actual answer on the next line. Use natural spoken language and keep the answer brief when the request allows it.'
        }] : []),
        ...formatted
      ],
      max_completion_tokens: 2500,
      store: false,
      user: crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 64)
    }),
    signal
  });
  const data = await response.json().catch(error => {
    if (signal?.aborted || error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
    return {};
  });
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI APIエラー (${response.status})`;
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502, code: data?.error?.code || `openai_${response.status}` });
  }
  const content = data?.choices?.[0]?.message?.content;
  const answer = typeof content === 'string' ? content.trim() : '';
  if (!answer) throw Object.assign(new Error('AIから回答を取得できませんでした'), { status: 502 });
  if (!voiceMode) return { answer, expression: 'normal' };
  const marker = answer.match(/^\[([a-z]+)\][ \t]*\r?\n/i);
  const expression = marker?.[1].toLowerCase();
  const text = marker && EXPRESSIONS.has(expression) ? answer.slice(marker[0].length).trim() : answer;
  return { answer: text || answer, expression: EXPRESSIONS.has(expression) ? expression : 'normal' };
}

function validateImgBBUrl(value) {
  const raw = String(value || '').trim();
  let url;
  try { url = new URL(raw); } catch (_) { throw Object.assign(new Error('画像URLが不正です'), { status: 400 }); }
  const storageOrigin = SUPABASE_URL ? new URL(SUPABASE_URL).origin : '';
  // Keep existing attachments usable after switching new uploads back to ImgBB.
  const storagePath = '/storage/v1/object/public/ai-input-images/';
  const ownStorage = url.origin === storageOrigin && url.pathname.startsWith(storagePath)
    && /^[a-f0-9-]{36}\.jpg$/i.test(url.pathname.slice(storagePath.length));
  const imgBB = /(^|\.)ibb\.co$|(^|\.)imgbb\.com$/i.test(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || (!ownStorage && !imgBB)) {
    throw Object.assign(new Error('\u5bfe\u5fdc\u3059\u308b\u753b\u50cfURL\u3092\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044'), { status: 400 });
  }
  return url.toString();
}

async function handleGetSettings(db, user) {
  const [rows] = await db.execute('SELECT system_prompt FROM ai_user_settings WHERE user_id = ? LIMIT 1', [user.id]);
  return { ok: true, systemPrompt: rows[0]?.system_prompt || '' };
}

async function handleSaveSettings(db, user, body) {
  const prompt = String(body.systemPrompt || '').trim();
  if (prompt.length > 6000) throw Object.assign(new Error('プロンプトは6,000文字以内にしてください'), { status: 400 });
  await db.execute(
    `INSERT INTO ai_user_settings (user_id, system_prompt, updated_at) VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE system_prompt = VALUES(system_prompt), updated_at = NOW()`,
    [user.id, prompt]
  );
  return { ok: true, systemPrompt: prompt };
}

async function handleDeleteConversation(db, user, body) {
  const id = String(body.conversationId || '');
  if (!/^\d{1,18}$/.test(id)) throw Object.assign(new Error('Invalid conversation ID'), { status: 400 });
  const connection = await db.getConnection();
  try {
    await connection.query('BEGIN PESSIMISTIC');
    const [rows] = await connection.execute(
      'SELECT id FROM ai_conversations WHERE id = ? AND user_id = ? FOR UPDATE', [id, user.id]
    );
    if (!rows.length) throw Object.assign(new Error('\u4f1a\u8a71\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093'), { status: 404 });
    await connection.execute('DELETE FROM ai_messages WHERE conversation_id = ? AND user_id = ?', [id, user.id]);
    await connection.execute('DELETE FROM ai_conversations WHERE id = ? AND user_id = ?', [id, user.id]);
    await connection.commit();
    return { ok: true, deleted: true, conversationId: id };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function handleChat(db, user, body, ctx) {
  await rateLimit(db, ctx.ip, 'chat');
  const message = String(body.message || '').trim();
  const imageUrls = inputImageUrls(body);
  const imageUrl = imageUrls[0] || null;
  const compare = body.compare === true && OPENAI_COMPARE_MODEL !== OPENAI_CHAT_MODEL;
  if (compare) await rateLimit(db, ctx.ip, 'chat');
  if (!message && !imageUrl) throw Object.assign(new Error('メッセージまたは画像を入力してください'), { status: 400 });
  if (message.length > 12000) throw Object.assign(new Error('メッセージは12,000文字以内にしてください'), { status: 400 });
  ctx.extra = { message_length: message.length, has_image: !!imageUrl, new_conversation: !body.conversationId };
  let conversation;
  if (body.conversationId) {
    conversation = await getOwnedConversation(db, body.conversationId, user.id);
  } else {
    conversation = await createConversation(db, user, (message || '画像について').slice(0, 80));
  }
  const conversationId = String(conversation.id);
  const conversationSummary = { id: conversationId, title: conversation.title };
  ctx.extra.conversation_id = conversationId;
  const userMessage = await saveMessage(db, {
    conversationId, userId: user.id, role: 'user',
    messageType: imageUrl ? 'image' : 'text',
    content: message || 'この画像について教えてください。', imageUrl, imageUrls
  });
  ctx.savedInput = { conversation: conversationSummary, message: { ...userMessage, id: String(userMessage.id) } };
  // 直近12件だけをAIへ渡す。古い会話全体を毎回読み込まないことでDB負荷を抑える。
  const [[history], [settingsRows]] = await Promise.all([db.execute(
    `SELECT role, message_type, content, image_url, image_urls FROM (
       SELECT role, message_type, content, image_url, image_urls, id FROM ai_messages
        WHERE conversation_id = ? AND user_id = ?
        ORDER BY id DESC LIMIT 12
     ) recent ORDER BY id ASC`,
    [conversationId, user.id]
  ), db.execute('SELECT system_prompt FROM ai_user_settings WHERE user_id = ? LIMIT 1', [user.id])]);
  for (const url of imageUrls) ctx.images.push({ kind: 'upload', url, via: 'chat' });
  const system = settingsRows[0]?.system_prompt || '';
  const primary = callOpenAIChat(history, user, system, ctx.signal, body.voiceMode === true);
  let reply;
  if (compare) {
    const results = await Promise.allSettled([
      primary, callOpenAIChat(history, user, system, ctx.signal, false, OPENAI_COMPARE_MODEL)
    ]);
    const fulfilled = results.find(result => result.status === 'fulfilled');
    if (!fulfilled) throw results[0].reason;
    const models = [OPENAI_CHAT_MODEL, OPENAI_COMPARE_MODEL];
    reply = {
      expression: fulfilled.value.expression,
      answer: results.map((result, index) => '## ' + models[index] + '\n' + (
        result.status === 'fulfilled' ? result.value.answer : '\u56de\u7b54\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f'
      )).join('\n\n')
    };
  } else reply = await primary;
  const { answer, expression } = reply;
  const saved = await saveMessage(db, { conversationId, userId: user.id, role: 'assistant', content: answer });
  await updateConversationTime(db, conversationId, user.id);
  ctx.extra.answer_length = answer.length;
  return {
    ok: true, conversationId, conversation: conversationSummary, expression,
    userMessage: ctx.savedInput.message,
    message: { ...saved, id: String(saved.id) }
  };
}

async function handleSpeech(db, user, body, ctx) {
  const conversation = await getOwnedConversation(db, body.conversationId, user.id);
  const messageId = String(body.messageId || '');
  if (!/^\d{1,18}$/.test(messageId)) throw Object.assign(new Error('Invalid message ID'), { status: 400 });
  const [rows] = await db.execute(
    "SELECT content FROM ai_messages WHERE id = ? AND conversation_id = ? AND user_id = ? AND role = 'assistant' AND message_type = 'text'",
    [messageId, conversation.id, user.id]
  );
  if (!rows[0]?.content) throw Object.assign(new Error('\u56de\u7b54\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093'), { status: 404 });
  if (!OPENAI_API_KEY) throw Object.assign(new Error('OPENAI_API_KEY is not configured'), { status: 503 });
  await rateLimit(db, ctx.ip, 'speech');
  const delivery = {
    happy: 'Bright, delighted, and genuinely enthusiastic, with a smile in the voice.',
    sad: 'Gentle, unhurried, and compassionate, with soft pauses.',
    angry: 'Firm and emphatic, with controlled intensity and no shouting.',
    surprised: 'Start with audible surprise, then settle into an engaged, animated delivery.',
    sleepy: 'Soft and relaxed, with a slower pace.',
    wink: 'Playful and lightly mischievous.',
    normal: 'Warm, expressive, and conversational; vary emphasis and pacing naturally.'
  };
  const expression = EXPRESSIONS.has(body.expression) ? body.expression : 'normal';
  const voice = VOICES.has(body.voice) ? body.voice : 'onyx';
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts', voice, instructions: delivery[expression], input: Array.from(rows[0].content).slice(0, 1800).join(''), response_format: 'mp3'
    }),
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(40000)])
  });
  if (!response.ok) throw Object.assign(new Error('\u97f3\u58f0\u3092\u751f\u6210\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f'), {
    status: response.status === 429 ? 429 : 502, code: `speech_${response.status}`
  });
  return { ok: true, audio: Buffer.from(await response.arrayBuffer()).toString('base64') };
}

async function uploadToImgBB(base64, signal, maxBytes = 3 * 1024 * 1024) {
  if (!IMGBB_API_KEY) throw Object.assign(new Error('Vercel環境変数 IMGBB_API_KEY が設定されていません'), { status: 503 });
  const clean = String(base64 || '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw Object.assign(new Error('画像データが不正です'), { status: 400 });
  const bytes = Buffer.from(clean, 'base64');
  if (!bytes.length || bytes.length > maxBytes) throw Object.assign(new Error(`画像は${Math.floor(maxBytes / 1024 / 1024)}MB以下にしてください`), { status: 413 });
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const isWebp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!isJpeg && !isPng && !isWebp) throw Object.assign(new Error('JPEG・PNG・WebP画像のみ送信できます'), { status: 400 });
  const form = new URLSearchParams();
  form.set('image', clean);
  form.set('name', `chanpro-ai-${Date.now()}`);
  const response = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(IMGBB_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(45000)])
  });
  const data = await response.json().catch(error => {
    if (signal?.aborted || error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
    return {};
  });
  if (!response.ok || !data?.success || !data?.data?.url) {
    throw Object.assign(new Error(data?.error?.message || 'ImgBBへの画像保存に失敗しました'), { status: 502 });
  }
  // display_urlではなく、画像データをそのまま取得できる元URLを保存する
  return { url: String(data.data.url), deleteUrl: data.data.delete_url ? String(data.data.delete_url) : null, size: bytes.length };
}

async function handleUpload(db, body, ctx) {
  await rateLimit(db, ctx.ip, 'upload');
  const up = await uploadToImgBB(body.imageBase64, ctx.signal);
  ctx.images.push({ kind: 'upload', url: up.url, delete_url: up.deleteUrl, size_bytes: up.size, via: 'upload' });
  return { ok: true, imageUrl: up.url };
}

async function callOpenAIImage(prompt, user, signal, imageUrls) {
  if (!OPENAI_API_KEY) throw Object.assign(new Error('Vercel環境変数 OPENAI_API_KEY が設定されていません'), { status: 503 });
  const editing = imageUrls.length > 0;
  const response = await fetch('https://api.openai.com/v1/images/' + (editing ? 'edits' : 'generations'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'low',
      output_format: 'webp',
      output_compression: 75,
      ...(editing ? { images: imageUrls.map(image_url => ({ image_url })) }
        : { safety_identifier: crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 64) })
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)])
  });
  const data = await response.json().catch(error => {
    if (signal?.aborted || error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
    return {};
  });
  if (!response.ok) {
    const message = data?.error?.message || `画像生成APIエラー (${response.status})`;
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502, code: data?.error?.code || `openai_image_${response.status}` });
  }
  const base64 = data?.data?.[0]?.b64_json;
  if (typeof base64 !== 'string' || !base64) throw Object.assign(new Error('画像生成結果を取得できませんでした'), { status: 502 });
  return uploadToImgBB(base64, signal, 8 * 1024 * 1024);
}

async function handleImage(db, user, body, ctx) {
  await rateLimit(db, ctx.ip, 'image');
  const imageUrls = inputImageUrls(body);
  const prompt = cleanText(body.prompt, 3000, '画像の説明');
  ctx.extra = { prompt_length: prompt.length, image_count: imageUrls.length };
  let conversation;
  if (body.conversationId) {
    conversation = await getOwnedConversation(db, body.conversationId, user.id);
  } else {
    conversation = await createConversation(db, user, (imageUrls.length ? "\u753b\u50cf\u7de8\u96c6: " : "\u753b\u50cf\u751f\u6210: ") + prompt.slice(0, 65));
  }
  const conversationId = String(conversation.id);
  const conversationSummary = { id: conversationId, title: conversation.title };
  ctx.extra.conversation_id = conversationId;
  const userMessage = await saveMessage(db, { conversationId, userId: user.id, role: 'user', content: (imageUrls.length ? '\u753b\u50cf\u7de8\u96c6: ' : '\u753b\u50cf\u751f\u6210: ') + prompt, imageUrl: imageUrls[0], imageUrls });
  ctx.savedInput = { conversation: conversationSummary, message: { ...userMessage, id: String(userMessage.id) } };
  for (const url of imageUrls) ctx.images.push({ kind: "upload", url, via: "image_edit" });
  const generated = await callOpenAIImage(prompt, user, ctx.signal, imageUrls);
  const imageUrl = generated.url;
  ctx.images.push({ kind: 'generated', url: imageUrl, delete_url: generated.deleteUrl, size_bytes: generated.size, via: 'image', prompt: prompt.slice(0, 200) });
  const saved = await saveMessage(db, {
    conversationId, userId: user.id, role: 'assistant', messageType: 'image',
    content: `画像を生成し、ImgBBに保存しました。\n内容: ${prompt}`,
    imageUrl
  });
  await updateConversationTime(db, conversationId, user.id);
  return { ok: true, conversationId, conversation: conversationSummary, userMessage: ctx.savedInput.message, message: { ...saved, id: String(saved.id) } };
}

/* ================= Axiom ログ(管理サイトの「AI利用」「画像」で表示) ================= */
const AXIOM_TIMEOUT_MS = 2500;
const blockedLogSeen = new Map();

async function ingestAxiom(events) {
  if (!AXIOM_TOKEN) { console.warn('AI Axiom logging skipped: AXIOM_TOKEN is not configured'); return; }
  if (!events.length) return;
  try {
    const response = await fetch(`https://api.axiom.co/v1/datasets/${encodeURIComponent(AXIOM_DATASET)}/ingest`, {
      method: 'POST', headers: { Authorization: `Bearer ${AXIOM_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(events), signal: AbortSignal.timeout(AXIOM_TIMEOUT_MS)
    });
    if (!response.ok) console.warn('AI Axiom log failed:', response.status);
  } catch (logError) { console.warn('AI Axiom log failed:', logError?.message || logError); }
}

// レスポンスを返した後に実行する(ユーザーを待たせない)
async function writeAiLogs({ ctx, status, startedAt, error, req }) {
  const headers = req?.headers || {};
  const latency = Math.max(0, Date.now() - Number(startedAt || Date.now()));
  const now = new Date().toISOString();
  const place = {
    country: headers['x-vercel-ip-country'] || null, region: headers['x-vercel-ip-country-region'] || null,
    city: (() => { try { return headers['x-vercel-ip-city'] ? decodeURIComponent(headers['x-vercel-ip-city']) : null; } catch (_) { return null; } })()
  };
  const who = { user_id: ctx.user?.id ? String(ctx.user.id).slice(0, 64) : null, username: ctx.user?.username || null };
  const events = [{
    _time: now, source: 'chanpro-ai-api', type: 'ai_api',
    action: String(ctx.action || 'unknown').slice(0, 40), ...who, ip: ctx.ip || null,
    request_id: headers['x-vercel-id'] || null,
    http_status: Number(status) || 500, latency_ms: latency, ms: latency,
    error_code: error?.code ? String(error.code).slice(0, 80) : null,
    error_message: error ? String(error.message || 'AI API error').slice(0, 500) : null,
    method: req?.method || null, user_agent: String(headers['user-agent'] || '').slice(0, 200) || null,
    ...place, ...(ctx.extra || {})
  }];
  if (error?.event === 'ip_banned_request') events.push({ _time: now, source: 'chanpro-ai-api', type: 'ip_banned_request', ip: ctx.ip, action: `ai:${ctx.action}`, reason: String(error.message).slice(0, 200), ...place });
  if (error?.feature) {
    const seenKey = `${ctx.user?.id || ctx.ip}|${error.feature}`;
    if ((blockedLogSeen.get(seenKey) || 0) < Date.now() - 60000) {
      blockedLogSeen.set(seenKey, Date.now()); if (blockedLogSeen.size > 3000) blockedLogSeen.clear();
      events.push({ _time: now, source: 'chanpro-ai-api', type: 'feature_blocked', feature: error.feature, feature_label: AI_FEATURES[error.feature]?.label || error.feature, action: `ai:${ctx.action}`, ip: ctx.ip, ...who, ...place });
    }
  }
  if (error?.maintenance) {
    const seenKey = 'server';
    if ((blockedLogSeen.get(seenKey) || 0) < Date.now() - 30000) { blockedLogSeen.set(seenKey, Date.now()); events.push({ _time: now, source: 'chanpro-ai-api', type: 'server_blocked', action: `ai:${ctx.action}`, reason: 'server_disabled', ip: ctx.ip, ...place }); }
  }
  for (const image of ctx.images || []) {
    events.push({ _time: now, source: 'chanpro-ai-api', type: 'ai_image_upload', ...who, ip: ctx.ip, kind: image.kind, via: image.via, url: image.url, delete_url: image.delete_url || undefined, size_bytes: image.size_bytes || undefined, prompt: image.prompt || undefined });
  }
  await ingestAxiom(events);
}

module.exports = async (req, res) => {
  const startedAt = Date.now();
  const ctx = { action: 'unknown', user: null, ip: getClientIp(req), extra: null, images: [] };
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let status = 200;
  let payload = null;
  let error = null;
  try {
    if (req.method !== 'POST') throw Object.assign(new Error('POST only'), { status: 405 });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    ctx.action = String(body.action || 'unknown').slice(0, 40);
    const upstreamBudget = ctx.action === 'image' ? 215000 : 90000;
    ctx.signal = AbortSignal.timeout(Math.max(1, upstreamBudget - (Date.now() - startedAt)));
    if (['chat', 'image', 'upload', 'speech'].includes(ctx.action)) {
      console.info('AI request started', { action: ctx.action, requestId: req.headers['x-vercel-id'] });
    }

    // 1) サーバー全体の停止(管理サイトの「停止設定」)
    const [settingsCheck, ipCheck, authCheck] = await Promise.allSettled([
      getSettings(), assertIpNotBanned(ctx.ip), authenticate(req)
    ]);
    if (settingsCheck.status === 'rejected') throw settingsCheck.reason;
    const settings = settingsCheck.value;
    if (!isOn(settings, 'server_enabled')) {
      res.setHeader('Retry-After', '60');
      throw Object.assign(new Error(textSetting(settings, 'server_disabled_message', '現在サーバーを停止しています。しばらくしてからもう一度お試しください')), { status: 503, code: 'server_disabled', maintenance: true });
    }
    // 2) IP BAN
    if (ipCheck.status === 'rejected') throw ipCheck.reason;
    // 3) 認証(BAN中のアカウントは拒否)
    if (authCheck.status === 'rejected') throw authCheck.reason;
    ctx.user = authCheck.value;
    // 4) 機能ごとの停止(admin / developer は対象外)
    const featureKey = FEATURE_OF_ACTION[ctx.action];
    if (featureKey && !['admin', 'developer'].includes(ctx.user.role) && !isOn(settings, `feature_${featureKey}`)) {
      throw Object.assign(new Error(textSetting(settings, `feature_${featureKey}_message`, `現在、「${AI_FEATURES[featureKey].label}」機能を停止しています。しばらくしてからもう一度お試しください`)), { status: 503, code: 'feature_disabled', feature: featureKey });
    }

    const user = ctx.user;
    const db = getPool();
    switch (ctx.action) {
      case 'list': payload = await handleList(db, user); break;
      case 'settings': payload = await handleGetSettings(db, user); break;
      case 'save-settings': payload = await handleSaveSettings(db, user, body); break;
      case 'delete': payload = await handleDeleteConversation(db, user, body); break;
      case 'history': payload = await handleHistory(db, user, body); break;
      case 'speech': payload = await handleSpeech(db, user, body, ctx); break;
      case 'chat': payload = await handleChat(db, user, body, ctx); break;
      case 'image': payload = await handleImage(db, user, body, ctx); break;
      case 'upload': payload = await handleUpload(db, body, ctx); break;
      default: throw Object.assign(new Error('未対応のAI操作です'), { status: 400 });
    }
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    if (timedOut) {
      e = Object.assign(new Error('AI処理がタイムアウトしました。'), { status: 504, code: 'ai_upstream_timeout' });
    }
    error = e;
    status = Number(e.status) || 500;
    if (!e.maintenance && !e.feature && e.code !== 'ip_banned') {
      console.error('AI API error', {
        action: ctx.action, status, code: e.code, requestId: req.headers['x-vercel-id'],
        conversationId: ctx.extra?.conversation_id, latencyMs: Date.now() - startedAt,
        message: e.message
      });
    }
    payload = { ok: false, error: e.message || 'AI処理に失敗しました' };
    if (e.code) payload.code = e.code;
    if (ctx.savedInput && status !== 404) payload.savedInput = ctx.savedInput;
    if (e.feature) payload.feature = e.feature;
    if (e.maintenance) payload.maintenance = true;
  }
  try {
    await writeAiLogs({ ctx, status, startedAt, error, req });
  } finally {
    sendJson(res, status, payload);
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '5mb' } } };
