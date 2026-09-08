-- 新聞ツール「📁 資料」タブ: 営業所ごとの資料置き場。
--   ファイル本体は Storage の private バケット shift-docs に置き、
--   一覧・署名付きURL・削除は EF(shift-docs) 経由でのみ触る(service_role)。
--   ツール自体がログインで守られているため、閲覧・追加はログイン者、削除は管理者PW。

insert into storage.buckets (id, name, public, file_size_limit)
values ('shift-docs', 'shift-docs', false, 15728640)   -- 15MB/ファイル
on conflict (id) do update set public = false, file_size_limit = 15728640;

create table if not exists public.shift_documents (
  id uuid primary key default gen_random_uuid(),
  office text not null,                 -- 立川 / 城北 / 川越 / 川崎高津 / 共通
  title text not null,
  file_name text not null,
  storage_path text not null unique,
  mime_type text,
  file_size bigint,
  note text,
  uploaded_by text,                     -- ツール上の氏名(任意入力)
  created_at timestamptz not null default now()
);

create index if not exists shift_documents_office_idx on public.shift_documents (office, created_at desc);

-- 直接のクライアントアクセスは無し(EFがservice_roleで読む)。RLSは有効にして口を閉じる。
alter table public.shift_documents enable row level security;
