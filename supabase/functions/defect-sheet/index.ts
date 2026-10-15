import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const corsHeaders={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type'};
const SHEET_ID='1AoE_of_ZhKl1ebncnwl5-_h2RrnVuSmqFDHc01CWoJs';
const SA = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY')!);
function b64url(d:string){return btoa(d).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
async function getToken(){const now=Math.floor(Date.now()/1000);const h=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));const p=b64url(JSON.stringify({iss:SA.client_email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:SA.token_uri,iat:now,exp:now+3600}));const pk=SA.private_key.replace(/-----BEGIN PRIVATE KEY-----/,'').replace(/-----END PRIVATE KEY-----/,'').replace(/\n/g,'');const der=Uint8Array.from(atob(pk),c=>c.charCodeAt(0));const key=await crypto.subtle.importKey('pkcs8',der,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(`${h}.${p}`));const s=btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');const r=await fetch(SA.token_uri,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${h}.${p}.${s}`});return(await r.json()).access_token;}

// 🔒 2026-10-15: それまで認証が無く、誰でも不具合の記録を読む・追加する・書き換えることができた。
//    新聞ツールのログイントークン(invoice-sheet が発行・SHIFT_SESSION_SECRET の HMAC)を必須にする。
// 🚨 このファイルはデプロイ済み(認証なしの版)から取り出して版管理に入れたもの(2026-10-15)。以後はこれを正とする
const SESSION_SECRET=Deno.env.get('SHIFT_SESSION_SECRET')||'';
function b64urlDecode(s:string){const bin=atob(s.replace(/-/g,'+').replace(/_/g,'/'));const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return new TextDecoder().decode(u);}
async function verifyToken(token:unknown){
  if(!SESSION_SECRET||!token||typeof token!=='string')return null;
  const parts=token.split('.');if(parts.length!==2)return null;
  try{
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(parts[0]));
    const expected=btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    if(parts[1].length!==expected.length)return null;
    let diff=0;for(let i=0;i<expected.length;i++)diff|=parts[1].charCodeAt(i)^expected.charCodeAt(i);
    if(diff!==0)return null;
    const claims=JSON.parse(b64urlDecode(parts[0]));
    if(claims.exp&&claims.exp<Date.now())return null;
    return claims;
  }catch{return null;}
}

Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  try{
    const reqBody=await req.json();
    const{action,sheet_name,row,row_number,range}=reqBody;
    if(!(await verifyToken(reqBody.auth_token))){
      return new Response(JSON.stringify({error:'ログインが必要です（再ログインしてください）',code:'AUTH_REQUIRED'}),{status:401,headers:{...corsHeaders,'Content-Type':'application/json'}});
    }
    const token=await getToken();
    const sn=encodeURIComponent(sheet_name);

    if(action==='read'){
      const a1=(typeof range==='string'&&range)?range:'A1:I200';
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${sn}!${a1}`,{headers:{'Authorization':`Bearer ${token}`}});
      const body=await resp.text();
      return new Response(body,{status:resp.status,headers:{...corsHeaders,'Content-Type':'application/json'}});
    }

    if(action==='append'){
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${sn}!A1:I1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
      if(!resp.ok){const e=await resp.text();return new Response(JSON.stringify({error:e.slice(0,300)}),{status:500,headers:{...corsHeaders,'Content-Type':'application/json'}});}
      return new Response(JSON.stringify({success:true}),{headers:{...corsHeaders,'Content-Type':'application/json'}});
    }

    if(action==='update'){
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${sn}!A${row_number}:I${row_number}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
      if(!resp.ok){const e=await resp.text();return new Response(JSON.stringify({error:e.slice(0,300)}),{status:500,headers:{...corsHeaders,'Content-Type':'application/json'}});}
      return new Response(JSON.stringify({success:true}),{headers:{...corsHeaders,'Content-Type':'application/json'}});
    }

    return new Response(JSON.stringify({error:'Unknown action'}),{headers:{...corsHeaders,'Content-Type':'application/json'}});
  }catch(e:any){
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:{...corsHeaders,'Content-Type':'application/json'}});
  }
});
