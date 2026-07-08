import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// 新聞シフト(shift-manager)等のフロントで起きた未捕捉エラーを収集する軽量エンドポイント。
// service role で sm_error_logs に insert する(RLSはservice roleのみ許可)。
// verify_jwt=false でデプロイ(静的サイトから認証なしで叩けるように)。呼び出し側でスロットル済み。
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const clip = (v: unknown, n: number) => (v == null ? null : String(v).slice(0, n));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const b = await req.json().catch(() => ({} as Record<string, unknown>));
    const message = clip(b.message, 2000);
    // メッセージも kind も無い＝無効
    if (!message && !b.kind) return json({ ok: false, skipped: true });
    const row = {
      app: clip(b.app, 40) || 'shift-manager',
      build: clip(b.build, 40),
      view: clip(b.view, 60),
      user_name: clip(b.user_name, 80),
      kind: clip(b.kind, 40) || 'error',
      message,
      stack: clip(b.stack, 6000),
      source: clip(b.source, 400),
      url: clip(b.url, 400),
      ua: clip(b.ua, 400),
      healed: b.healed === true,
    };
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { error } = await sb.from('sm_error_logs').insert(row);
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
