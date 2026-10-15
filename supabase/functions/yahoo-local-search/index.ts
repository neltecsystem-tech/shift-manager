import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

// Yahoo!ローカルサーチの中継(新聞ツール 店舗マスタの住所一括補完 smBatchAddrUnified が使う)。
// 🔒 2026-10-15: 版管理へ取り込み。それまで認証が無く、誰でも当社の appid で検索を代理実行できた
//    (appid もコードに直書き)。appid は秘密情報 YAHOO_CLIENT_ID へ、呼び出しは新聞ツールのログイン必須に。
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const YAHOO_CLIENT_ID = Deno.env.get('YAHOO_CLIENT_ID') || '';
const BASE_URL = 'https://map.yahooapis.jp/search/local/V1/localSearch';

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json();
    if (!(await verifyToken(body.auth_token))) return json({ error: 'ログインが必要です', code: 'AUTH_REQUIRED' }, 401);
    if (!YAHOO_CLIENT_ID) return json({ error: 'YAHOO_CLIENT_ID が未設定です' }, 500);
    const query = String(body.query || '').trim().slice(0, 200);
    const lat = body.lat;
    const lon = body.lon;
    const dist = body.dist; // km
    const gc = body.gc; // genre code (例: 0202=コンビニ)
    const results = Math.min(Math.max(Number(body.results) || 3, 1), 10);
    if (!query) return json({ error: 'query required' }, 400);

    const params = new URLSearchParams();
    params.set('appid', YAHOO_CLIENT_ID);
    params.set('query', query);
    params.set('output', 'json');
    params.set('results', String(results));
    if (lat != null && lon != null) {
      params.set('lat', String(lat));
      params.set('lon', String(lon));
    }
    if (dist != null) params.set('dist', String(dist));
    if (gc) params.set('gc', String(gc));

    const url = `${BASE_URL}?${params.toString()}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'shift-manager/1.0' } });
    if (!resp.ok) {
      const text = await resp.text();
      return json({ error: `Yahoo API error ${resp.status}: ${text.slice(0, 300)}` }, 502);
    }
    const data = await resp.json();
    const features = (data.Feature || []).map((f: any) => {
      const coords = f.Geometry?.Coordinates || '';
      const [lng, lt] = coords.split(',').map(Number);
      return {
        name: f.Name || '',
        address: f.Property?.Address || '',
        lat: isFinite(lt) ? lt : null,
        lng: isFinite(lng) ? lng : null,
        tel: f.Property?.Tel1 || '',
        match_level: f.Property?.AddressMatchingLevel || '',
      };
    });
    return json({
      count: data.ResultInfo?.Count || 0,
      total: data.ResultInfo?.Total || 0,
      features,
    });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
