/**
 * 我的：个人主页、通知、设置、主题、数据导出、审核后台。
 * 社交能力的入口都收在这里，后续加好友/动态可以继续往里扩。
 */

window.viewMe = async function viewMe(host, params) {
  const q = ui.el;

  if (!store.me) {
    ui.render(host, q('div', { class: 'login-wrap' }, [
      q('div', { class: 'login-card col gap-14' }, [
        q('div', { class: 't-2', style: { textAlign: 'center' }, text: '还没有登录' }),
        q('div', { class: 't-sm c-3', style: { textAlign: 'center' }, text: '登录后可以创建坦白局、查看自己的数据' }),
        q('a', { class: 'btn btn-primary btn-block', href: '#/login', text: '去登录' }),
      ]),
    ]));
    return;
  }

  // 看别人时切到访客视角
  if (params.id && params.id !== store.me.id) {
    return renderOtherProfile(host, params.id);
  }

  const body = q('div', { class: 'layout-desk' });

  function userCard() {
    const m = store.me;
    return q('div', { class: 'card card-pad-lg col gap-14' }, [
      q('div', { class: 'row gap-14' }, [
        ui.avatar(m.avatar, 'avatar-2x', 'T'),
        q('div', { class: 'col gap-4 flex-1' }, [
          q('div', { class: 'row gap-6 items-start' }, [
            q('div', { class: 't-2', text: m.nickname }),
            m.identity === 'guest'
              ? q('span', { class: 'chip', text: '访客' })
              : m.identity.indexOf('phone:') === 0
                ? q('span', { class: 'chip chip-on', text: '已验证' })
                : null,
          ]),
          q('div', { class: 't-sm c-3', text: m.bio || '这个人很懒，什么都没写' }),
          q('div', { class: 't-xs c-3', text: '加入于 ' + new Date(m.createdAt).toLocaleDateString('zh-CN') }),
        ]),
      ]),
      q('div', { class: 'stat-grid' }, [
        { n: m.stats.rooms, l: '发起' },
        { n: m.stats.posts, l: '提问' },
        { n: m.stats.received, l: '被回答' },
        { n: m.stats.hearts, l: '心动' },
      ].map((it) => q('div', { class: 'stat-box' }, [
        q('div', { class: 'stat-num c-brand tnum', text: ui.fmtCount(it.n) }),
        q('div', { class: 'stat-label', text: it.l }),
      ]))),
      q('div', { class: 'row gap-8' }, [
        q('button', { class: 'btn btn-primary flex-1', text: '创建坦白局', onclick: () => router.navigate('/create') }),
        q('button', { class: 'btn btn-ghost', text: '分享主页', onclick: shareProfile }),
      ]),
    ]);
  }

  async function shareProfile() {
    const link = location.origin + '/#/me/' + store.me.id;
    try {
      await navigator.clipboard.writeText(link);
      ui.toast('主页链接已复制', 'ok');
    } catch (_) {
      ui.toast(link);
    }
  }

  /* ---------- 我的坦白局 ---------- */

  function roomsCard(rooms) {
    return q('div', { class: 'card card-pad-lg col gap-12' }, [
      q('div', { class: 'row between' }, [
        q('div', { class: 't-3', text: '我的坦白局' }),
        q('span', { class: 't-sm c-3 tnum', text: rooms.length + ' 场' }),
      ]),
      rooms.length
        ? q('div', { class: 'col gap-8' }, rooms.map((r) => q('div', {
            class: 'room-card',
            onclick: () => router.navigate('/room/' + r.id),
          }, [
            q('div', { class: 'col gap-4 flex-1', style: { minWidth: '0' } }, [
              q('div', { class: 'room-title ellipsis', text: r.title }),
              q('div', { class: 'room-stats' }, [
                q('span', {}, [q('b', { text: String(r.counts.questions) }), document.createTextNode(' 问')]),
                q('span', {}, [q('b', { text: String(r.counts.answers) }), document.createTextNode(' 答')]),
                q('span', {}, [q('b', { text: String(r.counts.pending) }), document.createTextNode(' 待答')]),
              ]),
            ]),
            r.state === 'live'
              ? q('span', { class: 'state-live', text: '进行中' })
              : q('span', { class: 'chip state-done', text: '已结束' }),
          ])))
        : q('div', { class: 'empty', style: { padding: '26px 10px' } }, [
            q('div', { class: 'empty-art', text: '?' }),
            q('div', { class: 't-sm', text: '还没创建过坦白局' }),
          ]),
    ]);
  }

  /* ---------- 设置 ---------- */

  function settingsCard() {
    const themes = [
      { k: 'light', l: '浅色', d: '干净清爽，默认', sw: 'swatch-light' },
      { k: 'dark', l: '深色', d: '夜间使用', sw: 'swatch-dark' },
      { k: 'eye', l: '护眼', d: '低蓝光，久看不累', sw: 'swatch-eye' },
    ];
    const cur = store.theme;

    const themeList = q('div');
    themes.forEach((t) => {
      themeList.appendChild(q('button', {
        class: 'theme-opt' + (cur === t.k ? ' on' : ''),
        onclick: () => {
          store.setTheme(t.k);
          themeList.querySelectorAll('.theme-opt').forEach((n) => n.classList.remove('on'));
          themeList.querySelectorAll('.theme-opt')[themes.indexOf(t)].classList.add('on');
          ui.toast('主题已切换', 'ok');
        },
      }, [
        q('div', { class: 'theme-swatch ' + t.sw }),
        q('div', { class: 'flex-1' }, [
          q('div', { class: 't-body bold', text: t.l }),
          q('div', { class: 't-xs c-3', text: t.d }),
        ]),
        cur === t.k ? q('span', { class: 'c-brand', text: '✓' }) : null,
      ]));
    });

    return q('div', { class: 'card card-pad-lg col gap-14' }, [
      q('div', { class: 't-3', text: '外观' }),
      themeList,
      q('hr', { class: 'divider' }),
      q('div', { class: 'col gap-2' }, [
        actionRow('导出我的数据', '下载 JSON 文件', () => {
          const a = document.createElement('a');
          a.href = '/api/export';
          a.download = '坦白局-我的数据.json';
          a.click();
        }),
        actionRow('举报审核台', '处理用户举报的内容', openModeration),
        actionRow('清除本地缓存', '退出登录并清理本机数据', async () => {
          const yes = await ui.confirm('将退出当前登录状态，确定吗？', { danger: true, okText: '清除' });
          if (!yes) return;
          try {
            await api.logout();
          } catch (_) { /* ignore */ }
          location.reload();
        }),
        actionRow('退出登录', '返回登录页', async () => {
          const yes = await ui.confirm('确定要退出登录吗？');
          if (!yes) return;
          try {
            await api.logout();
          } catch (_) { /* ignore */ }
          store.setMe(null);
          router.navigate('/home');
        }),
      ]),
    ]);
  }

  function actionRow(label, desc, onclick) {
    return q('button', {
      class: 'checkrow full',
      style: { textAlign: 'left', width: '100%' },
      onclick: onclick,
    }, [
      q('div', { class: 'flex-1' }, [
        q('div', { class: 't-body', text: label }),
        q('div', { class: 't-xs c-3', text: desc }),
      ]),
      q('span', { class: 'c-3' }, [icon('chevron', 14)]),
    ]);
  }

  /* ---------- 审核台 ---------- */

  async function openModeration() {
    const body = q('div', { class: 'col gap-10' }, [q('div', { class: 't-sm c-3', text: '加载中…' })]);
    ui.sheet({ title: '举报审核台', content: body });

    try {
      const d = await api.reports();
      if (!d.list.length) {
        ui.render(body, q('div', { class: 'empty', style: { padding: '30px 10px' } }, [
          q('div', { class: 'empty-art', text: '✓' }),
          q('div', { class: 't-sm', text: '没有待处理的举报' }),
        ]));
        return;
      }
      ui.render(body, q('div', { class: 'col gap-10' }, d.list.map((r) =>
        q('div', { class: 'card card-pad col gap-8' }, [
          q('div', { class: 'row between gap-8' }, [
            q('span', { class: 'chip chip-on', text: r.reason }),
            q('span', { class: 't-xs c-3', text: ui.timeAgo(r.createdAt) }),
          ]),
          r.detail ? q('div', { class: 't-sm c-2', text: r.detail }) : null,
          q('div', { class: 'row gap-8' }, [
            q('button', {
              class: 'btn btn-ghost btn-sm flex-1', text: '查看内容',
              onclick: () => {
                document.querySelector('.sheet-mask').remove();
                document.body.style.overflow = '';
                router.navigate('/room/' + r.roomId);
              },
            }),
            q('button', {
              class: 'btn btn-ghost btn-sm flex-1', text: '忽略',
              onclick: async () => {
                await api.resolveReport(r.id, 'dismiss');
                document.querySelector('.sheet-mask').remove();
                document.body.style.overflow = '';
                ui.toast('已忽略', 'ok');
              },
            }),
            q('button', {
              class: 'btn btn-danger btn-sm flex-1', text: '删除',
              onclick: async () => {
                await api.resolveReport(r.id, 'remove');
                document.querySelector('.sheet-mask').remove();
                document.body.style.overflow = '';
                ui.toast('已删除', 'ok');
              },
            }),
          ]),
        ]))));
    } catch (err) {
      ui.render(body, q('div', { class: 't-sm c-danger', text: err.message }));
    }
  }

  /* ---------- 导航宫格 ---------- */

  function navItem(label, route, count) {
    return q('a', {
      class: 'me-nav-item',
      href: '#/' + route,
    }, [
      q('span', { class: 'me-nav-num tnum', text: String(count || 0) }),
      q('span', { class: 'me-nav-label', text: label }),
    ]);
  }

  function navRow() {
    return q('div', { class: 'card card-pad-lg', id: 'meNav' }, [
      q('div', { class: 'row', style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)' } }, [
        navItem('动态', 'feed', 0),
        navItem('坦白局', 'rooms', 0),
        navItem('收藏', 'favorites', 0),
        navItem('关注', 'follows', 0),
        navItem('粉丝', 'fans', 0),
      ]),
    ]);
  }

  /** 侧栏：关系摘要卡 */
  function statsSideCard() {
    return q('div', { class: 'card card-pad-lg col gap-12' }, [
      q('div', { class: 't-3', text: '我的关系' }),
      q('div', { class: 'col gap-2', id: 'relBox' }, [
        q('div', { class: 't-sm c-3', text: '加载中…' }),
      ]),
      q('button', {
        class: 'btn btn-soft btn-block',
        text: '去发现更多人',
        onclick: () => router.navigate('/discover'),
      }),
    ]);
  }

  /* ---------- 渲染 ---------- */

  const mainCol = q('div', { class: 'col gap-16' }, [
    userCard(),
    navRow(),
    q('div', { class: 'card card-pad-lg', id: 'roomsBox' }, [
      q('div', { class: 't-sm c-3', text: '加载中…' }),
    ]),
    settingsCard(),
  ]);

  ui.render(host, q('div', { class: 'layout-desk' }, [
    mainCol,
    q('div', { class: 'side' }, [statsSideCard()]),
  ]));

  // 加载我发起过的坦白局
  try {
    const all = await api.rooms();
    const mine = all.list.filter((r) => store.me && r.ownerId === store.me.id);
    const box = document.getElementById('roomsBox');
    if (box) ui.render(box, roomsCard(mine));
  } catch (_) { /* ignore */ }

  // 加载关系数据（关注/粉丝/收藏）
  try {
    const [rel, favs] = await Promise.all([
      api.relation(store.me.id),
      api.myFavorites().catch(() => ({ total: 0 })),
    ]);
    store.relation = rel;
    store.favTotal = favs.total || 0;
    const nav = document.getElementById('meNav');
    if (nav) {
      ui.render(nav, [
        navItem('动态', 'feed', 0),
        navItem('我的坦白局', 'rooms', mine.length),
        navItem('收藏', 'favorites', favs.total || 0),
        navItem('关注', 'follows', rel.followingCount || 0),
        navItem('粉丝', 'fans', rel.followers || 0),
      ]);
    }
    const relBox = document.getElementById('relBox');
    if (relBox) {
      ui.render(relBox, [
        relRow('我关注的人', rel.followingCount || 0),
        relRow('关注我的人', rel.followers || 0),
        relRow('我发起的坦白局', rel.rooms || 0),
        relRow('我发出的内容', rel.posts || 0),
        relRow('我收藏的内容', rel.favorites || 0),
      ]);
    }
  } catch (_) { /* ignore */ }
};

function relRow(label, n) {
  const q = ui.el;
  return q('div', { class: 'row between', style: { padding: '7px 0' } }, [
    q('span', { class: 't-sm c-2', text: label }),
    q('span', { class: 't-sm bold tnum', text: String(n) }),
  ]);
}

/* ---------- 访客视角 ---------- */

async function renderOtherProfile(host, id) {
  const q = ui.el;
  ui.render(host, q('div', { class: 'skel', style: { height: '200px', borderRadius: '16px' } }));
  try {
    const d = await api.user(id);
    ui.render(host, q('div', { class: 'layout-desk' }, [
      q('div', { class: 'col gap-16' }, [
        q('div', { class: 'card card-pad-lg col gap-14' }, [
          q('div', { class: 'row gap-14' }, [
            ui.avatar(d.user.avatar, 'avatar-2x', 'T'),
            q('div', { class: 'col gap-4 flex-1' }, [
              q('div', { class: 't-2', text: d.user.nickname }),
              q('div', { class: 't-sm c-3', text: d.user.bio || '这个人很懒，什么都没写' }),
            ]),
          ]),
          q('div', { class: 'stat-grid' }, [
            { n: d.rooms.length, l: '发起' },
            { n: d.posts.length, l: '提问' },
            { n: d.user.stats.received, l: '被回答' },
            { n: d.hearts, l: '心动' },
          ].map((it) => q('div', { class: 'stat-box' }, [
            q('div', { class: 'stat-num c-brand tnum', text: ui.fmtCount(it.n) }),
            q('div', { class: 'stat-label', text: it.l }),
          ]))),
        ]),

        d.rooms.length ? q('div', { class: 'col gap-10' }, [
          q('div', { class: 't-3', text: 'TA 的坦白局' }),
          q('div', { class: 'grid grid-2' }, d.rooms.map((r) => q('div', {
            class: 'room-card',
            onclick: () => router.navigate('/room/' + r.id),
          }, [
            q('div', { class: 'col gap-6 flex-1', style: { minWidth: '0' } }, [
              q('div', { class: 'room-title', text: r.title }),
              q('div', { class: 'room-stats' }, [
                q('span', {}, [q('b', { text: String(r.counts.questions) }), document.createTextNode(' 问')]),
                q('span', {}, [q('b', { text: String(r.counts.answers) }), document.createTextNode(' 答')]),
              ]),
            ]),
          ]))),
        ]) : null,

        d.posts.length ? q('div', { class: 'col gap-10' }, [
          q('div', { class: 't-3', text: 'TA 问过的问题' }),
          q('div', { class: 'card card-pad col gap-8' }, d.posts.slice(0, 20).map((p) =>
            q('div', {
              class: 't-sm',
              style: { padding: '9px 0', borderBottom: '1px solid var(--line)', cursor: 'pointer' },
              onclick: () => router.navigate('/room/' + p.roomId),
              text: p.text,
            }))),
        ]) : null,
      ]),
    ]));
  } catch (err) {
    ui.render(host, q('div', { class: 'empty' }, [
      q('div', { class: 'empty-art', text: '!' }),
      q('div', { text: err.message }),
    ]));
  }
}