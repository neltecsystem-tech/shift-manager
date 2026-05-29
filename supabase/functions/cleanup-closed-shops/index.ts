import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SPREADSHEET_ID = '1Owv83TGxSl15pqO0MaaF4AaLeslye0frfKAuo62TlGY';
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
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A3:AD3000`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const dataResult = await dataResp.json();
    const rows = dataResult.values ?? [];

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

    return new Response(JSON.stringify({
      success: true,
      message: `${cleared}件の店舗を処理（コース名クリア + B列に納品中止追加）`,
      total_checked: rows.length,
      cleared,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
