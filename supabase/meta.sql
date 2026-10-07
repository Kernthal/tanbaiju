-- ============================================================
-- 补充表：登录票据 / 短信验证码 / 会话
--
-- 为什么需要：
--   supabase-data.js 把扫码票据与短信验证码存在 meta 表里。
--   Supabase 没有服务端内存可用，必须落库。
--   （首次建的 11 张表不含这张，需要单独执行本文件）
--
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴 → Run
-- ============================================================

create table if not exists meta (
  id            text primary key,      -- ticket:xxx / sms:138xxx
  kind          text not null,         -- ticket | sms
  status        text,                  -- ticket: waiting | confirmed | expired
  nickname      text,
  code          text,                  -- sms验证码
  tries         integer not null default 0,
  sent_at       bigint,
  expires_at    bigint,
  bound_identity text,
  created_at    bigint not null default (extract(epoch from now()) * 1000)::bigint
);

alter table meta enable row level security;

drop policy if exists "public_read_meta" on meta;
drop policy if exists "public_write_meta" on meta;
create policy "public_read_meta" on meta for select using (true);
create policy "public_write_meta" on meta for all using (true) with check (true);

-- 便于按类型与过期时间查询
create index if not exists idx_meta_kind on meta(kind);
create index if not exists idx_meta_expires on meta(expires_at);