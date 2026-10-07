/**
 * 首页 / 广场：坦白局列表 + 标签筛选 + 实时热榜 + 运营统计。
 */

window.viewHome = async function viewHome(host, params) {
  const q = ui.el;

  let tag = (params && params.tag) || '';
  let timer = null;

  const listHost = q('div', { class: 'grid grid-2' });
  const sideHost = q('div', { class: 'side' });

  ui.render(host, q('div', { class: 'layout-desk' }, [
    q('div', { class: 'col gap-16' }, [
      banner(),
      q('div', { id: 'tagbar' }, q('div', { class: 'skel', style: { height: '28px', borderRadius: '99px', width: '320px' } })),
      listHost,
    ]),
    sideHost,
  ]));

  function banner() {
    return q('div', {
      class: 'room-hero',
      style: { padding: '24px 22px' },
    }, [
      q('div', { class: 'row between items-start gap-16 wrap' }, [
        q('div', { class: 'col gap-8 flex-1', style: { minWidth: '240px' } }, [
          q('div', { style: { fontSize: '23px', fontWeight: '800', letterSpacing: '-.5px', color: '#17191c' }, text: '今天一人问一个问题' }),
          q('div', { style: { fontSize: '14px', color: '#4a4f55', fontWeight: '550' }, text: '别人不敢问的，TA 会如实回答' }),
        ]),
        q('button', {
          class: 'btn btn-primary',
          text: '我也要玩',
          onclick: () => router.navigate('/create'),
        }),
      ]),
    ]);
  }

  async function loadRooms() {
    try {
      const d = await api.rooms(tag);
      ui.render(listHost, d.list.length
        ? d.list.map(roomCard)
        : q('div', { class: 'card card-pad-lg', style: { gridColumn: '1/-1' } }, [
            q('div', { class: 'empty' }, [
              q('div', { class: 'empty-art', text: '?' }),
              q('div', { text: tag ? '这个标签下还没有坦白局' : '还没有人创建坦白局' }),
              q('button', { class: 'btn btn-primary btn-sm mt-8', text: '创建第一个', onclick: () => router.navigate('/create') }),
            ]),
          ]));
    } catch (err) {
      ui.toast(err.message, 'err');
    }
  }

  function roomCard(r) {
    const cd = ui.countdownParts(r.deadline);
    return q('div', {
      class: 'room-card card-hover',
      onclick: () => router.navigate('/room/' + r.id),
    }, [
      q('div', { class: 'col gap-8 flex-1', style: { minWidth: '0' } }, [
        q('div', { class: 'row between gap-8 items-start' }, [
          q('div', { class: 'room-title flex-1 clamp-2', text: r.title }),
          r.state === 'live'
            ? q('span', { class: 'state-live', text: '进行中' })
            : q('span', { class: 'chip state-done', text: r.state === 'closed' ? '已关闭' : '已到期' }),
        ]),
        q('div', { class: 'row gap-8 items-start' }, [
          ui.avatar(r.avatar, 'avatar-sm', 'T'),
          q('div', { class: 'flex-1', style: { minWidth: '0' } }, [
            q('div', { class: 't-xs bold ellipsis', text: r.owner.nickname }),
            q('div', { class: 't-xs c-3 ellipsis', text: r.subtitle || r.slogan }),
          ]),
        ]),
        q('div', { class: 'room-stats' }, [
          q('span', {}, [q('b', { text: String(r.counts.questions) }), document.createTextNode(' 问')]),
          q('span', {}, [q('b', { text: String(r.counts.answers) }), document.createTextNode(' 答')]),
          q('span', {}, [q('b', { text: String(r.counts.hearts) }), document.createTextNode(' 心动')]),
        ]),
        (r.tags && r.tags.length)
          ? q('div', { class: 'row wrap gap-6' }, r.tags.map((t) => q('span', { class: 'chip', text: '#' + t })))
          : null,
        r.state === 'live'
          ? q('div', { class: 't-xs c-3' }, [
              '剩余 ',
              q('span', { class: 'countdown tnum', text: cd.d > 0 ? cd.d + '天' : cd.h + '小时' }),
            ])
          : null,
      ]),
    ]);
  }

  /* ---------- 标签栏 ---------- */

  async function loadTags() {
    const bar = document.getElementById('tagbar');
    if (!bar) return;
    let tags = [];
    try {
      const plaza = await api.plaza();
      tags = plaza.topTags || [];
    } catch (_) { /* ignore */ }
    const all = q('button', {
      class: 'chip chip-lg ' + (tag === '' ? 'chip-on' : ''),
      text: '全部',
      onclick: () => { tag = ''; loadTags(); loadRooms(); },
    });
    ui.render(bar, q('div', { class: 'row wrap gap-8' }, [all].concat(
      tags.map((t) => q('button', {
        class: 'chip chip-lg ' + (tag === t.tag ? 'chip-on' : ''),
        text: '#' + t.tag + ' ' + t.count,
        onclick: () => { tag = t.tag; loadTags(); loadRooms(); },
      }))
    )));
  }

  /* ---------- 侧栏 ---------- */

  async function loadSide() {
    ui.render(sideHost, q('div', { class: 'skel', style: { height: '160px', borderRadius: '16px' } }));

    try {
      const [plaza, stats] = await Promise.all([api.plaza(), api.stats()]);
      store.online = stats.online;

      const nodes = [];

      // 实时数据卡
      nodes.push(q('div', { class: 'card card-pad' }, [
        q('div', { class: 'row between mb-12' }, [
          q('div', { class: 't-3', text: '此刻' }),
          q('div', { class: 'row gap-6' }, [
            q('span', { style: { width: '6px', height: '6px', borderRadius: '50%', background: 'var(--brand)', animation: 'pulse 1.8s infinite' } }),
            q('span', { class: 't-sm c-3 tnum', text: stats.online + ' 人在线' }),
          ]),
        ]),
        q('div', { class: 'stat-grid' }, [
          { n: stats.totals.rooms, l: '坦白局' },
          { n: stats.totals.posts, l: '内容' },
          { n: stats.totals.users, l: '参与者' },
          { n: stats.totals.hearts, l: '心动' },
        ].map((it) => q('div', { class: 'col center', style: { padding: '6px 0' } }, [
          q('div', { class: 'stat-num tnum', style: { fontSize: '17px' }, text: ui.fmtCount(it.n) }),
          q('div', { class: 'stat-label', text: it.l }),
        ]))),
        activityChart(stats.buckets),
      ]));

      // 热榜
      if (plaza.hotPosts && plaza.hotPosts.length) {
        nodes.push(q('div', { class: 'card card-pad' }, [
          q('div', { class: 't-3 mb-8', text: '热门回答' }),
          q('div', {}, plaza.hotPosts.slice(0, 6).map((p, i) =>
            q('div', {
              class: 'rank-row',
              onclick: () => router.navigate('/room/' + p.roomId),
              style: { cursor: 'pointer' },
            }, [
              q('div', { class: 'rank-no top-' + (i + 1), text: String(i + 1) }),
              q('div', { class: 'flex-1', style: { minWidth: '0' } }, [
                q('div', { class: 't-sm clamp-2', text: p.text }),
                q('div', { class: 't-xs c-3 mt-4', text: (p.hearts + p.claps) + ' 次互动' }),
              ]),
            ]))),
        ]));
      }

      ui.render(sideHost, nodes);
    } catch (err) {
      ui.render(sideHost, q('div', { class: 'card card-pad t-sm c-3', text: '数据加载失败' }));
    }
  }

  /* ---------- 24 小时活跃图 ---------- */

  function activityChart(buckets) {
    const max = Math.max(1, ...buckets.map((b) => b.posts));
    const W = 100, H = 34;
    const gap = 0.7;
    const bw = (W - gap * (buckets.length - 1)) / buckets.length;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'chart');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + 4));
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.height = '84px';

    buckets.forEach((b, i) => {
      const h = Math.max(1.5, (b.posts / max) * H);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(i * (bw + gap)));
      rect.setAttribute('y', String(H - h));
      rect.setAttribute('width', String(bw));
      rect.setAttribute('height', String(h));
      rect.setAttribute('rx', '0.8');
      rect.setAttribute('fill', b.posts > 0 ? 'var(--brand)' : 'var(--line)');
      rect.setAttribute('class', 'chart-bar');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = b.hour + ' 时 · ' + b.posts + ' 条内容';
      rect.appendChild(title);
      svg.appendChild(rect);
    });
    return svg;
  }

  loadTags();
  await Promise.all([loadRooms(), loadSide()]);

  timer = setInterval(loadSide, 20000);

  return () => clearInterval(timer);
};