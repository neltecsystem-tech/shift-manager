import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// 売上確定シートの重複・文字化け行を毎日掃除する(cron cleanup-confirmed-sales-daily)。
// 🔒 2026-10-15: 版管理へ取り込み。それまで認証が無く、誰でもシートの行を消させられ、
//    応答で文字化け行の店舗・コース・金額も読めた。通すのは cron(x-cron-secret) とサーバー(service role)だけ。

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const SPREADSHEET_ID = '1fxzGdAE64wcFLL0_mZI-eFk6U5jxqCh7DtAIzinoymQ';
const CONFIRMED_SALES_SHEET = '売上確定';

const SERVICE_ACCOUNT = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY')!);

function b64url(d:string){return btoa(d).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
async function getToken(){
  const now=Math.floor(Date.now()/1000);
  const h=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const p=b64url(JSON.stringify({iss:SERVICE_ACCOUNT.client_email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:SERVICE_ACCOUNT.token_uri,iat:now,exp:now+3600}));
  const pk=SERVICE_ACCOUNT.private_key.replace(/-----BEGIN PRIVATE KEY-----/,'').replace(/-----END PRIVATE KEY-----/,'').replace(/\n/g,'');
  const der=Uint8Array.from(atob(pk),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey('pkcs8',der,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(`${h}.${p}`));
  const s=btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const r=await fetch(SERVICE_ACCOUNT.token_uri,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${h}.${p}.${s}`});
  return (await r.json()).access_token;
}

function normalizeYM(v: any): string {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{1,2}$/.test(s)) {
    const [y, m] = s.split('-');
    return `${y}-${String(parseInt(m, 10)).padStart(2, '0')}`;
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  return s;
}

function parseConfirmedAt(s: string): number {
  if (!s) return 0;
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// Unicode replacement character (文字化け) 検出
function isGarbled(s: any): boolean {
  if (s == null) return false;
  const str = String(s);
  // U+FFFD = 文字化け、U+0080-U+009F = C1制御文字 (Shift_JIS バイトがそのまま残ったケース)
  if (/[�\u0080-\u009F]/.test(str)) return true;
  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';
  const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const allowed = (!!CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET) || (!!SRK && bearer === SRK);
  if (!allowed) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  try {
    const token = await getToken();

    // 1. 読み込み
    const resp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A2:G5000`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const rows = (await resp.json()).values || [];

    type Row = { rowNum: number; ymRaw: any; ym: string; area: string; course: string; grand: number; am: number; pm: number; at: string; atMs: number; garbled: boolean };
    const parsed: Row[] = rows.map((r: any[], i: number) => ({
      rowNum: i + 2,
      ymRaw: r[0],
      ym: normalizeYM(r[0]),
      area: r[1] || '',
      course: r[2] || '',
      grand: Number(r[3]) || 0,
      am: Number(r[4]) || 0,
      pm: Number(r[5]) || 0,
      at: r[6] || '',
      atMs: parseConfirmedAt(r[6] || ''),
      garbled: isGarbled(r[1]) || isGarbled(r[2]),
    }));

    // 重複グループ化 (ゴミデータもグループに含めない)
    const groups = new Map<string, Row[]>();
    parsed.forEach(p => {
      if (!p.ym || !p.area || !p.course || p.garbled) return;
      const k = `${p.ym}|${p.area}|${p.course}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(p);
    });

    const clearRowsSet = new Set<number>();
    let dupesRemoved = 0;
    let garbledRemoved = 0;
    for (const list of groups.values()) {
      list.sort((a, b) => b.atMs - a.atMs || b.grand - a.grand || b.rowNum - a.rowNum);
      for (let i = 1; i < list.length; i++) {
        clearRowsSet.add(list[i].rowNum);
        dupesRemoved++;
      }
    }
    parsed.forEach(p => {
      if (!p.ym || !p.area || !p.course) clearRowsSet.add(p.rowNum);
      if (p.garbled) { clearRowsSet.add(p.rowNum); garbledRemoved++; }
    });

    const garbledDetail = parsed.filter(p => p.garbled).map(p => ({
      row: p.rowNum, area: p.area, course: p.course, amount: p.grand,
    }));

    // 2. Clear
    const clearRows = [...clearRowsSet];
    let clearStatus = 0, clearBody = '';
    if (clearRows.length > 0) {
      const data = clearRows.map(rn => ({
        range: `${CONFIRMED_SALES_SHEET}!A${rn}:G${rn}`,
        values: [Array(7).fill('')],
      }));
      const r1 = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'RAW', data }),
      });
      clearStatus = r1.status;
      if (!r1.ok) clearBody = await r1.text();
    }

    // 3. Rewrite serial-value rows
    const rewriteRows: Row[] = [];
    for (const list of groups.values()) {
      if (list.length === 0) continue;
      const keep = list[0];
      const raw = String(keep.ymRaw ?? '');
      if (raw !== keep.ym) rewriteRows.push(keep);
    }
    let rewriteStatus = 0, rewriteBody = '';
    if (rewriteRows.length > 0) {
      const data = rewriteRows.map(r => ({
        range: `${CONFIRMED_SALES_SHEET}!A${r.rowNum}:G${r.rowNum}`,
        values: [[r.ym, r.area, r.course, r.grand, r.am, r.pm, r.at]],
      }));
      const r2 = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'RAW', data }),
      });
      rewriteStatus = r2.status;
      if (!r2.ok) rewriteBody = await r2.text();
    }

    return new Response(JSON.stringify({
      ok: true,
      total_rows: parsed.length,
      groups: groups.size,
      duplicates_removed: dupesRemoved,
      garbled_removed: garbledRemoved,
      garbled_detail: garbledDetail,
      rewritten_serial_rows: rewriteRows.length,
      cleared_rows: clearRows.length,
      clear_status: clearStatus,
      clear_error: clearBody.slice(0, 300),
      rewrite_status: rewriteStatus,
      rewrite_error: rewriteBody.slice(0, 300),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
