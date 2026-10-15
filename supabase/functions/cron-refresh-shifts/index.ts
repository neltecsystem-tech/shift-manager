import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const SHIFT_SPREADSHEET = '1yVKQLSmdc9RZ2U5m4CIPqAl4JqP9siiSeSRP0z3SEEM';
const SA = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY'));
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret'
};
function b64url(d) {
  return btoa(d).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({
    alg: 'RS256',
    typ: 'JWT'
  }));
  const p = b64url(JSON.stringify({
    iss: SA.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: SA.token_uri,
    iat: now,
    exp: now + 3600
  }));
  const pk = SA.private_key.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\n/g, '');
  const der = Uint8Array.from(atob(pk), (c)=>c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256'
  }, false, [
    'sign'
  ]);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
  const s = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch(SA.token_uri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${h}.${p}.${s}`
  });
  return (await r.json()).access_token;
}
async function fetchSheet(token, sheetName) {
  // 行番号を指定しない開放レンジ A:ZZ。シートが何行に増えても全行取得できる
  // (Sheets API は末尾の空行/空列を自動で省くため無駄も出ない)。
  // ※以前は A1:ZZ500 固定で、500行超の Section2(引継/応援スタッフ等)が丸ごと欠落していた。
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHIFT_SPREADSHEET}/values/${encodeURIComponent(sheetName)}!A:ZZ`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`fetchSheet ${sheetName} failed: ${resp.status} ${err.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.values || [];
}
// 現在月と翌月の sheet 名 (JST)。
// 加えて月初 7 日間は前月も対象とする (前月の支払い明細作成期間をカバー)。
function targetSheetNames() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth() + 1;
  const day = jst.getUTCDate();
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const sheets = [
    `${month}月シフト${year}`,
    `${nextMonth}月シフト${nextYear}`
  ];
  if (day <= 7) sheets.unshift(`${prevMonth}月シフト${prevYear}`);
  return sheets;
}
// ---- 新聞ツールのログイントークン検証 (2026-10-15) ----
// invoice-sheet が発行するトークン(HMAC・SHIFT_SESSION_SECRET)と同じ方式で確かめる(diagram-process と同じ実装)。
const SESSION_SECRET = Deno.env.get('SHIFT_SESSION_SECRET') || '';
function b64urlDecode(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function hmacSign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function verifyToken(token: unknown): Promise<any | null> {
  if (!SESSION_SECRET || !token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const expected = await hmacSign(parts[0]);
    if (parts[1].length !== expected.length) return null;
    let diff = 0; for (let i = 0; i < expected.length; i++) diff |= parts[1].charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff !== 0) return null;
    const claims = JSON.parse(b64urlDecode(parts[0]));
    if (claims.exp && claims.exp < Date.now()) return null;
    return claims;
  } catch { return null; }
}

Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsHeaders
  });
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabase = createClient(supabaseUrl, serviceKey);
  let body = {};
  try {
    body = await req.json();
  } catch (_) {}
  // 🔒 2026-10-15: それまで認証が無く、誰でもシフト表の取り直し(キャッシュの上書き)を走らせられ、
  //    シート名を自由に渡せた。通すのは cron(x-cron-secret) / サーバー(service role) / 新聞ツールにログイン中の人。
  //    シート名は「N月シフトYYYY」の形だけ受け付ける。
  const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const allowed = (!!CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET)
    || (!!serviceKey && bearer === serviceKey)
    || !!(await verifyToken(body.auth_token));
  if (!allowed) return new Response(JSON.stringify({ error: 'ログインが必要です' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  const requested = Array.isArray(body.sheets) ? body.sheets.filter((n)=>typeof n === 'string' && /^\d{1,2}月シフト\d{4}$/.test(n)).slice(0, 6) : [];
  const sheets = requested.length ? requested : targetSheetNames();
  const results = [];
  let token;
  try {
    token = await getToken();
  } catch (e) {
    return new Response(JSON.stringify({
      error: 'Token failed: ' + e.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  for (const name of sheets){
    try {
      const rows = await fetchSheet(token, name);
      if (!rows.length) {
        results.push({
          sheet: name,
          status: 'empty'
        });
        await supabase.from('shift_sheet_cache').upsert({
          sheet_name: name,
          rows: [],
          status: 'empty',
          last_error: null,
          updated_at: new Date().toISOString()
        });
        continue;
      }
      const { error } = await supabase.from('shift_sheet_cache').upsert({
        sheet_name: name,
        rows: rows,
        status: 'ok',
        last_error: null,
        updated_at: new Date().toISOString()
      });
      if (error) throw error;
      results.push({
        sheet: name,
        status: 'ok',
        rows: rows.length
      });
    } catch (e) {
      results.push({
        sheet: name,
        status: 'error',
        message: e.message
      });
      await supabase.from('shift_sheet_cache').update({
        status: 'error',
        last_error: e.message,
        updated_at: new Date().toISOString()
      }).eq('sheet_name', name);
    }
  }
  return new Response(JSON.stringify({
    ok: true,
    results
  }), {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
});
