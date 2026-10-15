import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SPREADSHEET_ID = '1Owv83TGxSl15pqO0MaaF4AaLeslye0frfKAuo62TlGY';
const SHEET_NAME = '店舗マスタ';
const GEOCODING_KEY = Deno.env.get('GOOGLE_GEOCODING_KEY')!;

const SERVICE_ACCOUNT = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY')!);

function b64url(s: string): string { return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: SERVICE_ACCOUNT.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const pemBody = SERVICE_ACCOUNT.private_key.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\n/g, '');
  const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', binaryDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${header}.${payload}.${sigB64}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  return (await r.json()).access_token;
}

function expandAbbrev(s: string): string {
  return s
    .replace(/^LATF/, 'ローソンスリーエフ')
    .replace(/^LS/, 'ローソンストア100')
    .replace(/^LA/, 'ローソン')
    .replace(/^FM/, 'ファミリーマート')
    .replace(/^F(?=[^MA])/, 'ファミリーマート')
    .replace(/^NL/, 'ナチュラルローソン')
    .replace(/^MS/, 'ミニストップ')
    .replace(/^T\][7７]/, 'セブンイレブン')
    .replace(/^D[)\]]/, 'デイリーヤマザキ')
    .replace(/^YS/, 'ヤマザキY')
    .replace(/^SY/, '西友');
}

function normName(s: string): string {
  if (!s) return '';
  const kanjiToDigit = (c: string) => {
    const i = '一二三四五六七八九十'.indexOf(c);
    return i >= 0 ? '1234567890'[Math.min(i, 9)] : c;
  };
  return s
    .normalize('NFKC')
    .replace(/[\s　]/g, '')
    .replace(/店$/, '')
    .replace(/丁目$/, '')
    .replace(/商店街/g, '商街')
    .replace(/[一二三四五六七八九十]/g, kanjiToDigit)
    .toLowerCase();
}

function nameKeys(name: string): string[] {
  if (!name) return [];
  const variants = new Set<string>();
  const base = String(name).trim();
  for (const v of [base, expandAbbrev(base)]) {
    variants.add(v);
    variants.add(v.replace(/前$/, ''));
    variants.add(v.replace(/店$/, ''));
    variants.add(v.replace(/前店$/, ''));
    variants.add(v.replace(/丁目$/, ''));
  }
  const keys = new Set<string>();
  for (const v of variants) {
    const k = normName(v);
    if (k) keys.add(k);
  }
  return [...keys];
}

function extractSheetId(input: string): string {
  const s = (input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : s;
}

function extractGid(input: string): number | null {
  const m = (input || '').match(/[#?&]gid=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function fetchSpreadsheetMeta(sheetId: string, token: string) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`metadata fetch ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function fetchSheetValues(sheetId: string, range: string, token: string) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`values fetch ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

// ---- 新聞ツールのログイントークン検証 (2026-10-15) ----
// invoice-sheet が発行するトークン(HMAC・SHIFT_SESSION_SECRET)と同じ方式で確かめる。
// それまでこのEFは認証が無く、ログインなしで店舗メモ・店名の別名・公開ダイヤグラムを読み書き・削除できた。
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

function genSlug(): string {
  const chars = 'abcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const body = await req.json();
    const action = body.action;

    // 共有リンク(?dg=…)の表示だけはログイン不要。それ以外は新聞ツールのログインが必要
    if (action !== 'get_published_diagram') {
      const claims = await verifyToken(body.auth_token);
      if (!claims) return jsonResp({ error: 'auth required', code: 'AUTH_REQUIRED' }, 401);
    }

    if (action === 'list_aliases') {
      const { data, error } = await supa.from('store_name_aliases').select('*').order('alias');
      if (error) return jsonResp({ error: error.message }, 500);
      return jsonResp({ aliases: data || [] });
    }
    if (action === 'add_alias') {
      const { alias, master_name, note } = body;
      if (!alias || !master_name) return jsonResp({ error: 'alias and master_name required' }, 400);
      const { error } = await supa.from('store_name_aliases').upsert({ alias, master_name, note: note || null });
      if (error) return jsonResp({ error: error.message }, 500);
      return jsonResp({ ok: true });
    }
    if (action === 'delete_alias') {
      const { alias } = body;
      if (!alias) return jsonResp({ error: 'alias required' }, 400);
      const { error } = await supa.from('store_name_aliases').delete().eq('alias', alias);
      if (error) return jsonResp({ error: error.message }, 500);
      return jsonResp({ ok: true });
    }

    if (action === 'list_store_notes') {
      const { data, error } = await supa.from('store_notes').select('*').order('store_name');
      if (error) return jsonResp({ error: error.message }, 500);
      return jsonResp({ notes: data || [] });
    }
    if (action === 'set_store_note') {
      const { store_name, notes } = body;
      if (!store_name) return jsonResp({ error: 'store_name required' }, 400);
      const { error } = await supa.from('store_notes').upsert({ store_name, notes: notes || '' });
      if (error) return jsonResp({ error: error.message }, 500);
      return jsonResp({ ok: true });
    }
    if (action === 'delete_store_note') {
      const { store_name } = body;
      if (!store_name) return jsonResp({ error: 'store_name required' }, 400);
      const { error } = await supa.from('store_notes').delete().eq('store_name', store_name);
      if (error) return jsonResp({ error: error.message }, 500);
      return jsonResp({ ok: true });
    }

    // === 公開ダイヤグラム ===
    if (action === 'publish_diagram') {
      const { slug: reqSlug, title, depot_address, data } = body;
      if (!data) return jsonResp({ error: 'data required' }, 400);
      let slug = (reqSlug || '').trim();
      if (!slug) {
        for (let i = 0; i < 5; i++) {
          const candidate = genSlug();
          const { data: ex } = await supa.from('published_diagrams').select('slug').eq('slug', candidate).maybeSingle();
          if (!ex) { slug = candidate; break; }
        }
        if (!slug) slug = genSlug() + Date.now().toString(36);
      }
      const { error } = await supa.from('published_diagrams').upsert({
        slug, title: title || null, depot_address: depot_address || null, data,
      });
      if (error) return jsonResp({ error: error.message }, 500);
      return jsonResp({ ok: true, slug });
    }
    if (action === 'get_published_diagram') {
      const { slug } = body;
      if (!slug) return jsonResp({ error: 'slug required' }, 400);
      const { data, error } = await supa.from('published_diagrams').select('*').eq('slug', slug).maybeSingle();
      if (error) return jsonResp({ error: error.message }, 500);
      if (!data) return jsonResp({ error: 'not found' }, 404);
      const text = JSON.stringify(data.data ?? '');
      const { data: notes } = await supa.from('store_notes').select('store_name,notes');
      const store_notes = (notes || []).filter((n: any) => n.store_name && text.includes(n.store_name));
      return jsonResp({ diagram: data, store_notes });
    }
    if (action === 'list_published_diagrams') {
      const { data, error } = await supa.from('published_diagrams').select('slug,title,depot_address,created_at,updated_at').order('updated_at', { ascending: false });
      if (error) return jsonResp({ error: error.message }, 500);
      return jsonResp({ diagrams: data || [] });
    }
    if (action === 'delete_published_diagram') {
      const { slug } = body;
      if (!slug) return jsonResp({ error: 'slug required' }, 400);
      const { error } = await supa.from('published_diagrams').delete().eq('slug', slug);
      if (error) return jsonResp({ error: error.message }, 500);
      return jsonResp({ ok: true });
    }

    if (action === 'fetch_sheet') {
      const sheetId = extractSheetId(body.sheet_id_or_url || '');
      if (!sheetId) return jsonResp({ error: 'sheet_id_or_url required' }, 400);
      const requestedSheet = (body.sheet_name || '').trim();
      const requestedGid = body.gid != null ? Number(body.gid) : extractGid(body.sheet_id_or_url || '');
      const token = await getAccessToken();
      let meta;
      try { meta = await fetchSpreadsheetMeta(sheetId, token); }
      catch (e) { return jsonResp({ error: 'メタ取得失敗 (シートが非公開、またはサービスアカウント workchat@my-project-78970-492704.iam.gserviceaccount.com に閲覧権限が無い可能性): ' + (e instanceof Error ? e.message : String(e)) }, 502); }
      const sheetsList = (meta.sheets || []).map((s: any) => ({ gid: s.properties.sheetId, title: s.properties.title }));
      let target = sheetsList[0];
      if (requestedSheet) {
        const f = sheetsList.find((s: any) => s.title === requestedSheet);
        if (f) target = f;
      } else if (requestedGid != null) {
        const f = sheetsList.find((s: any) => Number(s.gid) === requestedGid);
        if (f) target = f;
      }
      if (!target) return jsonResp({ error: 'シートが見つかりません', sheets: sheetsList }, 404);
      const range = `${target.title}!A1:Z2000`;
      let valuesJson;
      try { valuesJson = await fetchSheetValues(sheetId, range, token); }
      catch (e) { return jsonResp({ error: '値取得失敗: ' + (e instanceof Error ? e.message : String(e)) }, 502); }
      return jsonResp({
        sheet_id: sheetId,
        sheets: sheetsList,
        used: target,
        values: valuesJson.values || [],
      });
    }

    if (action === 'process') {
      const depotAddress = (body.depot_address || '').trim();
      const diagrams = body.diagrams as { name: string; stops: { id: any; name: string; time: any; dist: any }[] }[];
      if (!Array.isArray(diagrams) || diagrams.length === 0) return jsonResp({ error: 'diagrams required' }, 400);

      const token = await getAccessToken();
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A2:AI5000`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return jsonResp({ error: 'master fetch failed: ' + r.status }, 502);
      const masterJson = await r.json();
      const rows = (masterJson.values || []) as string[][];
      const masterByID = new Map<string, any>();
      const masterByName = new Map<string, any>();
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const id = String(row[2] || '').trim();
        if (!id) continue;
        const name = (row[3] || '').trim();
        const lat = parseFloat(row[29] || '');
        const lng = parseFloat(row[30] || '');
        const address = (row[31] || '').trim();
        const officialName = (row[34] || '').trim();
        if (isNaN(lat) || isNaN(lng)) continue;
        const entry = { id, name, lat, lng, address, official_name: officialName };
        masterByID.set(id, entry);
        for (const k of nameKeys(name)) if (!masterByName.has(k)) masterByName.set(k, entry);
        if (officialName) for (const k of nameKeys(officialName)) if (!masterByName.has(k)) masterByName.set(k, entry);
      }

      const { data: aliasRows } = await supa.from('store_name_aliases').select('alias, master_name');
      const aliases = new Map<string, string>();
      for (const a of (aliasRows || [])) aliases.set(a.alias, a.master_name);

      const { data: storeNoteRows } = await supa.from('store_notes').select('store_name, notes');
      const storeNoteMap = new Map<string, string>();
      for (const n of (storeNoteRows || [])) storeNoteMap.set(n.store_name, n.notes || '');

      let depot: { lat: number | null; lng: number | null; address: string } = { lat: null, lng: null, address: depotAddress };
      if (depotAddress) {
        try {
          const gurl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(depotAddress)}&key=${GEOCODING_KEY}`;
          const gres = await fetch(gurl);
          const gjson = await gres.json();
          const loc = gjson.results?.[0]?.geometry?.location;
          if (loc) { depot.lat = loc.lat; depot.lng = loc.lng; }
        } catch (_) { /* ignore */ }
      }

      let total = 0, matched = 0, fromAlias = 0;
      const unmatched: { diagram: string; id: string; name: string }[] = [];
      const outDiagrams = diagrams.map((d) => {
        const outStops = d.stops.map((s) => {
          if (s.name && (String(s.name).startsWith('【出発】') || String(s.name) === '出発地点')) {
            return { ...s, isStart: true, lat: depot.lat, lng: depot.lng, address: depotAddress, store_note: '' };
          }
          total++;
          const idStr = s.id ? String(parseInt(String(s.id).replace(/\D/g, ''), 10) || '') : '';
          let m: any = masterByID.get(idStr);
          let how = 'id';
          if (!m) {
            const aliased = aliases.get(s.name);
            if (aliased) {
              for (const k of nameKeys(aliased)) {
                if (masterByName.has(k)) { m = masterByName.get(k); how = 'alias'; fromAlias++; break; }
              }
            }
          }
          if (!m) {
            for (const k of nameKeys(s.name)) {
              if (masterByName.has(k)) { m = masterByName.get(k); how = 'name'; break; }
            }
          }
          if (m) {
            matched++;
            const sn = storeNoteMap.get(m.name) || storeNoteMap.get(s.name) || '';
            return {
              ...s,
              isStart: false,
              matched: true,
              match_how: how,
              master_id: m.id,
              master_name: m.name,
              official_name: m.official_name,
              address: m.address || '',
              lat: m.lat, lng: m.lng,
              store_note: sn,
            };
          } else {
            unmatched.push({ diagram: d.name, id: idStr, name: s.name });
            return { ...s, isStart: false, matched: false, store_note: storeNoteMap.get(s.name) || '' };
          }
        });
        return { name: d.name, stops: outStops };
      });

      return jsonResp({
        depot, diagrams: outDiagrams, unmatched,
        stats: { total, matched, from_alias: fromAlias, unmatched: unmatched.length },
      });
    }

    return jsonResp({ error: 'Unknown action' }, 400);
  } catch (e) {
    return jsonResp({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
