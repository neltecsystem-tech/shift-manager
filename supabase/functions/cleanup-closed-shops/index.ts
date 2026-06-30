import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// 店舗マスタは専用スプレッドシートへ独立 (2026-06-30)
const SPREADSHEET_ID = '1KvMbiLMeUmUOiUwzcilp-6u2xzZXs68HcvtWuWqT70M';
const SHEET_NAME = '店舗マスタ';

const SERVICE_ACCOUNT = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY')!);

function b64url(data: string): string {
  return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: SERVICE_ACCOUNT.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: SERVICE_ACCOUNT.token_uri,
    iat: now, exp: now + 3600,
  }));
  const pemBody = SERVICE_ACCOUNT.private_key.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\n/g, '');
  const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', binaryDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${header}.${payload}.${signature}`;
  const resp = await fetch(SERVICE_ACCOUNT.token_uri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  return (await resp.json()).access_token;
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const clean = s.trim();
  let m = clean.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  m = clean.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  return null;
}

// 最終納品日の翌月15日 (この日を過ぎたらクリア対象)
function getNextMonth15th(d: Date): Date {
  const year = d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear();
  const month = d.getMonth() === 11 ? 0 : d.getMonth() + 1;
  return new Date(year, month, 15);
}

// 区分ごとの列 (0-indexed, A起点) ※ shop-master EF の EDITION_COLS と一致
//   朝刊 F=5(course)/M=12(order)/N=13(time)
//   夕刊 O=14(course)/R=17(order)/S=18(time)
//   競馬 T=19(course)/X=23(order)/Y=24(time)
const EDITIONS = [
  { courseCol: 5,  orderCol: 12, timeCol: 13 },
  { courseCol: 14, orderCol: 17, timeCol: 18 },
  { courseCol: 19, orderCol: 23, timeCol: 24 },
];

function colLetter(idx: number): string {
  let s = ''; let n = idx;
  while (n >= 0) { s = String.fromCharCode((n % 26) + 65) + s; n = Math.floor(n / 26) - 1; }
  return s;
}

function timeToMin(s: string): number {
  if (!s) return -1;
  const m = String(s).match(/(\d{1,2}):(\d{2})/);
  if (!m) return -1;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const token = await getAccessToken();
    const now = new Date();

    // Columns (0-indexed): B=1, F=5, O=14, T=19, AA=26
    const areaCol = 1;          // B: 営業所
    const amCourseCol = 5;      // F: 朝刊コース名
    const pmCourseCol = 14;     // O: 夕刊コース名
    const keibaCourseCol = 19;  // T: 競馬コース名
    const lastDeliveryCol = 26; // AA: 最終納品日

    const dataResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A3:AO3000`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const dataResult = await dataResp.json();
    const rows = dataResult.values ?? [];

    // ── 休店: 休店終了日(AO=40)を過ぎた行の休店情報(AM:AO)を自動クリア ──
    // AM=38 休店中, AN=39 休店開始日, AO=40 休店終了日
    const suspFlagCol = 38, suspStartCol = 39, suspEndCol = 40;
    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const suspData: { range: string; values: string[][] }[] = [];
    rows.forEach((row: string[], i: number) => {
      const rowNum = i + 3;
      const flag = (row[suspFlagCol] ?? '').trim();
      const startStr = (row[suspStartCol] ?? '').trim();
      const endStr = (row[suspEndCol] ?? '').trim();
      if (!flag && !startStr && !endStr) return;
      const endDate = parseDate(endStr);
      if (!endDate) return;                 // 終了日が無効/無期限はクリアしない
      if (todayMid <= endDate) return;      // まだ終了日を過ぎていない
      suspData.push({ range: `'${SHEET_NAME}'!${colLetter(suspFlagCol)}${rowNum}:${colLetter(suspEndCol)}${rowNum}`, values: [['', '', '']] });
    });
    let suspendCleared = 0;
    if (suspData.length) {
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: suspData }),
      });
      suspendCleared = suspData.length;
    }

    let cleared = 0;
    const updates: number[] = [];

    rows.forEach((row: string[], i: number) => {
      const rowNum = i + 3;
      const lastDelivery = row[lastDeliveryCol] ?? '';
      const lastDate = parseDate(lastDelivery);
      if (!lastDate) return;

      const deadline = getNextMonth15th(lastDate);
      if (now <= deadline) return;

      // Skip if already marked as 納品中止
      const currentArea = (row[areaCol] ?? '').trim();
      if (currentArea.includes('納品中止')) return;

      const amCourse = (row[amCourseCol] ?? '').trim();
      const pmCourse = (row[pmCourseCol] ?? '').trim();
      const keibaCourse = (row[keibaCourseCol] ?? '').trim();

      if (!amCourse && !pmCourse && !keibaCourse) return;

      updates.push(rowNum);
    });

    // 閉店する店舗が属していたコースを区分ごとに収集 (クリア後に順番を詰め直すため)
    const affected = EDITIONS.map(() => new Set<string>());
    for (const rowNum of updates) {
      const row = rows[rowNum - 3] || [];
      EDITIONS.forEach((ed, ei) => {
        const c = (row[ed.courseCol] ?? '').trim();
        if (c) affected[ei].add(c);
      });
    }

    for (const rowNum of updates) {
      const rowResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A${rowNum}:AD${rowNum}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const rowResult = await rowResp.json();
      const currentRow = (rowResult.values?.[0] ?? []) as string[];
      while (currentRow.length < 30) currentRow.push('');

      // B列: 現在の営業所名に「納品中止」を追加
      const existingArea = (currentRow[areaCol] ?? '').trim();
      if (!existingArea.includes('納品中止')) {
        currentRow[areaCol] = existingArea ? `${existingArea}、納品中止` : '納品中止';
      }

      // コース名をクリア
      currentRow[amCourseCol] = '';
      currentRow[pmCourseCol] = '';
      currentRow[keibaCourseCol] = '';

      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A${rowNum}:AD${rowNum}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [currentRow] }),
      });
      cleared++;
    }

    // 影響を受けたコースの順番を店着時間順で 1..N に詰め直す (閉店で空いた欠番を解消)
    let reordered = 0;
    if (affected.some(s => s.size > 0)) {
      // クリア後の最新データを取得 (閉店店舗はコース名が消えているので自然に除外される)
      const freshResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A3:AD3000`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const freshRows = ((await freshResp.json()).values ?? []) as string[][];
      const data: { range: string; values: string[][] }[] = [];

      EDITIONS.forEach((ed, ei) => {
        for (const course of affected[ei]) {
          const members: { rowNum: number; mins: number }[] = [];
          freshRows.forEach((row, i) => {
            if ((row[ed.courseCol] ?? '').trim() === course) {
              members.push({ rowNum: i + 3, mins: timeToMin(row[ed.timeCol] ?? '') });
            }
          });
          // 店着時間昇順 (時間なしは末尾)、同時刻は行番号順
          members.sort((a, b) => {
            if (a.mins < 0 && b.mins < 0) return a.rowNum - b.rowNum;
            if (a.mins < 0) return 1;
            if (b.mins < 0) return -1;
            if (a.mins !== b.mins) return a.mins - b.mins;
            return a.rowNum - b.rowNum;
          });
          const letter = colLetter(ed.orderCol);
          members.forEach((mem, idx) => {
            const newOrder = String(idx + 1);
            const cur = (freshRows[mem.rowNum - 3]?.[ed.orderCol] ?? '').trim();
            if (cur !== newOrder) {
              data.push({ range: `'${SHEET_NAME}'!${letter}${mem.rowNum}:${letter}${mem.rowNum}`, values: [[newOrder]] });
            }
          });
        }
      });

      if (data.length) {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
        });
        reordered = data.length;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `${cleared}件の店舗を処理（コース名クリア + B列に納品中止追加）／順番 ${reordered}セルを詰め直し／休店終了 ${suspendCleared}件クリア`,
      total_checked: rows.length,
      cleared,
      reordered,
      suspendCleared,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
