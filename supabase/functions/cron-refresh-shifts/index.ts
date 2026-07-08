import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const SHIFT_SPREADSHEET = '1yVKQLSmdc9RZ2U5m4CIPqAl4JqP9siiSeSRP0z3SEEM';
const SA = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY'));
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
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
  // 行範囲は Section 2(営業所別個人別・引継等)の下部まで取り込むため十分広く取る。
  // ※以前は A1:ZZ500 で、500行超の引継/応援スタッフ行が丸ごと欠落していた。
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHIFT_SPREADSHEET}/values/${encodeURIComponent(sheetName)}!A1:ZZ1000`;
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
  const sheets = Array.isArray(body.sheets) && body.sheets.length ? body.sheets : targetSheetNames();
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
