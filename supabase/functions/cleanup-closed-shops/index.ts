import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SPREADSHEET_ID = '1Owv83TGxSl15pqO0MaaF4AaLeslye0frfKAuo62TlGY';
const SHEET_NAME = '店舗マスタ';

const SERVICE_ACCOUNT = {
  client_email: 'workchat@my-project-78970-492704.iam.gserviceaccount.com',
  private_key: `-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCbftKwy+UTdvNJ\nPUTNkw4hVNMam55Kz/FBPUGlda4aGY1JLafRI4zYKvRDJO4aK3pTewf+hUJlghfL\nmxh52RufPfubbMobOT9K2RylwGh07fA8mZxtGI/adUScXStcpWik7S450XeK+2f9\nrFxanDPTTRe6hducqgm3Dzrv039e1YnInN7gS8+EvHvNvbAbfaPo6z4WQmiCtA9q\nMcRndTENcCjfaiaE3hCAT+BWIfRRYy7tC10vzMrP+3mSkXgL8utVLwqceMepOg9F\nHNlkj/6TEtgeFrKP4FtDUfSBGVGKcmp2Kq3LLZC04mt2xKMCflKkaV8IZQCTtujR\n31ULuc8jAgMBAAECggEAS5wmICDtMYNQNodL2viMUOnZwuDz3iXyBoqeTrID6B4P\npQtFxHzYYk60uqeM/f2xPEGheAJdcFWLc45lnu5Sr6Koo4GJXyZ9n8wl0XVXdbAz\ndowtU6EzZgNKywvE54Zo9XV9WlEAI30vKlszBz5YNwGQLbskODA4jCKkQnThxP8n\nsCDYL4frjwDL2ivt2PWnHRlQtJsK4cBiP53nuMSNII+WwNlPEaJxJIpunxTv1inY\nye8Y0hlLioVzXG8OmBzr9/FrvFCSk9vyvOG578E4HbrcJDLRH0JY9Dzv2X7ZCqaC\ndM+mYapVjRMFiHAxA+5W58K1l0eEjD4J0r5kY4OunQKBgQDLaJtA+7BbUPRAc68V\nhjINkrlthmw0+uBFvCgR8CChGJ90gGAxY+LuaOU+uXekXU034ak15RbjdpKYY5Gr\nGHlsNZ57ABqJTRqT0UpMgTlGrBKGsApdh8rWFHJaiaCTZoLr0+HuBQz36cGj61L8\nepEBZY2qCyi66YrPev3mmlMUHwKBgQDDsuSspq6WozFP5aks+3VRyGdwNBlQtorn\n8fU3tmSsg38OVQ2UyU9U4sxNa1QaoLsvffBLxwAR1rJPANQlyiCUaqLsb/Ib1FUf\nojPqOgdIURSmvBBEEJFDTj6EiuJrhbU8kNfWBw3wF3exynuxRTxtHbtuN1v2+QrJ\n3THsdBeEfQKBgDNDoOVGyZKqG3Tm8vhkwtai5PLSjxDnLYDFw/+JWl/fech91kB8\nYSQe8a/WRG37ScvMpr27iAI5zwZzCbJqT6fS96ceRpHWCd25QJV5d/r0wRKK6YHb\nCGbd7lgdGYgsrNBMrUM0qKkOk8wBMgAJz+PfOU3i1BgPZfmWkMj+mfOXAoGASneG\nQJRklvmeSBLSH0XITMh/Y9jPUUFE9iHB9+M1x9d5v5BpzJYV0+1BZKxUopVK5TV8\n/LjKs/8IdruP/pk9cHxrZqDqdeCES7dDHfvazY/c1d12KxBK1lutum3G3rdQUa2k\nE9M3YIbtiv/LtZbs+XB44+W43u/BRTMgTiOW11kCgYAJ8lPHU1LaWBx4NljrpRKM\nEXaMt7lU78XXHnoR7wl21q8AWWVpJGphFXQvIGLcEJGAFksNrrkoUGXIiUHoiCsc\n9btykTJn1/GM8DkXF/TyIdgaL0UqDjU4tOwkayuI/D0nsgl2oQIP/ljU2HSiJIIY\nydAjQkwA4v75yjsVXjt8Kw==\n-----END PRIVATE KEY-----\n`,
  token_uri: 'https://oauth2.googleapis.com/token',
};

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
