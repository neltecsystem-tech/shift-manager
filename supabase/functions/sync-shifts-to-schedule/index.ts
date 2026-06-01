// shift-manager のシフトデータを NexPort 予定表 (schedule_events) に同期
// 対象: 単価マスタ で 区分=社員 のスタッフ。 NexPort profiles.display_name で突合
// 期間: 当月 + 翌月
// 動作: 既存の event_type='シフト' 同期由来予定を削除 → 新規 insert (idempotent)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SHIFT_SS = '1yVKQLSmdc9RZ2U5m4CIPqAl4JqP9siiSeSRP0z3SEEM';
const INVOICE_SS = '1fxzGdAE64wcFLL0_mZI-eFk6U5jxqCh7DtAIzinoymQ';
const TANKA_SHEET = '単価マスタ';

const SERVICE_ACCOUNT = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY')!);
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// ── Google Sheets 認証 ──
function b64url(d: string): string { return btoa(d).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now()/1000);
  const header = b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const payload = b64url(JSON.stringify({
    iss: SERVICE_ACCOUNT.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: SERVICE_ACCOUNT.token_uri, iat: now, exp: now + 3600,
  }));
  const pem = SERVICE_ACCOUNT.private_key.replace(/-----BEGIN PRIVATE KEY-----/,'').replace(/-----END PRIVATE KEY-----/,'').replace(/\n/g,'');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const jwt = `${header}.${payload}.${signature}`;
  const r = await fetch(SERVICE_ACCOUNT.token_uri, {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  return (await r.json()).access_token;
}

// 名前正規化 (空白除去のみ。 invNormName と同じ)
function normName(n: string): string {
  return (n || '').replace(/[\s　 ]+/g, '').trim();
}
function isDateVal(v: string): boolean {
  return !!v && /^0?\d{1,2}\/\d{1,2}$/.test(v);
}
function areaOfCourse(c: string): string {
  if (!c) return '';
  if (c.startsWith('城北')) return '城北';
  if (c.startsWith('川越')) return '川越';
  if (c.startsWith('立川')) return '立川';
  if (c.startsWith('川崎')) return '川崎高津';
  return '';
}

// ── 単価マスタから 社員 名前リスト ──
async function getShainNames(token: string): Promise<string[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${INVOICE_SS}/values/${encodeURIComponent(TANKA_SHEET)}!A2:U10000`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  const rows = (j.values || []) as string[][];
  const names: string[] = [];
  for (const row of rows) {
    const name = (row[0] || '').trim();
    const bizType = (row[11] || '').trim(); // L列 = 区分
    if (name && bizType === '社員') names.push(name);
  }
  return [...new Set(names)];
}

// ── shift_sheet_cache から sheet_name の行を取得 ──
async function getCachedSheet(sheetName: string): Promise<string[][] | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/shift_sheet_cache?sheet_name=eq.${encodeURIComponent(sheetName)}&select=rows`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  const j = await r.json();
  return j[0]?.rows || null;
}

// ── profiles から display_name → user_id ──
async function getUserMap(): Promise<Record<string, string>> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,display_name&account_status=neq.disabled`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  const arr = await r.json() as { id: string; display_name: string }[];
  const map: Record<string, string> = {};
  for (const p of arr) {
    const k = normName(p.display_name);
    if (k) map[k] = p.id;
  }
  return map;
}

// ── parseShift: Section 1 + Section 2 ──
type ShiftEntry = { am: string; pm: string };
type ParsedShift = Record<string, Record<string, Record<string, ShiftEntry>>>; // area → name → date → {am,pm}

function parseShift(R: string[][], year: number): ParsedShift {
  if (!R || R.length < 10) return {};
  const dateRow = R[0] || [], dowRow = R[3] || [];
  const dates: { col: number; d: string }[] = [];
  for (let c = 1; c < dateRow.length; c++) {
    const v = (dateRow[c] || '').trim();
    if (isDateVal(v)) {
      const parts = v.split('/').map(Number);
      const m = parts[parts.length-2], d = parts[parts.length-1];
      dates.push({ col: c, d: `${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}` });
    }
  }
  if (!dates.length) return {};

  const areaData: ParsedShift = {};
  // Section 1
  const maxRow = Math.min(116, R.length);
  for (let i = 6; i < maxRow; i++) {
    const r = R[i] || [], courseName = (r[0] || '').trim();
    if (!courseName || courseName === '重複') continue;
    const area = areaOfCourse(courseName);
    if (!area) continue;
    for (const { col, d } of dates) {
      const staffAm = (r[col] || '').trim();
      const staffPm = (r[col+1] || '').trim();
      const isNumOnly = (v: string) => /^\d{1,2}$/.test(v);
      if (staffAm && staffAm !== '0' && !isNumOnly(staffAm)) {
        if (!areaData[area]) areaData[area] = {};
        if (!areaData[area][staffAm]) areaData[area][staffAm] = {};
        if (!areaData[area][staffAm][d]) areaData[area][staffAm][d] = { am:'', pm:'' };
        areaData[area][staffAm][d].am = courseName;
      }
      if (staffPm && staffPm !== '0' && !isNumOnly(staffPm)) {
        if (!areaData[area]) areaData[area] = {};
        if (!areaData[area][staffPm]) areaData[area][staffPm] = {};
        if (!areaData[area][staffPm][d]) areaData[area][staffPm][d] = { am:'', pm:'' };
        areaData[area][staffPm][d].pm = courseName;
      }
    }
  }

  // Section 2 (特殊パターン)
  const specialPattern = /ミーティング|希望休|引継|研修|有給|欠勤|出張|五反田|目黒|渋谷|休刊/;
  const areas2 = ['城北','川越','立川','川崎高津'];
  let curArea2 = '';
  for (let i = 120; i < R.length - 2; i++) {
    const row = R[i] || [];
    const a = (row[0] || '').trim(), b = (row[1] || '').trim();
    const isAreaHdr = areas2.some(x => a === x) && isDateVal(b);
    const isSubHdr = a === '' && isDateVal(b) && curArea2;
    if (!isAreaHdr && !isSubHdr) continue;
    if (isAreaHdr) curArea2 = a;
    const s2dates: { col: number; d: string }[] = [];
    for (let c = 1; c < row.length; c++) {
      const v = (row[c] || '').trim();
      if (isDateVal(v)) {
        const parts = v.split('/').map(Number);
        const m = parts[parts.length-2], d = parts[parts.length-1];
        s2dates.push({ col: c, d: `${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}` });
      }
    }
    let editionRow = R[i+2] || [];
    const hasEd = (row: string[]) => row && row.some(v => v && (String(v).includes('朝刊') || String(v).includes('夕刊') || String(v).includes('競馬')));
    if (!hasEd(editionRow)) {
      for (let er = i+3; er < Math.min(R.length, i+10); er++) {
        if (hasEd(R[er])) { editionRow = R[er]; break; }
      }
    }
    for (let j = i+3; j < R.length; j++) {
      const r2 = R[j] || [];
      const nm = (r2[0] || '').trim();
      const colB = (r2[1] || '').trim();
      if (nm === '' && isDateVal(colB)) break;
      if (!nm) continue;
      if (/^\d{1,2}$/.test(nm)) continue;
      if (areas2.some(x => nm === x) && isDateVal(colB)) break;
      for (const { col, d } of s2dates) {
        const v = (r2[col] || '').trim();
        if (!v || !specialPattern.test(v)) continue;
        const ed = String(editionRow[col] || '').trim();
        const isPm = ed.includes('夕刊') || ed.includes('競馬');
        if (!areaData[curArea2]) areaData[curArea2] = {};
        if (!areaData[curArea2][nm]) areaData[curArea2][nm] = {};
        if (!areaData[curArea2][nm][d]) areaData[curArea2][nm][d] = { am:'', pm:'' };
        if (isPm) areaData[curArea2][nm][d].pm = v;
        else areaData[curArea2][nm][d].am = v;
      }
    }
  }
  return areaData;
}

// ── 当月+翌月のシート名を計算 ──
function targetMonthLabels(now: Date): { label: string; year: number; month: number }[] {
  const out: { label: string; year: number; month: number }[] = [];
  for (let off = 0; off <= 1; off++) {
    const d = new Date(now.getFullYear(), now.getMonth() + off, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    // 2026以降は "{m}月シフト{y}"、 2025以前は "{m}月シフト"
    const label = y >= 2026 ? `${m}月シフト${y}` : `${m}月シフト`;
    out.push({ label, year: y, month: m });
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = !!body.dry_run;
    const now = body.now ? new Date(body.now) : new Date();
    const months = body.months || targetMonthLabels(now);

    // 並行取得
    const token = await getAccessToken();
    const [shainNames, userMap] = await Promise.all([
      getShainNames(token),
      getUserMap(),
    ]);

    // 社員 → user_id マッピング
    const staffToUser: { name: string; user_id: string }[] = [];
    const unmappedStaff: string[] = [];
    for (const n of shainNames) {
      const uid = userMap[normName(n)];
      if (uid) staffToUser.push({ name: n, user_id: uid });
      else unmappedStaff.push(n);
    }

    // 月ごとシフト読込 + パース
    type EventRec = { user_id: string; title: string; event_date: string; event_type: string; all_day: boolean; assigned_by: string; status: string };
    const events: EventRec[] = [];
    const monthsLoaded: { label: string; rows: number }[] = [];
    for (const { label, year } of months) {
      const sheet = await getCachedSheet(label);
      if (!sheet) {
        monthsLoaded.push({ label, rows: 0 });
        continue;
      }
      monthsLoaded.push({ label, rows: sheet.length });
      const parsed = parseShift(sheet, year);
      for (const { name, user_id } of staffToUser) {
        const targetN = normName(name);
        // 全 area を走査して 名前一致 (正規化済) を拾う
        for (const staffMap of Object.values(parsed)) {
          for (const [shiftName, dateMap] of Object.entries(staffMap)) {
            if (normName(shiftName) !== targetN) continue;
            for (const [date, ed] of Object.entries(dateMap)) {
              if (ed.am) events.push({
                user_id, title: `朝 ${ed.am}`, event_date: date,
                event_type: 'シフト', all_day: true, assigned_by: 'shift-sync', status: 'accepted'
              });
              if (ed.pm) events.push({
                user_id, title: `夕 ${ed.pm}`, event_date: date,
                event_type: 'シフト', all_day: true, assigned_by: 'shift-sync', status: 'accepted'
              });
            }
          }
        }
      }
    }

    // dry-run 終了
    if (dryRun) {
      return new Response(JSON.stringify({
        ok: true, dry_run: true,
        shain_total: shainNames.length,
        shain_mapped: staffToUser.length,
        shain_unmapped: unmappedStaff,
        months: monthsLoaded,
        events_count: events.length,
        sample: events.slice(0, 10),
      }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (events.length === 0) {
      return new Response(JSON.stringify({ ok: true, inserted: 0, removed: 0, note: 'No events to sync' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 削除対象期間: 取り込んだイベントの日付範囲
    const dates = [...new Set(events.map(e => e.event_date))].sort();
    const fromDate = dates[0], toDate = dates[dates.length-1];
    const userIds = [...new Set(staffToUser.map(s => s.user_id))];
    // 各 user の シフト 由来のみ削除 (assigned_by='shift-sync')
    const delResp = await fetch(
      `${SUPABASE_URL}/rest/v1/schedule_events?event_type=eq.シフト&assigned_by=eq.shift-sync&user_id=in.(${userIds.join(',')})&event_date=gte.${fromDate}&event_date=lte.${toDate}`,
      { method: 'DELETE', headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, Prefer: 'return=representation' } }
    );
    const deletedRows = await delResp.json().catch(() => []);
    const removed = Array.isArray(deletedRows) ? deletedRows.length : 0;

    // バッチ insert
    let inserted = 0;
    const BATCH = 500;
    for (let i = 0; i < events.length; i += BATCH) {
      const batch = events.slice(i, i + BATCH);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/schedule_events`, {
        method: 'POST',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(batch),
      });
      if (r.ok) inserted += batch.length;
      else {
        const t = await r.text();
        return new Response(JSON.stringify({ ok: false, inserted, error: `insert failed (${r.status}): ${t.slice(0, 300)}` }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({
      ok: true, inserted, removed,
      shain_mapped: staffToUser.length,
      shain_unmapped: unmappedStaff,
      months: monthsLoaded,
      date_range: { from: fromDate, to: toDate },
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
