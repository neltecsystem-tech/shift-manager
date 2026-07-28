// 貸し出し予約を車両シートへ自動反映する(返却/貸出開始の両方)。
// ・返却(end_date=当日): B列(氏名/使用者)→U列(前回使用者)へ移し、B列を空、V列に返却日を記録。
// ・貸出開始(start_date=当日): B列(氏名/使用者)に予約の貸与先(lendee_name)をセットし、V列(返却日)をクリア。
//   ※同一車両が当日返却＋当日再貸出の場合は、返却処理の後に貸出処理が適用され B/V を上書きする。
// データ源: vehicle_reservations(NexPort/Supabase)。書込先: NELTEC車両シート(Google)。
// cron(日次)から呼ぶ。verify_jwt OFF + 簡易シークレットゲート。dry_run対応。

const SPREADSHEET_ID = '1CXLtT3R1wDDKiqDJ59FC_yBn1TXMTmlY2FBziSTTLu8';
const SHEET_NAME = 'フォームの回答 1'; // Googleフォーム既定タブ(回答と1の間に半角スペース)
const GATE = 'veh-return-2026-07-28-r4m8';
// 列マップ(0基点): B=氏名=1, G=ナンバー=6, U=前回使用者=20, V=返却日=21。データはA2から(row0=ヘッダ)。
const COL_NAME = 1, COL_NUMBER = 6, COL_PREV = 20, COL_RET = 21;

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const nNum = (s: unknown) => String(s ?? '').replace(/[\s　]/g, '');
const colLetter = (i: number) => { let s = '', n = i; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };

async function getAccessToken(): Promise<string> {
  const SA = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY')!);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: SA.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: SA.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const pem = String(SA.private_key).replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch(SA.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${header}.${payload}.${signature}` });
  const j = await r.json();
  if (!j.access_token) throw new Error('token error: ' + JSON.stringify(j));
  return j.access_token;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({} as any));
    if (body.secret !== GATE) return json({ error: 'forbidden' }, 403);
    const dryRun = !!body.dry_run;
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const sbHeaders = { apikey: SRK, Authorization: `Bearer ${SRK}` };
    // 当日(JST)
    const today = body.today || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

    // 返却予定日=当日 の予約 → 返却対象の車両ナンバー
    const rr = await fetch(`${SUPABASE_URL}/rest/v1/vehicle_reservations?end_date=eq.${today}&select=vehicle_number`, { headers: sbHeaders });
    const resv = await rr.json();
    const returnNums = [...new Set((Array.isArray(resv) ? resv : []).map((r: any) => nNum(r.vehicle_number)).filter(Boolean))];

    // 貸出開始日=当日 の予約 → ナンバー→貸与先 のマップ(同一車両で複数あれば先勝ち)
    const sr2 = await fetch(`${SUPABASE_URL}/rest/v1/vehicle_reservations?start_date=eq.${today}&select=vehicle_number,lendee_name`, { headers: sbHeaders });
    const starts = await sr2.json();
    const startMap = new Map<string, string>();
    for (const r of (Array.isArray(starts) ? starts : [])) {
      const n = nNum(r.vehicle_number);
      const nm = String(r.lendee_name ?? '').trim();
      if (n && nm && !startMap.has(n)) startMap.set(n, nm);
    }

    if (!returnNums.length && startMap.size === 0) return json({ ok: true, today, processed: 0, note: '返却/貸出開始 予定の予約はありません' });

    // シート読取(A2:V)
    const token = await getAccessToken();
    const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A2:V10000?valueRenderOption=UNFORMATTED_VALUE`;
    const sr = await fetch(readUrl, { headers: { Authorization: `Bearer ${token}` } });
    const sj = await sr.json();
    const rows: any[][] = sj.values || [];

    if (body.debug) {
      const startNums = [...startMap.keys()];
      const sample = rows.slice(0, 40).map((r, i) => ({ row: i + 2, B: r[COL_NAME], G: r[COL_NUMBER], V: r[COL_RET], rawlen: r.length }));
      const hits = rows.map((r, i) => ({ i, num: nNum(r[COL_NUMBER]) })).filter(x => returnNums.includes(x.num) || startMap.has(x.num));
      return json({ ok: true, return_targets: returnNums, start_targets: startNums, hits, sample });
    }

    const updates: { range: string; values: any[][] }[] = [];
    const processed: any[] = [];
    // row0=ヘッダのためデータは index1〜(=シート行3〜)。シート行 = index + 2。
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const num = nNum(row[COL_NUMBER]);
      if (!num) continue;
      const isReturn = returnNums.includes(num);
      const startLendee = startMap.get(num) || '';
      if (!isReturn && !startLendee) continue;

      const sheetRow = i + 2;
      const curName = String(row[COL_NAME] ?? '').trim();
      const curRet = String(row[COL_RET] ?? '').trim();

      // 返却: 使用者ありのときだけ前回使用者へ退避し、B列を空・V列に返却日
      if (isReturn && curName) {
        updates.push({ range: `${SHEET_NAME}!${colLetter(COL_PREV)}${sheetRow}`, values: [[curName]] }); // U=前回使用者=氏名
        updates.push({ range: `${SHEET_NAME}!${colLetter(COL_NAME)}${sheetRow}`, values: [['']] });      // B=氏名=空
        updates.push({ range: `${SHEET_NAME}!${colLetter(COL_RET)}${sheetRow}`, values: [[today]] });     // V=返却日
        processed.push({ kind: 'return', number: row[COL_NUMBER], moved_to_prev: curName, sheet_row: sheetRow });
      }

      // 貸出開始: B列=貸与先、V列(返却日)をクリア。返却と同一行なら上記の後に適用されB/Vを上書き。
      // 既にB=貸与先かつV空で、返却対象でもない場合は冪等スキップ(無駄書き防止)。
      if (startLendee) {
        const alreadySet = !isReturn && curName === startLendee && !curRet;
        if (!alreadySet) {
          updates.push({ range: `${SHEET_NAME}!${colLetter(COL_NAME)}${sheetRow}`, values: [[startLendee]] }); // B=氏名=貸与先
          updates.push({ range: `${SHEET_NAME}!${colLetter(COL_RET)}${sheetRow}`, values: [['']] });            // V=返却日=空
          processed.push({ kind: 'lend', number: row[COL_NUMBER], lendee: startLendee, prev_name: curName || null, sheet_row: sheetRow });
        }
      }
    }

    if (!updates.length) return json({ ok: true, today, processed: 0, note: '該当車両が見つからない/既に反映済みです', return_targets: returnNums, start_targets: [...startMap.keys()] });
    if (dryRun) return json({ ok: true, dry_run: true, today, would_process: processed });

    const wr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
    });
    const wj = await wr.json();
    if (!wr.ok) return json({ error: 'sheet write failed', status: wr.status, detail: wj }, 500);
    return json({ ok: true, today, processed: processed.length, detail: processed });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
