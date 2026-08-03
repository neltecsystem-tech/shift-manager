import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// 店舗マスタは専用スプレッドシートへ独立 (2026-06-30)
const SPREADSHEET_ID = '1KvMbiLMeUmUOiUwzcilp-6u2xzZXs68HcvtWuWqT70M';
const SHEET_NAME = '店舗マスタ';
const PARTIAL_SHEET = '取扱中止予約'; // 区分別の取扱中止予約(shop-master EFが登録)。最終納品日到来でその区分コースを自動クリア

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

      // 最終納品日の翌日にクリア (請求・突合は月初スナップ基準なので翌月15日まで待つ必要なし)
      // todayMid <= 最終納品日 の間(=最終納品日当日まで)は配達中なので残す
      if (todayMid <= lastDate) return;

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

    // ── 部分中止(区分別)予約の適用 ──
    // 取扱中止予約タブを読み、最終納品日を過ぎた"予約中"の該当区分コースだけを空にする(例: 夕刊・競馬だけ中止・朝刊は残す)。
    const jstNow = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const EDITION_BY_NAME: Record<string, { courseCol: number; orderCol: number; timeCol: number }> = {
      '朝刊': EDITIONS[0], '夕刊': EDITIONS[1], '競馬': EDITIONS[2],
    };
    let partialCleared = 0;
    try {
      // タブ読取が一時的に空/失敗することがあるため2回までリトライ(初回のみ空だった事象の対策)
      let psRows: string[][] = [];
      for (let a = 0; a < 2; a++) {
        const psResp = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(PARTIAL_SHEET)}!A2:J10000`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (psResp.ok) { psRows = (await psResp.json()).values ?? []; if (psRows.length) break; }
        if (a === 0) await new Promise(r => setTimeout(r, 600));
      }
      if (psRows.length) {
        const codeToRow = new Map<string, number>(); // 店舗コード(C=2) → master rowNum
        rows.forEach((row: string[], i: number) => { const c = (row[2] ?? '').trim(); if (c && !codeToRow.has(c)) codeToRow.set(c, i + 3); });
        const cellUpdates: { range: string; values: string[][] }[] = [];
        const statusUpdates: { range: string; values: string[][] }[] = [];
        psRows.forEach((pr: string[], pi: number) => {
          if ((pr[6] ?? '').trim() !== '予約中') return;
          const lastDate = parseDate(pr[4] ?? '');
          if (!lastDate) return;
          if (todayMid <= lastDate) return; // まだ最終納品日を過ぎていない
          const code = (pr[1] ?? '').trim();
          const edition = (pr[3] ?? '').trim();
          const rowNum = codeToRow.get(code);
          const psRowNum = pi + 2;
          if (!rowNum) return; // 店舗が見つからない → 放置(手動確認)
          const mrow = rows[rowNum - 3] || [];
          const clearEd = (ed: { courseCol: number; orderCol: number; timeCol: number }) => {
            const c = (mrow[ed.courseCol] ?? '').trim();
            if (c) affected[EDITIONS.indexOf(ed)].add(c); // 順番詰め直し対象に追加
            cellUpdates.push({ range: `'${SHEET_NAME}'!${colLetter(ed.courseCol)}${rowNum}`, values: [['']] });
            cellUpdates.push({ range: `'${SHEET_NAME}'!${colLetter(ed.orderCol)}${rowNum}`, values: [['']] });
            cellUpdates.push({ range: `'${SHEET_NAME}'!${colLetter(ed.timeCol)}${rowNum}`, values: [['']] });
            mrow[ed.courseCol] = ''; mrow[ed.orderCol] = ''; mrow[ed.timeCol] = '';
          };
          if (edition === '全部') {
            EDITIONS.forEach(ed => clearEd(ed));
            const area = (mrow[1] ?? '').trim();
            if (!area.includes('納品中止')) { const na = area ? `${area}、納品中止` : '納品中止'; cellUpdates.push({ range: `'${SHEET_NAME}'!${colLetter(1)}${rowNum}`, values: [[na]] }); mrow[1] = na; }
          } else {
            const ed = EDITION_BY_NAME[edition];
            if (!ed) return;
            clearEd(ed);
            // 夕刊は「新夕刊コース(AJ=35)」も突合(平日夕刊)で参照されるため一緒にクリア(取りこぼし防止)
            if (edition === '夕刊' && (mrow[35] ?? '').trim()) {
              cellUpdates.push({ range: `'${SHEET_NAME}'!${colLetter(35)}${rowNum}`, values: [['']] });
              mrow[35] = '';
            }
          }
          // G:J = 状態/登録日時(保持)/登録者(保持)/適用日時
          statusUpdates.push({ range: `'${PARTIAL_SHEET}'!G${psRowNum}:J${psRowNum}`, values: [['適用済', pr[7] ?? '', pr[8] ?? '', jstNow]] });
          partialCleared++;
        });
        if (cellUpdates.length) {
          await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
            method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: cellUpdates }),
          });
        }
        if (statusUpdates.length) {
          await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
            method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: statusUpdates }),
          });
        }
      }
    } catch (_) { /* 部分中止の適用は best-effort */ }

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
      message: `${cleared}件の店舗を処理（コース名クリア + B列に納品中止追加）／部分中止 ${partialCleared}件（区分別コースクリア）／順番 ${reordered}セルを詰め直し／休店終了 ${suspendCleared}件クリア`,
      total_checked: rows.length,
      cleared,
      partialCleared,
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
