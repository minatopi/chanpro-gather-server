'use strict';

const mysql = require('mysql2/promise');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-6-luna';
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
const requestWindows = new Map();

/* ================= 管理サイト連携: 停止設定(app_settings) ================= */
// 管理サイトの「停止設定」と同じキー: server_enabled(全通信を拒否) / feature_ai_chat / feature_ai_image / feature_ai_upload
// admin / developer は機能停止の対象外(サーバー全体の停止は全員が対象)
const AI_FEATURES = {
  ai_chat: { label: 'AIチャット', actions: ['chat', 'history', 'list', 'delete', 'settings', 'save-settings'] },
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
  const real = req.headers['x-real-ip'];
  const forwarded = req.headers['x-forwarded-for'];
  const raw = (Array.isArray(real) ? real[0] : real) || (Array.isArray(forwarded) ? forwarded[0] : String(forwarded || '').split(',')[0]);
  const ip = String(raw || '').trim().replace(/^\[|\]$/g, '');
  return ip && ip.length <= 100 && /^[0-9a-fA-F:.%a-zA-Z0-9_-]+$/.test(ip) ? ip : 'unknown';
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

function rateLimit(userId, kind) {
  const now = Date.now();
  const config = kind === 'image' ? [4, 30 * 60 * 1000] : kind === 'upload' ? [12, 10 * 60 * 1000] : [30, 5 * 60 * 1000];
  const [limit, windowMs] = config;
  const key = `${userId}:${kind}`;
  let current = requestWindows.get(key);
  if (!current || now - current.startedAt >= windowMs) current = { startedAt: now, count: 0 };
  if (current.count >= limit) {
    requestWindows.set(key, current);
    throw Object.assign(new Error(kind === 'image'
      ? '画像生成の回数制限に達しました。しばらく待ってから再度お試しください'
      : kind === 'upload' ? '画像の送信回数が多すぎます。しばらく待ってください'
      : '送信回数が多すぎます。少し待ってから再度お試しください'), { status: 429, code: 'rate_limited' });
  }
  current.count++;
  requestWindows.set(key, current);
  // Mapを際限なく増やさず、期限切れのカウンターを定期的に掃除する
  if (requestWindows.size > 1200) {
    for (const [k, v] of requestWindows) if (now - v.startedAt > 60 * 60 * 1000) requestWindows.delete(k);
    if (requestWindows.size > 2000) requestWindows.clear();
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
  const [result] = await db.execute(
    'INSERT INTO ai_conversations (user_id, title, created_at, updated_at) VALUES (?, ?, NOW(), NOW())',
    [user.id, String(title || '新しいチャット').replace(/\s+/g, ' ').slice(0, 80) || '新しいチャット']
  );
  return String(result.insertId);
}

async function saveMessage(db, { conversationId, userId, role, messageType = 'text', content = '', imageUrl = null }) {
  const [result] = await db.execute(
    `INSERT INTO ai_messages
      (conversation_id, user_id, role, message_type, content, image_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [conversationId, userId, role, messageType, content, imageUrl]
  );
  const [rows] = await db.execute(
    `SELECT id, role, message_type, content, image_url, created_at
       FROM ai_messages WHERE id = ? LIMIT 1`,
    [result.insertId]
  );
  return rows[0];
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
    `SELECT id, role, message_type, content, image_url, created_at
       FROM (
         SELECT id, role, message_type, content, image_url, created_at
           FROM ai_messages WHERE conversation_id = ? AND user_id = ?
          ORDER BY id DESC LIMIT 60
       ) recent ORDER BY id ASC`,
    [conversation.id, user.id]
  );
  return { ok: true, conversation: { ...conversation, id: String(conversation.id) }, messages: rows.map(row => ({ ...row, id: String(row.id) })) };
}

async function callOpenAIChat(messages, user, customSystemPrompt = '') {
  if (!OPENAI_API_KEY) throw Object.assign(new Error('Vercel環境変数 OPENAI_API_KEY が設定されていません'), { status: 503 });
  const formatted = messages.map(row => {
    if (row.image_url) {
      return { role: row.role, content: [
        { type: 'text', text: String(row.content || 'この画像を確認してください').slice(0, 12000) },
        { type: 'image_url', image_url: { url: row.image_url, detail: 'auto' } }
      ] };
    }
    return { role: row.role, content: String(row.content || '').slice(0, 12000) };
  });
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_CHAT_MODEL,
      messages: [
        { role: 'system', content: (String(customSystemPrompt || '').trim() || 'あなたはChanProのAIアシスタントです。日本語で、わかりやすく、正確に回答してください。必要なら箇条書きで整理し、分からないことは分からないと伝えてください。ユーザーが画像を送った場合は、その画像の内容を確認して回答してください。').slice(0, 6000) },
        ...formatted
      ],
      max_completion_tokens: 2500,
      store: false,
      user: crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 64)
    }),
    signal: AbortSignal.timeout(90000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI APIエラー (${response.status})`;
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502, code: data?.error?.code || `openai_${response.status}` });
  }
  const content = data?.choices?.[0]?.message?.content;
  const answer = typeof content === 'string' ? content.trim() : '';
  if (!answer) throw Object.assign(new Error('AIから回答を取得できませんでした'), { status: 502 });
  return answer;
}

function validateImgBBUrl(value) {
  const raw = String(value || '').trim();
  let url;
  try { url = new URL(raw); } catch (_) { throw Object.assign(new Error('画像URLが不正です'), { status: 400 }); }
  if (url.protocol !== 'https:' || !/(^|\.)ibb\.co$|(^|\.)imgbb\.com$/i.test(url.hostname)) {
    throw Object.assign(new Error('ImgBBに保存された画像だけ利用できます'), { status: 400 });
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
  const conversation = await getOwnedConversation(db, body.conversationId, user.id);
  await db.execute('DELETE FROM ai_conversations WHERE id = ? AND user_id = ?', [conversation.id, user.id]);
  return { ok: true, deleted: true, conversationId: String(conversation.id) };
}

async function handleChat(db, user, body, ctx) {
  rateLimit(user.id, 'chat');
  const message = String(body.message || '').trim();
  const imageUrl = body.imageUrl ? validateImgBBUrl(body.imageUrl) : null;
  if (!message && !imageUrl) throw Object.assign(new Error('メッセージまたは画像を入力してください'), { status: 400 });
  if (message.length > 12000) throw Object.assign(new Error('メッセージは12,000文字以内にしてください'), { status: 400 });
  ctx.extra = { message_length: message.length, has_image: !!imageUrl, new_conversation: !body.conversationId };
  let conversationId;
  if (body.conversationId) {
    const conversation = await getOwnedConversation(db, body.conversationId, user.id);
    conversationId = String(conversation.id);
  } else {
    conversationId = await createConversation(db, user, (message || '画像について').slice(0, 80));
  }
  const userMessage = await saveMessage(db, {
    conversationId, userId: user.id, role: 'user',
    messageType: imageUrl ? 'image' : 'text',
    content: message || 'この画像について教えてください。', imageUrl
  });
  // 直近12件だけをAIへ渡す。古い会話全体を毎回読み込まないことでDB負荷を抑える。
  const [history] = await db.execute(
    `SELECT role, message_type, content, image_url FROM (
       SELECT role, message_type, content, image_url, id FROM ai_messages
        WHERE conversation_id = ? AND user_id = ?
        ORDER BY id DESC LIMIT 12
     ) recent ORDER BY id ASC`,
    [conversationId, user.id]
  );
  const [settingsRows] = await db.execute('SELECT system_prompt FROM ai_user_settings WHERE user_id = ? LIMIT 1', [user.id]);
  const answer = await callOpenAIChat(history, user, settingsRows[0]?.system_prompt || '');
  const saved = await saveMessage(db, { conversationId, userId: user.id, role: 'assistant', content: answer });
  await updateConversationTime(db, conversationId, user.id);
  ctx.extra.answer_length = answer.length;
  // 画像つきの質問は、管理サイトで画像を確認できるようログにURLを残す
  if (imageUrl) ctx.images.push({ kind: 'upload', url: imageUrl, via: 'chat' });
  return {
    ok: true, conversationId,
    userMessage: { ...userMessage, id: String(userMessage.id) },
    message: { ...saved, id: String(saved.id) }
  };
}

async function uploadToImgBB(base64, maxBytes = 3 * 1024 * 1024) {
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
    signal: AbortSignal.timeout(45000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.success || !data?.data?.url) {
    throw Object.assign(new Error(data?.error?.message || 'ImgBBへの画像保存に失敗しました'), { status: 502 });
  }
  // display_urlではなく、画像データをそのまま取得できる元URLを保存する
  return { url: String(data.data.url), deleteUrl: data.data.delete_url ? String(data.data.delete_url) : null, size: bytes.length };
}

async function handleUpload(user, body, ctx) {
  rateLimit(user.id, 'upload');
  const up = await uploadToImgBB(body.imageBase64);
  ctx.images.push({ kind: 'upload', url: up.url, delete_url: up.deleteUrl, size_bytes: up.size, via: 'upload' });
  return { ok: true, imageUrl: up.url };
}

async function callOpenAIImage(prompt, user) {
  if (!OPENAI_API_KEY) throw Object.assign(new Error('Vercel環境変数 OPENAI_API_KEY が設定されていません'), { status: 503 });
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
      safety_identifier: crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 64)
    }),
    signal: AbortSignal.timeout(180000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `画像生成APIエラー (${response.status})`;
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502, code: data?.error?.code || `openai_image_${response.status}` });
  }
  const base64 = data?.data?.[0]?.b64_json;
  if (typeof base64 !== 'string' || !base64) throw Object.assign(new Error('画像生成結果を取得できませんでした'), { status: 502 });
  return uploadToImgBB(base64, 8 * 1024 * 1024);
}

async function handleImage(db, user, body, ctx) {
  rateLimit(user.id, 'image');
  const prompt = cleanText(body.prompt, 3000, '画像の説明');
  ctx.extra = { prompt_length: prompt.length };
  let conversationId;
  if (body.conversationId) {
    const conversation = await getOwnedConversation(db, body.conversationId, user.id);
    conversationId = String(conversation.id);
  } else {
    conversationId = await createConversation(db, user, `画像生成: ${prompt.slice(0, 65)}`);
  }
  await saveMessage(db, { conversationId, userId: user.id, role: 'user', content: `画像生成: ${prompt}` });
  const generated = await callOpenAIImage(prompt, user);
  const imageUrl = generated.url;
  const saved = await saveMessage(db, {
    conversationId, userId: user.id, role: 'assistant', messageType: 'image',
    content: `画像を生成し、ImgBBに保存しました。\n内容: ${prompt}`,
    imageUrl
  });
  await updateConversationTime(db, conversationId, user.id);
  ctx.images.push({ kind: 'generated', url: imageUrl, delete_url: generated.deleteUrl, size_bytes: generated.size, via: 'image', prompt: prompt.slice(0, 200) });
  return { ok: true, conversationId, message: { ...saved, id: String(saved.id) } };
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

    // 1) サーバー全体の停止(管理サイトの「停止設定」)
    const settings = await getSettings();
    if (!isOn(settings, 'server_enabled')) {
      res.setHeader('Retry-After', '60');
      throw Object.assign(new Error(textSetting(settings, 'server_disabled_message', '現在サーバーを停止しています。しばらくしてからもう一度お試しください')), { status: 503, code: 'server_disabled', maintenance: true });
    }
    // 2) IP BAN
    await assertIpNotBanned(ctx.ip);
    // 3) 認証(BAN中のアカウントは拒否)
    ctx.user = await authenticate(req);
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
      case 'chat': payload = await handleChat(db, user, body, ctx); break;
      case 'image': payload = await handleImage(db, user, body, ctx); break;
      case 'upload': payload = await handleUpload(user, body, ctx); break;
      default: throw Object.assign(new Error('未対応のAI操作です'), { status: 400 });
    }
  } catch (e) {
    error = e;
    status = Number(e.status) || 500;
    if (!e.maintenance && !e.feature && e.code !== 'ip_banned') console.error('AI API error:', e?.message || e);
    payload = { ok: false, error: e.message || 'AI処理に失敗しました' };
    if (e.feature) payload.feature = e.feature;
    if (e.maintenance) payload.maintenance = true;
  }
  sendJson(res, status, payload);
  await writeAiLogs({ ctx, status, startedAt, error, req });
};

module.exports.config = { api: { bodyParser: { sizeLimit: '5mb' } } };
