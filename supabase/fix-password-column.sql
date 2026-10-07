-- ============================================================
-- 补充项 A：账号密码登录所需的列
--
-- 为什么需要：
--   supabase-data.js 的「账号密码登录」要把密码哈希存进 users.password，
--   首版 schema.sql 里没有这一列（当时只考虑了匿名 + 手机号 + 扫码）。
--
-- 执行：Supabase Dashboard → SQL Editor → 粘贴 → Run
-- 幂等，重复执行不会报错。
-- ============================================================

alter table users add column if not exists password text;