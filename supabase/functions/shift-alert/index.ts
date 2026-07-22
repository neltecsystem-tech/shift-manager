import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// 新聞ツール(shift-manager)の業務アラートを「状態ベースの常設アラート」として保持する。
// プッシュ通知ではなく、NexPort ビジネス画面が list を読んで、対処されるまで表示し続ける。
// action:
//  - 'sync' (shift-managerが呼ぶ): 現在の未対処リストを送る。>0なら open で upsert、0なら resolve。
//  - 'list' (NexPortが呼ぶ): open のアラートを返す。
// メッセージ本文は当EFがテンプレ生成(不正内容の注入防止)。verify_jwt=false。
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const clip = (v: unknown, n: number) => (v == null ? '' : String(v).slice(0, n));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const b = await req.json().catch(() => ({} as any));
    const action = clip(b.action || 'sync', 20);
    const app = clip(b.app || 'shift-manager', 40) || 'shift-manager';
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

    if (action === 'list') {
      const { data } = await sb.from('sm_active_alerts').select('key, kind, title, body, cnt, names, dismissed_cnt, updated_at').eq('app', app).eq('status', 'open').order('updated_at', { ascending: false });
      // 「確認して非表示」= dismissed_cnt が現在の cnt と一致するものは隠す(人数が変われば/再発すれば再表示)
      const alerts = (data ?? [])
        .filter((a: Record<string, unknown>) => a.dismissed_cnt == null || Number(a.dismissed_cnt) !== Number(a.cnt))
        .map((a: Record<string, unknown>) => { const { dismissed_cnt: _d, ...rest } = a; return rest; });
      return json({ ok: true, alerts });
    }

    // 'dismiss' (NexPortが呼ぶ): 確認済みとして現在の cnt を記録し非表示に。人数が変われば再表示される。
    if (action === 'dismiss') {
      const key = clip(b.key, 120);
      if (!key) return json({ ok: false, error: 'key required' }, 400);
      const { data: cur } = await sb.from('sm_active_alerts').select('cnt').eq('app', app).eq('key', key).maybeSingle();
      if (!cur) return json({ ok: false, error: 'not found' }, 404);
      await sb.from('sm_active_alerts').update({ dismissed_cnt: cur.cnt, updated_at: new Date().toISOString() }).eq('app', app).eq('key', key);
      return json({ ok: true, dismissed: true, key });
    }
    // 'undismiss' (再表示): 確認記録をクリア
    if (action === 'undismiss') {
      const key = clip(b.key, 120);
      if (!key) return json({ ok: false, error: 'key required' }, 400);
      await sb.from('sm_active_alerts').update({ dismissed_cnt: null, updated_at: new Date().toISOString() }).eq('app', app).eq('key', key);
      return json({ ok: true, undismissed: true, key });
    }

    if (action === 'sync') {
      const kind = clip(b.kind, 40);

      // シフト×稼働記録の不一致(3種)アラート
      if (kind === 'shift_work_mismatch') {
        const month = clip(b.month, 20);
        const key = `shift_work_mismatch:${month}`;
        const take = (a: unknown) => Array.isArray(a) ? (a as unknown[]).map((x) => clip(x, 40)).filter(Boolean).slice(0, 100) : [];
        // 稼働漏れ(シフト有/記録無)は法人配下ドライバー等の見かけ上の不一致が多いため、アラート対象から除外(ユーザー方針)。
        const extraWork = take(b.extraWork), catMismatch = take(b.catMismatch);
        const cnt = extraWork.length + catMismatch.length;
        if (cnt === 0) {
          await sb.from('sm_active_alerts').update({ status: 'resolved', resolved_at: new Date().toISOString(), cnt: 0, updated_at: new Date().toISOString() }).eq('key', key).eq('status', 'open');
          return json({ ok: true, resolved: true, key });
        }
        const seg = (label: string, arr: string[]) => arr.length ? `\n・${label} ${arr.length}名：${arr.slice(0, 8).join('、')}${arr.length > 8 ? ` 他${arr.length - 8}名` : ''}` : '';
        const title = '⚠️ シフトと稼働記録の不一致';
        const body = `新聞シフト管理 ${month}：シフトと稼働記録の不一致が${cnt}件あります。請求確定前に確認してください。`
          + seg('シフト外の稼働(記録有/シフト無・要確認)', extraWork)
          + seg('区分ズレ(要確認)', catMismatch);
        const names = [...extraWork, ...catMismatch].slice(0, 100);
        await sb.from('sm_active_alerts').upsert({ key, app, kind, title, body, cnt, names, status: 'open', resolved_at: null, updated_at: new Date().toISOString() }, { onConflict: 'key' });
        return json({ ok: true, open: true, key, cnt });
      }

      // 配送(ヤマト): 売上シートに稼働があるのに delivery 未登録のドライバー
      if (kind === 'yamato_unregistered') {
        const month = clip(b.month, 20);
        const key = `yamato_unregistered:${month}`;
        const names: string[] = Array.isArray(b.names) ? b.names.map((x: unknown) => clip(x, 40)).filter(Boolean).slice(0, 100) : [];
        const cnt = names.length;
        if (cnt === 0) {
          await sb.from('sm_active_alerts').update({ status: 'resolved', resolved_at: new Date().toISOString(), cnt: 0, updated_at: new Date().toISOString() }).eq('key', key).eq('status', 'open');
          return json({ ok: true, resolved: true, key });
        }
        const nameStr = `：${names.slice(0, 8).join('、')}${names.length > 8 ? ` 他${names.length - 8}名` : ''}`;
        const title = '⚠️ 配送(ヤマト) 未登録ドライバー';
        const body = `配送管理(ヤマト) ${month}：売上シートに稼働があるのにドライバー未登録が${cnt}名います。このままだと支払いに反映されません。配送管理でドライバー登録してください${nameStr}`;
        await sb.from('sm_active_alerts').upsert({ key, app, kind, title, body, cnt, names, status: 'open', resolved_at: null, updated_at: new Date().toISOString() }, { onConflict: 'key' });
        return json({ ok: true, open: true, key, cnt });
      }

      // アスクル: 配送実績シートに稼働があるのに profile 未紐付けのドライバー
      if (kind === 'askul_unregistered') {
        const month = clip(b.month, 20);
        const key = `askul_unregistered:${month}`;
        const names: string[] = Array.isArray(b.names) ? b.names.map((x: unknown) => clip(x, 40)).filter(Boolean).slice(0, 100) : [];
        const cnt = names.length;
        if (cnt === 0) {
          await sb.from('sm_active_alerts').update({ status: 'resolved', resolved_at: new Date().toISOString(), cnt: 0, updated_at: new Date().toISOString() }).eq('key', key).eq('status', 'open');
          return json({ ok: true, resolved: true, key });
        }
        const nameStr = `：${names.slice(0, 8).join('、')}${names.length > 8 ? ` 他${names.length - 8}名` : ''}`;
        const title = '⚠️ アスクル 未登録ドライバー';
        const body = `アスクル ${month}：配送実績に稼働があるのにドライバー未登録が${cnt}名います。このままだと支払いに反映されません。アスクル管理でドライバー登録してください${nameStr}`;
        await sb.from('sm_active_alerts').upsert({ key, app, kind, title, body, cnt, names, status: 'open', resolved_at: null, updated_at: new Date().toISOString() }, { onConflict: 'key' });
        return json({ ok: true, open: true, key, cnt });
      }

      if (kind !== 'rate_missing') return json({ ok: false, error: 'unsupported kind' }, 400);
      const month = clip(b.month, 20);
      const key = `rate_missing:${month}`;
      const names: string[] = Array.isArray(b.names) ? b.names.map((x: unknown) => clip(x, 40)).filter(Boolean).slice(0, 100) : [];
      const cnt = names.length;

      if (cnt === 0) {
        // 未登録ゼロ → 対処済みとして解消(open のものだけ)
        await sb.from('sm_active_alerts').update({ status: 'resolved', resolved_at: new Date().toISOString(), cnt: 0, updated_at: new Date().toISOString() }).eq('key', key).eq('status', 'open');
        return json({ ok: true, resolved: true, key });
      }

      // 未登録あり → open で upsert(本文はテンプレ生成)
      const nameStr = `：${names.slice(0, 8).join('、')}${names.length > 8 ? ` 他${names.length - 8}名` : ''}`;
      const title = '⚠️ 単価マスタ未登録スタッフ';
      const body = `新聞シフト管理 ${month}：単価マスタ未登録が${cnt}名います。このままだと支払い明細が作成されません。スタッフ管理から単価を登録してください${nameStr}`;
      await sb.from('sm_active_alerts').upsert({
        key, app, kind, title, body, cnt, names, status: 'open', resolved_at: null, updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
      return json({ ok: true, open: true, key, cnt });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
