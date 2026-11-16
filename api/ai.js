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

let pool;
let supabase;
const requestWindows = new Map();

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
      connectionLimit: 5,
      maxIdle: 2,
      idleTimeout: 60000,
      queueLimit: 0,
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
  const limit = kind === 'image' ? 4 : 30;
  const windowMs = kind === 'image' ? 30 * 60 * 1000 : 5 * 60 * 1000;
  const key = `${userId}:${kind}`;
  const current = (requestWindows.get(key) || []).filter(t => now - t < windowMs);
  if (current.length >= limit) {
    requestWindows.set(key, current);
    throw Object.assign(new Error(kind === 'image'
      ? '画像生成の回数制限に達しました。しばらく待ってから再度お試しください'
      : '送信回数が多すぎます。少し待ってから再度お試しください'), { status: 429 });
  }
  current.push(now);
  requestWindows.set(key, current);
  if (requestWindows.size > 5000) requestWindows.clear();
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
          ORDER BY id DESC LIMIT 80
       ) recent ORDER BY id ASC`,
    [conversation.id, user.id]
  );
  return { ok: true, conversation: { ...conversation, id: String(conversation.id) }, messages: rows.map(row => ({ ...row, id: String(row.id) })) };
}

async function callOpenAIChat(messages, user) {
  if (!OPENAI_API_KEY) throw Object.assign(new Error('Vercel環境変数 OPENAI_API_KEY が設定されていません'), { status: 503 });
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_CHAT_MODEL,
      messages: [
        { role: 'system', content: 'あなたはChanProのAIアシスタントです。日本語で、わかりやすく、正確に回答してください。必要なら箇条書きで整理し、分からないことは分からないと伝えてください。' },
        ...messages
      ],
      max_completion_tokens: 3000,
      user: crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 64)
    }),
    signal: AbortSignal.timeout(90000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI APIエラー (${response.status})`;
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502 });
  }
  const content = data?.choices?.[0]?.message?.content;
  const answer = typeof content === 'string' ? content.trim() : '';
  if (!answer) throw Object.assign(new Error('AIから回答を取得できませんでした'), { status: 502 });
  return answer;
}

async function handleChat(db, user, body) {
  rateLimit(user.id, 'chat');
  const message = cleanText(body.message, 12000, 'メッセージ');
  let conversationId;
  if (body.conversationId) {
    const conversation = await getOwnedConversation(db, body.conversationId, user.id);
    conversationId = String(conversation.id);
  } else {
    conversationId = await createConversation(db, user, message.slice(0, 80));
  }
  await saveMessage(db, { conversationId, userId: user.id, role: 'user', content: message });
  const [history] = await db.execute(
    `SELECT role, content FROM (
       SELECT role, content, id FROM ai_messages
        WHERE conversation_id = ? AND user_id = ? AND message_type = 'text'
        ORDER BY id DESC LIMIT 20
     ) recent ORDER BY id ASC`,
    [conversationId, user.id]
  );
  const answer = await callOpenAIChat(history.map(row => ({ role: row.role, content: row.content })), user);
  const saved = await saveMessage(db, { conversationId, userId: user.id, role: 'assistant', content: answer });
  await updateConversationTime(db, conversationId, user.id);
  return { ok: true, conversationId, message: { ...saved, id: String(saved.id) } };
}

async function uploadToImgBB(base64) {
  if (!IMGBB_API_KEY) throw Object.assign(new Error('Vercel環境変数 IMGBB_API_KEY が設定されていません'), { status: 503 });
  const form = new URLSearchParams();
  form.set('image', base64);
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
  return String(data.data.url);
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
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502 });
  }
  const base64 = data?.data?.[0]?.b64_json;
  if (typeof base64 !== 'string' || !base64) throw Object.assign(new Error('画像生成結果を取得できませんでした'), { status: 502 });
  return uploadToImgBB(base64);
}

async function handleImage(db, user, body) {
  rateLimit(user.id, 'image');
  const prompt = cleanText(body.prompt, 3000, '画像の説明');
  let conversationId;
  if (body.conversationId) {
    const conversation = await getOwnedConversation(db, body.conversationId, user.id);
    conversationId = String(conversation.id);
  } else {
    conversationId = await createConversation(db, user, `画像生成: ${prompt.slice(0, 65)}`);
  }
  await saveMessage(db, { conversationId, userId: user.id, role: 'user', content: `画像生成: ${prompt}` });
  const imageUrl = await callOpenAIImage(prompt, user);
  const saved = await saveMessage(db, {
    conversationId, userId: user.id, role: 'assistant', messageType: 'image',
    content: `画像を生成し、ImgBBに保存しました。\n内容: ${prompt}`,
    imageUrl
  });
  await updateConversationTime(db, conversationId, user.id);
  return { ok: true, conversationId, message: { ...saved, id: String(saved.id) } };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') {
      const db = getPool();
      const [rows] = await db.query('SELECT VERSION() AS version, DATABASE() AS database_name');
      return sendJson(res, 200, { ok: true, provider: 'TiDB Cloud', ...rows[0] });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET / POST only' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String(body.action || '');
    const user = await authenticate(req);
    const db = getPool();
    let result;
    switch (action) {
      case 'list': result = await handleList(db, user); break;
      case 'history': result = await handleHistory(db, user, body); break;
      case 'chat': result = await handleChat(db, user, body); break;
      case 'image': result = await handleImage(db, user, body); break;
      default: return sendJson(res, 400, { ok: false, error: '未対応のAI操作です' });
    }
    return sendJson(res, 200, result);
  } catch (error) {
    console.error('AI API error:', error?.message || error);
    return sendJson(res, error.status || 500, { ok: false, error: error.message || 'AI処理に失敗しました' });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '2mb' } } };
