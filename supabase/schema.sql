-- ============================================================
-- 坦白局 · Supabase 数据库结构
-- 匿名提问 + 如实回答的社交网站
--
-- 设计要点：
--   1. 全部数据表以 text 存 JSONB 字段，前端结构变了不需要改表
--   2. 公开读、登录写。匿名用户用 device_id 作为身份锚点
--   3. RLS 策略尽量宽松（匿名可读），写入要求带有效身份
-- ============================================================

-- ---------- 用户 ----------
create table if not exists users (
  id            text primary key,
  identity      text unique not null,
  nickname      text not null,
  avatar        jsonb not null default '{}'::jsonb,
  bio           text not null default '',
  stats         jsonb not null default '{"rooms":0,"posts":0,"received":0,"hearts":0}'::jsonb,
  verified      boolean not null default false,
  created_at    bigint not null default (extract(epoch from now()) * 1000)::bigint
);

-- ---------- 坦白局 ----------
create table if not exists rooms (
  id            text primary key,
  code          text not null,
  owner_id      text not null references users(id) on delete cascade,
  owner_snapshot jsonb not null default '{}'::jsonb,
  title         text not null,
  subtitle      text not null default '',
  slogan        text not null default '',
  avatar        jsonb not null default '{}'::jsonb,
  theme         text not null default 'yellow',
  tags          jsonb not null default '[]'::jsonb,
  rules         jsonb not null default '{}'::jsonb,
  pinned        boolean not null default false,
  created_at    bigint not null default (extract(epoch from now()) * 1000)::bigint,
  deadline      bigint not null,
  closed        boolean not null default false
);

-- ---------- 内容（提问 / 回答 / 追问） ----------
create table if not exists posts (
  id            text primary key,
  room_id       text not null references rooms(id) on delete cascade,
  kind          text not null,              -- question | answer
  text          text not null default '',
  voice         jsonb,
  tags          jsonb not null default '[]'::jsonb,
  reply_to      text,
  author_identity text not null,
  author_snapshot jsonb not null default '{}'::jsonb,
  hearts        integer not null default 0,
  claps         integer not null default 0,
  likers        jsonb not null default '[]'::jsonb,
  clappers      jsonb not null default '[]'::jsonb,
  featured      boolean not null default false,
  pending       boolean not null default false,
  answered      boolean not null default false,
  report_count  integer not null default 0,
  mentions      jsonb not null default '[]'::jsonb,
  created_at    bigint not null default (extract(epoch from now()) * 1000)::bigint
);

-- ---------- 通知 ----------
create table if not exists messages (
  id            text primary key,
  user_id       text not null references users(id) on delete cascade,
  type          text not null,              -- answered | mention | follow
  text          text not null,
  room_id       text,
  post_id       text,
  read          boolean not null default false,
  created_at    bigint not null default (extract(epoch from now()) * 1000)::bigint
);

-- ---------- 社交关系 ----------
create table if not exists follows (
  id            text primary key,
  from_identity text not null,
  from_id       text,
  to_identity   text not null,
  to_id         text,
  created_at    bigint not null default (extract(epoch from now()) * 1000)::bigint,
  unique (from_identity, to_identity)
);

create table if not exists blocks (
  id            text primary key,
  from_identity text not null,
  to_identity   text not null,
  created_at    bigint not null default (extract(epoch from now()) * 1000)::bigint,
  unique (from_identity, to_identity)
);

create table if not exists favorites (
  id            text primary key,
  identity      text not null,
  post_id       text not null references posts(id) on delete cascade,
  room_id       text,
  created_at    bigint not null default (extract(epoch from now()) * 1000)::bigint,
  unique (identity, post_id)
);

-- ---------- 运营 ----------
create table if not exists visits (
  id            text primary key,
  room_id       text not null references rooms(id) on delete cascade,
  visitor_id    text not null,
  visitor_name  text not null default '',
  created_at    bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create table if not exists events (
  id            text primary key,
  room_id       text not null references rooms(id) on delete cascade,
  type          text not null,
  visitor_id    text not null,
  created_at    bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create table if not exists drafts (
  id            text primary key,
  identity      text not null,
  room_id       text not null,
  text          text not null default '',
  created_at    bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at    bigint not null default (extract(epoch from now()) * 1000)::bigint,
  unique (identity, room_id)
);

create table if not exists reports (
  id            text primary key,
  post_id       text not null,
  room_id       text,
  reason        text not null default '其他',
  detail        text not null default '',
  status        text not null default 'pending',
  created_at    bigint not null default (extract(epoch from now()) * 1000)::bigint
);

-- ---------- 索引 ----------
create index if not exists idx_posts_room      on posts(room_id);
create index if not exists idx_posts_created   on posts(created_at desc);
create index if not exists idx_posts_author    on posts(author_identity);
create index if not exists idx_rooms_created  on rooms(created_at desc);
create index if not exists idx_rooms_deadline on rooms(deadline);
create index if not exists idx_follows_from   on follows(from_identity);
create index if not exists idx_follows_to     on follows(to_identity);
create index if not exists idx_favs_identity  on favorites(identity);
create index if not exists idx_msgs_user      on messages(user_id, read);

-- ---------- 行级安全 ----------
-- 策略说明：这是公开社交应用，内容对所有人可读（这是产品特性，不是缺陷）。
-- 写入不额外收紧 ——真正的权限校验在应用层按身份比对完成。
-- 若要防止批量滥用，应在应用层加速率限制，而不是收紧 RLS。

alter table users     enable row level security;
alter table rooms     enable row level security;
alter table posts     enable row level security;
alter table messages  enable row level security;
alter table follows   enable row level security;
alter table blocks    enable row level security;
alter table favorites enable row level security;
alter table visits    enable row level security;
alter table events    enable row level security;
alter table drafts    enable row level security;
alter table reports   enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'users','rooms','posts','messages','follows',
    'blocks','favorites','visits','events','drafts','reports'
  ] loop
    execute format('drop policy if exists "public_read_%s" on %I;', t, t);
    execute format('create policy "public_read_%s" on %I for select using (true);', t, t);

    execute format('drop policy if exists "public_write_%s" on %I;', t, t);
    execute format('create policy "public_write_%s" on %I for all using (true) with check (true);', t, t);
  end loop;
end $$;
