import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const FOLDER_ID = '1_YBT9Cx9G2EzyG-qsH_8r4kleHKoolvT';

const SERVICE_ACCOUNT = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY')!);

function b64url(data: string): string { return btoa(data).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }

async function getAccessToken(): Promise<string> {
  const now=Math.floor(Date.now()/1000);
  const header=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const payload=b64url(JSON.stringify({iss:SERVICE_ACCOUNT.client_email,scope:'https://www.googleapis.com/auth/drive',aud:SERVICE_ACCOUNT.token_uri,iat:now,exp:now+3600}));
  const pemBody=SERVICE_ACCOUNT.private_key.replace(/-----BEGIN PRIVATE KEY-----/,'').replace(/-----END PRIVATE KEY-----/,'').replace(/\n/g,'');
  const binaryDer=Uint8Array.from(atob(pemBody),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey('pkcs8',binaryDer,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(`${header}.${payload}`));
  const signature=btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const jwt=`${header}.${payload}.${signature}`;
  const resp=await fetch(SERVICE_ACCOUNT.token_uri,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`});
  return (await resp.json()).access_token;
}

function generateInvoiceHTML(data: any): string {
  const { staff, from, to, records, total } = data;
  const fromFmt = from.replace(/-/g, '/');
  const toFmt = to.replace(/-/g, '/');
  const today = new Date().toLocaleDateString('ja-JP');
  let rows = '';
  for (const w of records) {
    rows += `<tr><td style="padding:6px 8px;border:1px solid #ccc;">${w.date}</td><td style="padding:6px 8px;border:1px solid #ccc;text-align:center;">${w.course}</td><td style="padding:6px 8px;border:1px solid #ccc;text-align:center;">${w.category}</td><td style="padding:6px 8px;border:1px solid #ccc;text-align:center;">${w.quantity || ''}</td><td style="padding:6px 8px;border:1px solid #ccc;text-align:right;">${w.unit_price ? '\u00a5' + Number(w.unit_price).toLocaleString() : ''}</td><td style="padding:6px 8px;border:1px solid #ccc;text-align:right;font-weight:bold;">${w.amount ? '\u00a5' + Number(w.amount).toLocaleString() : ''}</td></tr>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:'Meiryo',sans-serif;padding:40px;color:#1e293b;font-size:13px;}table{width:100%;border-collapse:collapse;}th,td{padding:6px 8px;border:1px solid #ccc;}</style></head><body>
<div style="text-align:center;margin-bottom:24px;"><h2 style="font-size:24px;border-bottom:3px double #1e293b;display:inline-block;padding-bottom:4px;">\u8acb \u6c42 \u66f8</h2></div>
<div style="display:flex;justify-content:space-between;margin-bottom:20px;"><div><p style="font-size:18px;font-weight:bold;border-bottom:1px solid #1e293b;padding-bottom:2px;">\u682a\u5f0f\u4f1a\u793eNELTEC \u5fa1\u4e2d</p></div><div style="text-align:right;"><p style="font-size:16px;font-weight:bold;margin-bottom:4px;">${staff}</p><p style="color:#64748b;">\u8acb\u6c42\u65e5: ${today}</p><p style="color:#64748b;">\u8acb\u6c42\u671f\u9593: ${fromFmt} \uff5e ${toFmt}</p></div></div>
<div style="background:#f1f5f9;border-radius:8px;padding:16px;text-align:center;margin-bottom:20px;"><p style="color:#64748b;">\u3054\u8acb\u6c42\u91d1\u984d</p><p style="font-size:28px;font-weight:bold;color:#1a56db;">\u00a5${total.toLocaleString()}</p></div>
<table><thead><tr style="background:#f1f5f9;"><th style="text-align:left;">\u65e5\u4ed8</th><th>\u30b3\u30fc\u30b9</th><th>\u533a\u5206</th><th>\u500b\u6570</th><th style="text-align:right;">\u5358\u4fa1</th><th style="text-align:right;">\u91d1\u984d</th></tr></thead><tbody>${rows}<tr style="background:#f1f5f9;font-weight:bold;"><td colspan="5" style="text-align:right;padding:8px;">\u5408\u8a08</td><td style="text-align:right;padding:8px;font-size:16px;">\u00a5${total.toLocaleString()}</td></tr></tbody></table></body></html>`;
}


// 🔒 2026-10-15: 新聞ツールのログイン(invoice-sheet が発行・SHIFT_SESSION_SECRET の HMAC)を必須にした。
//    それまで認証が無く、誰でも会社の Drive に任意の内容・名前の PDF(偽の請求書など)を作れた。
// 🚨 このファイルはデプロイ済みの版から取り出して版管理に入れたもの(2026-10-15)。以後はこれを正とする
const SHIFT_SESSION_SECRET = Deno.env.get('SHIFT_SESSION_SECRET') || '';
async function shiftLoggedIn(token: unknown): Promise<boolean> {
  if (!SHIFT_SESSION_SECRET || !token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SHIFT_SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts[0]));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (parts[1].length !== expected.length) return false;
    let diff = 0; for (let i = 0; i < expected.length; i++) diff |= parts[1].charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff !== 0) return false;
    const bin = atob(parts[0].replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return !(claims.exp && claims.exp < Date.now());
  } catch { return false; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json();
    const { staff, from, to, records, total, custom_html, custom_filename } = body;
    if (!(await shiftLoggedIn(body.auth_token))) {
      return new Response(JSON.stringify({ error: 'ログインが必要です（再ログインしてください）', code: 'AUTH_REQUIRED' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (!staff || !from || !to) {
      return new Response(JSON.stringify({ error: 'staff, from, to required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const token = await getAccessToken();
    // Use custom HTML if provided, otherwise generate invoice HTML
    const html = custom_html || generateInvoiceHTML({ staff, from, to, records: records || [], total: total || 0 });
    const pdfFileName = (custom_filename || `\u8acb\u6c42\u66f8_${staff}_${from}_${to}`) + '.pdf';

    // Upload HTML as Google Doc (temporary)
    const boundary = 'inv_' + Date.now();
    const metadata = JSON.stringify({
      name: '_temp_invoice_' + Date.now(),
      mimeType: 'application/vnd.google-apps.document',
      parents: [FOLDER_ID],
    });
    const encoder = new TextEncoder();
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;

    const uploadResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: encoder.encode(multipart),
    });

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      return new Response(JSON.stringify({ error: 'Drive upload failed: ' + uploadResp.status + ' ' + errText.slice(0, 500) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const uploadedFile = await uploadResp.json();
    const fileId = uploadedFile.id;

    // Export as PDF
    const pdfResp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application/pdf`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!pdfResp.ok) {
      await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
      return new Response(JSON.stringify({ error: 'PDF export failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const pdfBytes = await pdfResp.arrayBuffer();

    // Delete temp Google Doc
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});

    // Upload PDF
    const pdfBoundary = 'pdf_' + Date.now();
    const pdfMeta = JSON.stringify({ name: pdfFileName, parents: [FOLDER_ID] });
    const metaBytes = encoder.encode(`--${pdfBoundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${pdfMeta}\r\n--${pdfBoundary}\r\nContent-Type: application/pdf\r\n\r\n`);
    const endBytes = encoder.encode(`\r\n--${pdfBoundary}--`);
    const pdfData = new Uint8Array(pdfBytes);
    const fullBody = new Uint8Array(metaBytes.length + pdfData.length + endBytes.length);
    fullBody.set(metaBytes, 0);
    fullBody.set(pdfData, metaBytes.length);
    fullBody.set(endBytes, metaBytes.length + pdfData.length);

    const pdfUploadResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${pdfBoundary}` },
      body: fullBody,
    });

    if (!pdfUploadResp.ok) {
      const errText = await pdfUploadResp.text();
      return new Response(JSON.stringify({ error: 'PDF upload failed: ' + errText.slice(0, 300) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const pdfFile = await pdfUploadResp.json();
    return new Response(JSON.stringify({ success: true, file_id: pdfFile.id, file_name: pdfFileName, url: `https://drive.google.com/file/d/${pdfFile.id}/view` }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
