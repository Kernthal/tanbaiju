/**
 * 在 Supabase 上创建数据库结构。
 *
 * 安全：service_role 密钥权限极高（BYPASSRLS，可绕过所有 RLS），
 * 绝不能写进代码或提交到仓库。本脚本从环境变量读取。
 *
 * 用法（PowerShell）：
 *   $env:SUPABASE_SECRET_KEY = "sb_secret_xxx"
 *   node tools/setup-supabase.js
 *
 * 注意：Supabase 默认不开放 exec_sql 这类函数，多数实例无法通过 REST 远程建表。
 * 若脚本提示无权限，请到 Dashboard → SQL Editor 手动执行 supabase/schema.sql。
 */

const fs = require('fs');
const path = require('path');

const SB = process.env.SUPABASE_URL || 'https://crscsipvlytlfjycnptn.supabase.co';
const SERVICE = process.env.SUPABASE_SECRET_KEY || '';

async function sql(statement) {
  const res = await fetch(SB + '/rest/v1/rpc/exec_sql', {
    method: 'POST',
    headers: {
      apikey: SERVICE,
      Authorization: 'Bearer ' + SERVICE,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: statement }),
  });
  return { status: res.status, text: await res.text() };
}

(async () => {
  if (!SERVICE) {
    console.log('未提供 SUPABASE_SECRET_KEY 环境变量。');
    console.log('请到 Dashboard → SQL Editor 执行 supabase/schema.sql（推荐，最可靠）。');
    process.exit(0);
  }

  console.log('目标:', SB);
  const probe = await sql('select 1');
  console.log('连通性:', probe.status);

  if (probe.status !== 200) {
    console.log('\n该实例不允许通过 REST 执行 SQL（Supabase 的安全设计）。');
    console.log('请到 Dashboard → SQL Editor 打开并执行：supabase/schema.sql');
    process.exit(0);
  }

  const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  const statements = [];
  let buf = '';
  let inDollar = false;
  for (const line of schema.split('\n')) {
    const dollars = (line.match(/\$\$/g) || []).length;
    if (dollars % 2 === 1) inDollar = !inDollar;
    buf += line + '\n';
    if (!inDollar && /;\s*$/.test(line)) {
      const s = buf.trim();
      if (s && !/^--/.test(s)) statements.push(s);
      buf = '';
    }
  }

  console.log('\n待执行语句:', statements.length, '条\n');
  let ok = 0, bad = 0;
  for (const s of statements) {
    const head = s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'))[0] || '';
    const res = await sql(s);
    if (res.status === 200) { ok++; console.log('  OK   ' + head.slice(0, 60)); }
    else if (/already exists|duplicate/i.test(res.text || '')) { ok++; console.log('  SKIP ' + head.slice(0, 50) + ' (已存在)'); }
    else { bad++; console.log('  FAIL ' + head.slice(0, 50) + '\n       ' + (res.text || '').slice(0, 150)); }
  }
  console.log('\n完成: 成功 ' + ok + ' / 失败 ' + bad);
  process.exit(bad ? 1 : 0);
})();