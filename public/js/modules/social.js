/**
 * 社交前端模块。
 *
 * 覆盖：关注/取关、收藏、屏蔽、@提及提示、动态流、话题发现、可能感兴趣的人。
 * 与既有风格一致：手绘图标（.hicon）、浅色卡片、绿色主色、无 emoji。
 */

window.api.followUser = function followUser(id) {
  return request('POST', '/api/users/' + id + '/follow');
};
window.api.blockUser = function blockUser(id) {
  return request('POST', '/api/users/' + id + '/block');
};
window.api.relation = function relation(id) {
  return request('GET', '/api/users/' + id + '/relation');
};
window.api.fans = function fans(id) {
  return request('GET', '/api/users/' + id + '/fans');
};
window.api.follows = function follows(id) {
  return request('GET', '/api/users/' + id + '/follows');
};
window.api.favorite = function favorite(id) {
  return request('POST', '/api/posts/' + id + '/favorite');
};
window.api.myFavorites = function myFavorites() {
  return request('GET', '/api/me/favorites');
};
window.api.feed = function feed() {
  return request('GET', '/api/feed');
};
window.api.topics = function topics() {
  return request('GET', '/api/topics');
};
window.api.suggestions = function suggestions() {
  return request('GET', '/api/suggestions');
};

/* ============================================================
   关注按钮
   ============================================================ */

/**
 * 渲染关注按钮。会自动乐观更新，点击失败时回滚。
 * @param {object} user 目标用户 publicUser
 * @param {object} relation 关系摘要（可为 null）
 */
window.followButton = function followButton(user, relation, onChange) {
  const q = ui.el;
  const btn = q('button', { class: 'btn btn-sm' });
  let following = relation ? !!relation.following : false;

  function paint() {
    btn.className = 'btn btn-sm ' + (following ? 'btn-soft' : 'btn-primary');
    ui.render(btn, [
      icon(following ? 'check' : 'plus', 14),
      q('span', { text: following ? '已关注' : '关注' }),
    ]);
  }
  paint();

  btn.onclick = async (e) => {
    e.stopPropagation();
    if (!store.me || store.me.identity === 'guest') {
      ui.toast('请先登录再关注', 'err');
      return;
    }
    const prev = following;
    following = !following; // 乐观更新，点击即有反馈
    paint();
    btn.classList.add('loading');
    try {
      const r = await api.followUser(user.id);
      following = r.following;
      paint();
      ui.toast(following ? '已关注 ' + user.nickname : '已取消关注', 'ok');
      if (onChange) onChange(r);
    } catch (err) {
      following = prev; // 失败回滚
      paint();
      ui.toast(err.message, 'err');
    } finally {
      btn.classList.remove('loading');
    }
  };
  return btn;
};

/* ============================================================
   动态流视图
   ============================================================ */

window.viewFeed = async function viewFeed(host) {
  const q = ui.el;

  ui.render(host, q('div', { style: { maxWidth: '620px', margin: '0 auto' } }, [
    q('div', { class: 'row between mb-16' }, [
      q('div', { class: 't-2', text: '动态' }),
      q('span', { class: 't-xs c-3', text: '来自你关注的人' }),
    ]),
    q('div', { id: 'feedList' }, [q('div', { class: 'skel', style: { height: '120px', borderRadius: '16px' } })]),
  ]));

  let list;
  try {
    list = await api.feed();
  } catch (err) {
    ui.render(document.getElementById('feedList'),
      q('div', { class: 'card card-pad-lg' }, [q('div', { class: 't-sm c-danger', text: err.message })]));
    return;
  }

  const box = document.getElementById('feedList');
  if (!list.list.length) {
    ui.render(box, q('div', { class: 'card card-pad-lg' }, [
      q('div', { class: 'empty' }, [
        q('div', { class: 'empty-art' }, [icon('users', 40)]),
        q('div', { class: 't-3', text: '还没有动态' }),
        q('div', { class: 't-sm c-3', text: '关注一些人，他们的坦白局和回答会出现在这里' }),
        q('button', {
          class: 'btn btn-primary btn-sm mt-12',
          text: '去看看有谁在玩',
          onclick: () => router.navigate('/discover'),
        }),
      ]),
    ]));
    return;
  }

  function feedItem(it) {
    return q('div', {
      class: 'card card-pad card-hover mb-12',
      style: { cursor: 'pointer' },
      onclick: () => router.navigate('/room/' + it.roomId),
    }, [
      q('div', { class: 'row gap-10 mb-10' }, [
        ui.avatar(it.actor.avatar, 'avatar-sm', 'T'),
        q('div', { class: 'flex-1', style: { minWidth: '0' } }, [
          q('div', { class: 'row gap-6 items-start' }, [
            q('span', { class: 't-sm bold', text: it.actor.nickname }),
            q('span', {
              class: 'chip',
              style: { height: '19px', fontSize: '10px' },
              text: it.kind === 'room' ? '发起' : '回答',
            }),
          ]),
          q('div', { class: 't-xs c-3', text: ui.timeAgo(it.createdAt) }),
        ]),
      ]),
      q('div', { class: 't-body', text: String(it.text || '').slice(0, 120) }),
      it.kind === 'room' && it.room
        ? q('div', { class: 'row gap-12 mt-8 t-xs c-3' }, [
            q('span', { text: it.room.counts.questions + ' 个问题' }),
            q('span', { text: it.room.counts.answers + ' 个回答' }),
          ])
        : null,
    ]);
  }

  ui.render(box, q('div', {}, list.list.map(feedItem)));
};

/* ============================================================
   发现页：话题 + 推荐用户
   ============================================================ */

window.viewDiscover = async function viewDiscover(host) {
  const q = ui.el;

  const topicsBox = q('div');
  const usersBox = q('div');
  const plazaBox = q('div');

  ui.render(host, q('div', { class: 'layout-desk' }, [
    q('div', { class: 'col gap-16' }, [
      q('div', { class: 'card card-pad-lg col gap-12' }, [
        q('div', { class: 'row gap-8' }, [icon('tag', 17), q('span', { class: 't-3', text: '热门话题' })]),
        topicsBox,
      ]),
      q('div', { class: 'card card-pad-lg col gap-12' }, [
        q('div', { class: 'row gap-8' }, [icon('star', 17), q('span', { class: 't-3', text: '热门坦白局' })]),
        plazaBox,
      ]),
    ]),
    q('div', { class: 'col gap-16' }, [
      q('div', { class: 'card card-pad-lg col gap-12' }, [
        q('div', { class: 'row gap-8' }, [icon('users', 17), q('span', { class: 't-3', text: '可能感兴趣的人' })]),
        usersBox,
      ]),
    ]),
  ]));

  // 话题
  try {
    const t = await api.topics();
    if (!t.list.length) {
      ui.render(topicsBox, q('div', { class: 't-sm c-3', text: '还没有话题' }));
    } else {
      ui.render(topicsBox, q('div', { class: 'row wrap gap-8' }, t.list.map((x) =>
        q('button', {
          class: 'chip chip-lg',
          text: '#' + x.tag,
          onclick: () => {
            location.hash = '#/home?tag=' + encodeURIComponent(x.tag);
          },
        }, [
          q('span', { text: '#' + x.tag }),
          q('span', { style: { opacity: '.6', marginLeft: '2px' }, text: String(x.total) }),
        ]))));
    }
  } catch (_) {
    ui.render(topicsBox, q('div', { class: 't-sm c-3', text: '加载失败' }));
  }

  // 热门坦白局：让发现页不至于太空
  try {
    const p = await api.plaza();
    const list = (p.hotRooms || []).slice(0, 5);
    if (!list.length) {
      ui.render(plazaBox, q('div', { class: 't-sm c-3', text: '还没有坦白局' }));
    } else {
      ui.render(plazaBox, q('div', { class: 'col gap-8' }, list.map((r) =>
        q('div', {
          class: 'room-card card-hover',
          style: { padding: '13px 14px' },
          onclick: () => router.navigate('/room/' + r.id),
        }, [
          q('div', { class: 'col gap-6 flex-1', style: { minWidth: '0' } }, [
            q('div', { class: 'row between gap-8 items-start' }, [
              q('div', { class: 'room-title flex-1 ellipsis', text: r.title }),
              r.state === 'live'
                ? q('span', { class: 'state-live', text: '进行中' })
                : q('span', { class: 'chip state-done', text: '已结束' }),
            ]),
            q('div', { class: 'row gap-8 items-start' }, [
              ui.avatar(r.avatar, 'avatar-sm', 'T'),
              q('div', { class: 't-xs c-3 ellipsis', text: r.owner.nickname }),
            ]),
            q('div', { class: 'room-stats' }, [
              q('span', {}, [q('b', { text: String(r.counts.questions) }), document.createTextNode(' 问')]),
              q('span', {}, [q('b', { text: String(r.counts.answers) }), document.createTextNode(' 答')]),
              q('span', {}, [q('b', { text: String(r.counts.hearts) }), document.createTextNode(' 心动')]),
            ]),
          ]),
        ]))));
    }
  } catch (_) {
    ui.render(plazaBox, q('div', { class: 't-sm c-3', text: '加载失败' }));
  }

  // 推荐用户
  try {
    const s = await api.suggestions();
    if (!s.list.length) {
      ui.render(usersBox, q('div', { class: 't-sm c-3', text: '暂时没有推荐' }));
      return;
    }
    ui.render(usersBox, q('div', { class: 'col gap-12' }, s.list.map((x) =>
      q('div', { class: 'row gap-12' }, [
        ui.avatar(x.user.avatar, 'avatar-lg', 'T'),
        q('div', {
          class: 'col gap-4 flex-1',
          style: { minWidth: '0', cursor: 'pointer' },
          onclick: () => router.navigate('/user/' + x.user.id),
        }, [
          q('div', { class: 'row gap-6' }, [
            q('span', { class: 't-3', text: x.user.nickname }),
            x.mutual ? q('span', { class: 'chip', style: { height: '18px', fontSize: '10px' }, text: x.mutual + ' 人共同关注' }) : null,
          ]),
          q('div', { class: 't-xs c-3 ellipsis', text: x.user.bio || '这个人很懒，什么都没写' }),
        ]),
        followButton(x.user, { following: false }),
      ]))));
  } catch (_) {
    ui.render(usersBox, q('div', { class: 't-sm c-3', text: '加载失败' }));
  }
};

/* ============================================================
   关系操作面板（关注 / 屏蔽 / 举报）
   ============================================================ */

window.openRelationActions = function openRelationActions(user, relation) {
  const q = ui.el;
  const body = q('div', { class: 'col gap-8' });

  body.appendChild(q('div', { class: 'row center gap-10 mb-8' }, [
    ui.avatar(user.avatar, 'avatar-lg', 'T'),
    q('div', { class: 'col' }, [
      q('div', { class: 't-3', text: user.nickname }),
      relation && relation.followers
        ? q('div', { class: 't-xs c-3', text: relation.followers + ' 人关注' })
        : null,
    ]),
  ]));

  body.appendChild(q('button', {
    class: 'btn ' + (relation && relation.following ? 'btn-soft' : 'btn-primary') + ' btn-block',
    text: relation && relation.following ? '取消关注' : '关注他',
    onclick: async (e) => {
      e.target.classList.add('loading');
      try {
        await api.followUser(user.id);
        ui.toast(relation && relation.following ? '已取消关注' : '关注成功', 'ok');
        document.querySelector('.sheet-mask').remove();
        document.body.style.overflow = '';
      } catch (err) {
        ui.toast(err.message, 'err');
      } finally {
        e.target.classList.remove('loading');
      }
    },
  }));

  body.appendChild(q('button', {
    class: 'btn btn-ghost btn-block',
    text: relation && relation.blocked ? '解除屏蔽' : '屏蔽他',
    onclick: async (e) => {
      e.target.classList.add('loading');
      try {
        const r = await api.blockUser(user.id);
        ui.toast(r.blocked ? '已屏蔽，不再看到他的内容' : '已解除屏蔽', 'ok');
        document.querySelector('.sheet-mask').remove();
        document.body.style.overflow = '';
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        ui.toast(err.message, 'err');
      } finally {
        e.target.classList.remove('loading');
      }
    },
  }));

  if (relation && relation.followsYou) {
    body.appendChild(q('div', { class: 'notice' }, [
      icon('heart', 15),
      q('span', { text: '他也关注了你' }),
    ]));
  }

  ui.sheet({ title: '关系', content: body });
};

/* ============================================================
   关注 / 粉丝 列表
   ============================================================ */

window.viewFollows = async function viewFollows(host) {
  return userListView(host, api.follows, '我关注的人');
};

window.viewFans = async function viewFans(host) {
  return userListView(host, api.fans, '关注我的人');
};

async function userListView(host, fetcher, title) {
  const q = ui.el;
  if (!store.me) {
    ui.render(host, q('div', { class: 'login-wrap' }, [
      q('div', { class: 'login-card col gap-14' }, [
        q('div', { class: 't-2', style: { textAlign: 'center' }, text: '登录后查看' }),
        q('a', { class: 'btn btn-primary btn-block', href: '/login', text: '去登录' }),
      ]),
    ]));
    return;
  }

  ui.render(host, q('div', { style: { maxWidth: '560px', margin: '0 auto' } }, [
    q('div', { class: 'row gap-10 mb-16' }, [
      q('a', { class: 'icon-btn', href: '#/me' }, [icon('back', 18)]),
      q('div', { class: 't-2', text: title }),
    ]),
    q('div', { id: 'userList' }, [q('div', { class: 'skel', style: { height: '90px', borderRadius: '16px' } })]),
  ]));

  try {
    const d = await fetcher(store.me.id);
    const box = document.getElementById('userList');
    if (!d.list.length) {
      ui.render(box, q('div', { class: 'card card-pad-lg' }, [
        q('div', { class: 'empty' }, [
          q('div', { class: 'empty-art' }, [icon('users', 36)]),
          q('div', { class: 't-sm', text: '还没有人' }),
        ]),
      ]));
      return;
    }
    ui.render(box, q('div', { class: 'col gap-10' }, d.list.map((u) =>
      q('div', { class: 'card card-pad row gap-12' }, [
        ui.avatar(u.avatar, 'avatar-lg', 'T'),
        q('div', {
          class: 'col gap-4 flex-1',
          style: { minWidth: '0', cursor: 'pointer' },
          onclick: () => router.navigate('/user/' + u.id),
        }, [
          q('div', { class: 't-3', text: u.nickname }),
          q('div', { class: 't-xs c-3 ellipsis', text: u.bio || '这个人很懒，什么都没写' }),
        ]),
        q('button', {
          class: 'icon-btn',
          onclick: (e) => { e.stopPropagation(); openRelationActions(u, { following: false }); },
        }, [icon('dots', 18)]),
      ]))));
  } catch (err) {
    ui.toast(err.message, 'err');
  }
}

/* ============================================================
   我的坦白局列表
   ============================================================ */

window.viewRooms = async function viewRooms(host) {
  const q = ui.el;
  if (!store.me) {
    ui.render(host, q('div', { class: 'login-wrap' }, [
      q('div', { class: 'login-card col gap-14' }, [
        q('div', { class: 't-2', style: { textAlign: 'center' }, text: '登录后查看' }),
        q('a', { class: 'btn btn-primary btn-block', href: '/login', text: '去登录' }),
      ]),
    ]));
    return;
  }

  ui.render(host, q('div', { style: { maxWidth: '620px', margin: '0 auto' } }, [
    q('div', { class: 'row gap-10 mb-16' }, [
      q('a', { class: 'icon-btn', href: '#/me' }, [icon('back', 18)]),
      q('div', { class: 't-2 flex-1', text: '我的坦白局' }),
      q('a', { class: 'btn btn-primary btn-sm', href: '#/create', text: '新建' }),
    ]),
    q('div', { id: 'roomList' }, [q('div', { class: 'skel', style: { height: '90px', borderRadius: '16px' } })]),
  ]));

  try {
    const all = await api.rooms();
    const mine = all.list.filter((r) => store.me && r.ownerId === store.me.id);
    const box = document.getElementById('roomList');
    if (!mine.length) {
      ui.render(box, q('div', { class: 'card card-pad-lg' }, [
        q('div', { class: 'empty' }, [
          q('div', { class: 'empty-art' }, [icon('plus', 36)]),
          q('div', { class: 't-sm', text: '还没创建过坦白局' }),
          q('a', { class: 'btn btn-primary btn-sm mt-8', href: '#/create', text: '创建第一个' }),
        ]),
      ]));
      return;
    }
    ui.render(box, q('div', { class: 'col gap-10' }, mine.map((r) =>
      q('div', {
        class: 'card card-pad card-hover',
        style: { cursor: 'pointer' },
        onclick: () => router.navigate('/room/' + r.id),
      }, [
        q('div', { class: 'row between gap-8 items-start' }, [
          q('div', { class: 'room-title flex-1', text: r.title }),
          r.state === 'live'
            ? q('span', { class: 'state-live', text: '进行中' })
            : q('span', { class: 'chip state-done', text: '已结束' }),
        ]),
        q('div', { class: 'room-stats mt-8' }, [
          q('span', {}, [q('b', { text: String(r.counts.questions) }), document.createTextNode(' 问')]),
          q('span', {}, [q('b', { text: String(r.counts.answers) }), document.createTextNode(' 答')]),
          q('span', {}, [q('b', { text: String(r.counts.pending) }), document.createTextNode(' 待答')]),
          q('span', {}, [q('b', { text: String(r.counts.visits) }), document.createTextNode(' 来过')]),
        ]),
      ]))));
  } catch (err) {
    ui.toast(err.message, 'err');
  }
};

/* ============================================================
   他人主页
   ============================================================ */

window.viewUser = async function viewUser(host, params) {
  const q = ui.el;

  ui.render(host, q('div', { class: 'skel', style: { height: '180px', borderRadius: '16px' } }));

  let d;
  try {
    d = await api.user(params.id);
  } catch (err) {
    ui.render(host, q('div', { class: 'empty' }, [
      q('div', { class: 'empty-art', text: '!' }),
      q('div', { text: err.message }),
      q('a', { class: 'btn btn-ghost btn-sm', href: '#/home', text: '回到广场' }),
    ]));
    return;
  }

  const isMe = store.me && store.me.id === d.user.id;

  const profile = q('div', { class: 'card card-pad-lg col gap-14' }, [
    q('div', { class: 'row gap-10 items-start' }, [
      q('a', { class: 'icon-btn', href: '#/home' }, [icon('back', 18)]),
      q('div', { class: 'flex-1' }),
      isMe ? null : q('button', {
        class: 'icon-btn',
        onclick: () => openRelationActions(d.user, d.relation),
      }, [icon('dots', 18)]),
    ]),
    q('div', { class: 'row gap-14' }, [
      ui.avatar(d.user.avatar, 'avatar-2x', 'T'),
      q('div', { class: 'col gap-6 flex-1' }, [
        q('div', { class: 'row gap-6 items-start' }, [
          q('div', { class: 't-2', text: d.user.nickname }),
          d.relation && d.relation.following ? q('span', { class: 'chip chip-on', text: '已关注' }) : null,
          d.relation && d.relation.friend ? q('span', { class: 'chip chip-on', text: '互关' }) : null,
        ]),
        q('div', { class: 't-sm c-3', text: d.user.bio || '这个人很懒，什么都没写' }),
        q('div', { class: 't-xs c-3', text: '加入于 ' + new Date(d.user.createdAt).toLocaleDateString('zh-CN') }),
      ]),
    ]),
    q('div', { class: 'stat-grid' }, [
      { n: d.rooms.length, l: '发起' },
      { n: d.posts.length, l: '提问' },
      { n: (d.relation && d.relation.followers) || 0, l: '粉丝' },
      { n: d.hearts, l: '心动' },
    ].map((it) => q('div', { class: 'stat-box' }, [
      q('div', { class: 'stat-num c-brand tnum', text: ui.fmtCount(it.n) }),
      q('div', { class: 'stat-label', text: it.l }),
    ]))),
    isMe ? null : q('div', { class: 'row gap-8' }, [
      followButton(d.user, d.relation),
      q('button', {
        class: 'btn btn-ghost',
        text: '关系设置',
        onclick: () => openRelationActions(d.user, d.relation),
      }),
    ]),
  ]);

  const sections = [];
  if (d.rooms.length) {
    sections.push(q('div', { class: 'col gap-10' }, [
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
    ]));
  }
  if (d.posts.length) {
    sections.push(q('div', { class: 'col gap-10' }, [
      q('div', { class: 't-3', text: 'TA 问过的问题' }),
      q('div', { class: 'card card-pad col gap-8' }, d.posts.slice(0, 20).map((p) =>
        q('div', {
          class: 't-sm',
          style: { padding: '9px 0', borderBottom: '1px solid var(--line)', cursor: 'pointer' },
          onclick: () => router.navigate('/room/' + p.roomId),
          text: p.text,
        }))),
    ]));
  }

  ui.render(host, q('div', { class: 'layout-desk' }, [
    q('div', { class: 'col gap-16' }, [profile].concat(sections)),
    q('div', { class: 'side' }, [
      q('div', { class: 'card card-pad-lg col gap-10' }, [
        q('div', { class: 't-3', text: '关系' }),
        relRow('关注我的人', (d.relation && d.relation.followers) || 0),
        relRow('我关注的人', (d.relation && d.relation.followingCount) || 0),
        relRow('TA 收藏的内容', d.favorites || 0),
      ]),
      q('button', {
        class: 'btn btn-soft btn-block',
        text: '去发现更多人',
        onclick: () => router.navigate('/discover'),
      }),
    ]),
  ]));
};

/* ============================================================
   收藏夹视图
   ============================================================ */

window.viewFavorites = async function viewFavorites(host) {
  const q = ui.el;

  if (!store.me) {
    ui.render(host, q('div', { class: 'login-wrap' }, [
      q('div', { class: 'login-card col gap-14' }, [
        q('div', { class: 't-2', style: { textAlign: 'center' }, text: '登录后查看收藏' }),
        q('a', { class: 'btn btn-primary btn-block', href: '/login', text: '去登录' }),
      ]),
    ]));
    return;
  }

  ui.render(host, q('div', { style: { maxWidth: '620px', margin: '0 auto' } }, [
    q('div', { class: 'row between mb-16' }, [
      q('div', { class: 't-2', text: '我的收藏' }),
    ]),
    q('div', { id: 'favList' }, [q('div', { class: 'skel', style: { height: '120px', borderRadius: '16px' } })]),
  ]));

  try {
    const d = await api.myFavorites();
    const box = document.getElementById('favList');
    if (!d.list.length) {
      ui.render(box, q('div', { class: 'card card-pad-lg' }, [
        q('div', { class: 'empty' }, [
          q('div', { class: 'empty-art' }, [icon('heart', 36)]),
          q('div', { class: 't-sm', text: '还没有收藏任何内容' }),
        ]),
      ]));
      return;
    }
    ui.render(box, q('div', { class: 'col gap-10' }, d.list.map((x) =>
      q('div', {
        class: 'card card-pad card-hover',
        style: { cursor: 'pointer' },
        onclick: () => router.navigate('/room/' + x.post.roomId),
      }, [
        q('div', { class: 't-body', text: x.post.text }),
        q('div', { class: 'row gap-10 mt-8 t-xs c-3' }, [
          q('span', { text: ui.timeAgo(x.post.createdAt) }),
          q('span', { text: x.post.hearts + ' 心动' }),
        ]),
      ]))));
  } catch (err) {
    ui.toast(err.message, 'err');
  }
};