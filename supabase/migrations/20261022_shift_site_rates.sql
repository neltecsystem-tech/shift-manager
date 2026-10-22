-- 拠点別の単価 (2026-10-22)
--
-- スタッフが拠点(城北/川越/立川/川崎高津)をまたいで働くとき、拠点ごとに別の単価一式(計算のしかたも含む)を持てる。
-- 計算の決まり(ユーザー決定 2026-10-22):
--   ・その日のコースから拠点を判断(areaOfCourse: 城北/川越/立川/川崎 で始まる)
--   ・その人にその拠点の単価があり、effective_from(YYYY-MM)がその日の月以前のもののうち一番新しいものを使う
--   ・使うときは「単価一式」をまるごと差し替える(空欄は空欄=0円。基本の単価からは補わない)。
--     川越のコース別単価(kw_pattern)・曜日別単価(kw_am_daily)はその日は使わない
--   ・その拠点の単価が無い日は、今までどおり基本の単価(単価マスタ)
-- 単価マスタ(Googleシート)には列を足さない(列追加で読取が全断した前例・Supabase移行予定のため)。
-- 読み書きは invoice-sheet EF(管理者)だけ。RLS はポリシー無し = service_role のみ。

create table if not exists public.shift_site_rates (
  id uuid primary key default gen_random_uuid(),
  staff_name text not null,                       -- 単価マスタの氏名(照合は空白を除いて行う)
  area text not null check (area in ('城北', '川越', '立川', '川崎高津')),
  effective_from text not null check (effective_from ~ '^\d{4}-\d{2}$'),   -- この月の分から
  am_weekday text not null default '', am_weekend text not null default '', am_sunday text not null default '',
  pm_weekday text not null default '', pm_weekend text not null default '', pm_sunday text not null default '',
  warehouse_am text not null default '', warehouse_pm text not null default '',
  calc_type text not null default '固定' check (calc_type in ('固定', '個建', '個数')),
  unit_price text not null default '',
  calc_type_pm text not null default '' check (calc_type_pm in ('', '固定', '個建', '個数')),
  unit_price_pm text not null default '',
  note text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_name, area, effective_from)
);
alter table public.shift_site_rates enable row level security;
revoke all on public.shift_site_rates from anon, authenticated;
