import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// 新聞ツール(shift-manager)からの業務アラートを NexPort プッシュで管理者に送る。
// 現状 kind='rate_missing'(単価マスタ未登録スタッフ検出)のみ対応。
// メッセージは当EFがテンプレ生成(不正内容の注入防止)。同一状況は1日1回にデデュープ(スパム防止)。
// verify_jwt=false でデプロイ(静的サイトから呼べるように)。
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// 通知先を固定したい場合は SM_ALERT_USER_IDS(カンマ区切りのNexPort user_id)。未設定なら super_admin 全員。
const ALERT_USER_IDS = (Deno.env.get('SM_ALERT_USER_IDS') || '').split(',').map((s) => s.trim()).filter(Boolean);

const clip = (v: unknown, n: number) => (v == null ? '' : String(v).slice(0, n));
// JSTの日付(YYYY-MM-DD)
function jstDate(): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const b = await req.json().catch(() => ({} as any));
    const kind = clip(b.kind, 40);
    if (kind !== 'rate_missing') return json({ ok: false, error: 'unsupported kind' }, 400);
    const month = clip(b.month, 20);
    const area = clip(b.area, 40);
    const count = Math.max(0, Math.min(9999, parseInt(String(b.count || 0), 10) || 0));
    if (count <= 0) return json({ ok: true, skipped: true, reason: 'count=0' });
    const names: string[] = Array.isArray(b.names) ? b.names.map((x: unknown) => clip(x, 40)).filter(Boolean).slice(0, 20) : [];

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

    // デデュープ: 同一(kind/month/area)は当日1回だけ
    const dedupKey = `rate_missing:${month}:${area}:${jstDate()}`;
    const { data: exist } = await sb.from('sm_alerts_sent').select('dedup_key').eq('dedup_key', dedupKey).maybeSingle();
    if (exist) return json({ ok: true, skipped: true, reason: 'already sent today' });

    // 通知先(NexPort user_id)を解決
    let userIds = ALERT_USER_IDS;
    if (!userIds.length) {
      const { data: admins } = await sb.from('profiles').select('id').eq('role', 'super_admin');
      userIds = (admins ?? []).map((a: any) => a.id);
    }
    if (!userIds.length) return json({ ok: false, error: '通知先(管理者)が見つかりません' }, 200);

    // メッセージはEFがテンプレ生成
    const nameStr = names.length ? `：${names.slice(0, 5).join('、')}${names.length > 5 ? ` 他${names.length - 5}名` : ''}` : '';
    const title = '⚠️ 単価マスタ未登録スタッフ';
    const body = `${month}${area ? ` ${area}営業所` : ''}で単価マスタ未登録が${count}名います。このままだと支払い明細が作成されません${nameStr}`;

    // send-push を service role で呼ぶ
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ user_ids: userIds, title, body, url: 'https://neltecsystem-tech.github.io/' }),
    });
    const pushRes = await resp.json().catch(() => ({}));

    // 送信済みを記録(失敗時は記録しない=次回再送を許す)
    if (resp.ok) await sb.from('sm_alerts_sent').insert({ dedup_key: dedupKey, kind, detail: body.slice(0, 400) });

    return json({ ok: resp.ok, sent_to: userIds.length, push: pushRes });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
