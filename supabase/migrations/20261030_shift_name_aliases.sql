-- 🔗 新聞 シフト表の名前 ↔ 単価マスタの照合(2026-10-30)
-- 発端: 単価マスタの「ELP」を「ELP/富岡恵理」に改名したが、シフト表は「ELP」のままだったため、
--       9月の支払明細が丸ごと作られなかった(24日分)。照合は空白を除いた完全一致なので、1文字違いでも黙って漏れる。
-- 対策:
--   1. 別名の表 shift_name_aliases(シフト表の書き方 → 単価マスタの名前)。finalize-shift と画面の支払計算が使う
--   2. 毎朝 shift_check_names() がシフト表(shift_sheet_cache)を単価マスタ(shift_rate_master)＋別名と突き合わせ、
--      合わない名前を常設アラート(sm_active_alerts kind=name_mismatch)に出す。直れば自動で消える
--   3. 単価マスタを改名したとき(invoice-sheet rename_rate)、旧名を別名として自動登録する

create table if not exists public.shift_name_aliases (
  alias_key text primary key,        -- シフト表の書き方から空白を全部除いたもの(照合キー)
  alias text not null,               -- シフト表の書き方(表示用)
  staff_name text not null,          -- 単価マスタの名前(この人の単価で払う)
  note text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now()
);
-- 読み書きは EF(service_role)だけ。新聞ツールは invoice-sheet 経由(管理者)
alter table public.shift_name_aliases enable row level security;
revoke all on public.shift_name_aliases from anon, authenticated;

-- 照合キー(finalize-shift の invNormName と同じ: 空白・全角空白・NBSP を全部除く)
create or replace function public.shift_name_key(t text) returns text
language sql immutable as $$ select regexp_replace(coalesce(t, ''), '[\s　 ]+', '', 'g') $$;

-- 指定のシフト表で、単価マスタにも別名にも当たらない名前(セル数つき)。
-- 対象はコースの段(上の表: 7〜116行目・2列目以降・コース名が営業所で始まる行)。支払いの無い書き込み(希望休など)と見出し語は除く
create or replace function public.shift_name_mismatches(p_sheet text)
returns table(name text, cells int)
language sql stable security definer set search_path = public as $$
  with cells as (
    select trim(x.v #>> '{}') as v
    from shift_sheet_cache c,
         jsonb_array_elements(c.rows) with ordinality r(rw, i),
         jsonb_array_elements(r.rw) with ordinality x(v, j)
    where c.sheet_name = p_sheet and r.i between 7 and 116 and x.j >= 2
      -- 自動確定(finalize-shift の areaOfCourse)と同じく、コース名が営業所で始まる行だけ(「フォロー」などは支払いに使わない)
      and (r.rw ->> 0) ~ '^(城北|川越|立川|川崎)'
  ),
  names as (
    select min(v) as v, shift_name_key(v) as k, count(*)::int as n from cells
    where v <> '' and v !~ '^[0-9０-９./:-]+$'
      and v !~ '(ミーティング|希望休|研修|有給|欠勤|出張|五反田|目黒|渋谷|休刊|引継)'
      and v not in ('朝刊', '夕刊', '競馬')
    group by shift_name_key(v)
  )
  select n.v, n.n from names n
  where n.k <> ''
    and not exists (select 1 from shift_rate_master m where shift_name_key(m.name) = n.k)
    and not exists (select 1 from shift_name_aliases a where a.alias_key = n.k)
  order by n.n desc, n.v;
$$;
revoke all on function public.shift_name_mismatches(text) from public, anon, authenticated;

-- 毎朝の点検: 前月(10日まで=確定・反映の前)・今月・来月のシフト表を見て、合わない名前を常設アラートに出す
create or replace function public.shift_check_names()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d date := (now() at time zone 'Asia/Tokyo')::date;
  m date;
  sheet text;
  ym text;
  lst text[];
  total int;
  v_key text;
  out jsonb := '[]'::jsonb;
begin
  for m in select generate_series(date_trunc('month', d) - interval '1 month', date_trunc('month', d) + interval '1 month', interval '1 month')::date loop
    ym := to_char(m, 'YYYY-MM');
    v_key := 'name_mismatch:' || ym;
    sheet := extract(month from m)::int || '月シフト' || extract(year from m)::int;
    -- 前月は10日(反映)を過ぎたら見ない
    if m < date_trunc('month', d)::date and extract(day from d) > 10 then
      update sm_active_alerts set status = 'resolved', resolved_at = now(), updated_at = now() where sm_active_alerts.key = v_key and status = 'open';
      continue;
    end if;
    if not exists (select 1 from shift_sheet_cache where sheet_name = sheet) then continue; end if;
    select array_agg(format('%s（%sセル）', x.name, x.cells)), coalesce(sum(x.cells), 0) into lst, total from shift_name_mismatches(sheet) x;
    if lst is null then
      update sm_active_alerts set status = 'resolved', resolved_at = now(), cnt = 0, updated_at = now() where sm_active_alerts.key = v_key and status = 'open';
    else
      insert into sm_active_alerts (key, app, kind, title, body, cnt, names, status, updated_at, resolved_at)
      values (v_key, 'shift-manager', 'name_mismatch',
        format('🔗 %s のシフト表に、単価マスタと合わない名前が%s件あります', ym, array_length(lst, 1)),
        'シフト表の名前は単価マスタの名前と1文字違わず一致しないと、その人の支払明細が作られません（9月に「ELP」で24日分の漏れが出ました）。'
          || E'\n' || '新聞ツール → 管理 → 「🔗 名前の照合」で、単価マスタの名前に書き換えるか、別名として登録してください（単価マスタで改名したときは旧名が自動で別名になります）。',
        array_length(lst, 1), to_jsonb(lst), 'open', now(), null)
      on conflict (key) do update set title = excluded.title, body = excluded.body, cnt = excluded.cnt, names = excluded.names,
        status = 'open', updated_at = now(), resolved_at = null;
    end if;
    out := out || jsonb_build_object('month', ym, 'sheet', sheet, 'names', coalesce(to_jsonb(lst), '[]'::jsonb));
  end loop;
  return out;
end $$;
revoke all on function public.shift_check_names() from public, anon, authenticated;

-- 毎朝 7:40 JST(シフト表の写しの更新のあと)
select cron.unschedule('shift-check-names') where exists (select 1 from cron.job where jobname = 'shift-check-names');
select cron.schedule('shift-check-names', '40 22 * * *', $$ select public.shift_check_names(); $$);

-- 9月の「ELP」は単価マスタの「ELP/富岡恵理」と同じ人(8月まで「ELP」で払っていた行。電話 09020472707 で確認)
insert into public.shift_name_aliases (alias_key, alias, staff_name, note, created_by)
values (public.shift_name_key('ELP'), 'ELP', 'ELP/富岡恵理', '2026-10-30 単価マスタの改名(ELP→ELP/富岡恵理)でシフト表が旧名のまま。9月分が未払いだった', 'system')
on conflict (alias_key) do nothing;
