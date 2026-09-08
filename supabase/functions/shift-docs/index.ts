import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// 新聞ツール「📁 資料」タブのバックエンド。営業所ごとの資料置き場。
//   ファイル本体 = Storage の private バケット `shift-docs`
//   メタデータ   = public.shift_documents
//   閲覧/追加 = ツールにログインできる人(ツール自体がPWゲート)、削除 = 管理者PW。
//   ※ ADMIN_PASSWORD は invoice-sheet と同じ SHIFT_UI_PASSWORD を見る(管理画面PWと同じもの)。
// verify_jwt=false でデプロイすること。

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ADMIN_PASSWORD = Deno.env.get('SHIFT_UI_PASSWORD') || 'neltec2026';
const BUCKET = 'shift-docs';
const OFFICES = ['立川', '城北', '川越', '川崎高津', '共通'];
// 🚨 Storage のキーに日本語は使えない(Invalid key)。営業所はASCIIのフォルダ名に置き換える。
const OFFICE_DIR: Record<string, string> = {
  '立川': 'tachikawa', '城北': 'johoku', '川越': 'kawagoe', '川崎高津': 'takatsu', '共通': 'common',
};
const MAX_BYTES = 15 * 1024 * 1024;

const clip = (v: unknown, n: number) => (v == null ? null : String(v).slice(0, n));

/** base64 → Uint8Array (data URL も許容) */
function decodeBase64(b64: string): Uint8Array {
  const body = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Storage のキーに使えるファイル名にする。
 * 🚨 percent encode では通らない(supabase-js はパスをURLに載せ、サーバ側でデコードするため
 *    結果として日本語キーのまま Invalid key で弾かれる)。ASCIIだけに落とす。
 *    表示・ダウンロード名は DB の file_name(元の名前)を使うので、キーは機械的な名前で構わない。
 */
function safeName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) : '';
  const stem = (dot > 0 ? name.slice(0, dot) : name)
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 60) || 'file';
  return ext ? `${stem}.${ext}` : stem;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  try {
    const b = await req.json().catch(() => ({} as Record<string, any>));
    const action = String(b.action ?? '');
    const isAdmin = !!b.admin_password && b.admin_password === ADMIN_PASSWORD;

    // ── 一覧 ──
    if (action === 'list') {
      let q = sb.from('shift_documents')
        .select('id, office, title, file_name, mime_type, file_size, note, uploaded_by, created_at')
        .order('created_at', { ascending: false });
      if (b.office && b.office !== 'all') q = q.eq('office', String(b.office));
      const { data, error } = await q;
      if (error) return json({ success: false, error: error.message }, 500);
      // 営業所ごとの件数も返す(タブのバッジ用)
      const { data: allRows } = await sb.from('shift_documents').select('office');
      const counts: Record<string, number> = {};
      for (const r of (allRows ?? []) as any[]) counts[r.office] = (counts[r.office] ?? 0) + 1;
      return json({ success: true, offices: OFFICES, counts, docs: data ?? [] });
    }

    // ── 追加(アップロード) ──
    if (action === 'upload') {
      const office = String(b.office ?? '');
      if (!OFFICES.includes(office)) return json({ success: false, error: '営業所の指定が不正です' }, 400);
      const fileName = clip(b.file_name, 200);
      if (!fileName) return json({ success: false, error: 'ファイル名がありません' }, 400);
      if (!b.content_base64) return json({ success: false, error: 'ファイルの中身がありません' }, 400);

      let bytes: Uint8Array;
      try { bytes = decodeBase64(String(b.content_base64)); }
      catch (_) { return json({ success: false, error: 'ファイルを読み取れませんでした' }, 400); }
      if (!bytes.length) return json({ success: false, error: 'ファイルが空です(0バイト)' }, 400);
      if (bytes.length > MAX_BYTES) return json({ success: false, error: `ファイルが大きすぎます(${(bytes.length / 1048576).toFixed(1)}MB / 上限15MB)` }, 400);

      const path = `${OFFICE_DIR[office]}/${Date.now()}_${safeName(fileName)}`;
      const mime = clip(b.mime_type, 120) || 'application/octet-stream';
      const up = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
      if (up.error) return json({ success: false, error: 'アップロード失敗: ' + up.error.message }, 500);

      const row = {
        office, title: clip(b.title, 200) || fileName, file_name: fileName,
        storage_path: path, mime_type: mime, file_size: bytes.length,
        note: clip(b.note, 1000), uploaded_by: clip(b.uploaded_by, 80),
      };
      const { data, error } = await sb.from('shift_documents').insert(row).select('id').single();
      if (error) {
        await sb.storage.from(BUCKET).remove([path]);   // 行が作れないならファイルも残さない
        return json({ success: false, error: '登録失敗: ' + error.message }, 500);
      }
      return json({ success: true, id: data?.id, size: bytes.length });
    }

    // ── 署名付きURL(閲覧・ダウンロード) ──
    if (action === 'url') {
      const { data: doc, error } = await sb.from('shift_documents')
        .select('storage_path, file_name').eq('id', String(b.id ?? '')).maybeSingle();
      if (error || !doc) return json({ success: false, error: '資料が見つかりません' }, 404);
      const dl = b.download === true ? { download: doc.file_name } : undefined;
      const signed = await sb.storage.from(BUCKET).createSignedUrl(doc.storage_path, 3600, dl);
      if (signed.error) return json({ success: false, error: signed.error.message }, 500);
      return json({ success: true, url: signed.data.signedUrl, file_name: doc.file_name });
    }

    // ── 削除(管理者PWのみ) ──
    if (action === 'delete') {
      if (!isAdmin) return json({ success: false, error: '削除は管理者パスワードが必要です' }, 401);
      const { data: doc } = await sb.from('shift_documents')
        .select('storage_path').eq('id', String(b.id ?? '')).maybeSingle();
      if (!doc) return json({ success: false, error: '資料が見つかりません' }, 404);
      await sb.storage.from(BUCKET).remove([doc.storage_path]);
      const { error } = await sb.from('shift_documents').delete().eq('id', String(b.id));
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true });
    }

    return json({ success: false, error: 'unknown action' }, 400);
  } catch (e) {
    return json({ success: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
