/**
 * 启动引导：恢复主题、恢复登录态、注册路由、拉起未读数。
 */

(function boot() {
  const q = ui.el;

  // 主题
  store.setTheme(store.theme);

  // 注入图标：HTML 里用 data-ico 声明，这里统一填入手绘图
  document.querySelectorAll('[data-ico]').forEach((node) => {
    const size = node.classList.contains('tab-fab') ? 21 : 20;
    node.appendChild(hicon(node.dataset.ico, size));
  });
  document.getElementById('searchBtn').appendChild(hicon('search', 18));
  document.getElementById('bellIcon').appendChild(hicon('bell', 18));
  const bm = document.getElementById('brandMark');
  if (bm) bm.appendChild(hicon('sparkle', 18));

  /**
   * 登录页走 hash 路由（#/login、#/ticket?t=xxx），不用独立 HTML 路径。
   *
   * 原因：站点部署在子路径（GitHub Pages 的 /tanbaiju/）时，
   * 任何 '/login' 形式的绝对路径都会跳到域名根目录去，结果是 404。
   * hash 路由不受路径深度影响，本地与线上行为一致。
   */
  function isLoginRoute() {
    return (location.hash || '').indexOf('#/login') === 0 ||
           (location.hash || '').indexOf('#/ticket') === 0;
  }

  if (isLoginRoute()) {
    // 只摘掉顶栏与底部 tabbar —— 不能删整个 .app，
    // 因为 #view（页面挂载点）就在 .app 里面，删了就没有容器可渲染。
    const topbar = document.querySelector('.topbar');
    if (topbar) topbar.remove();
    const tabbar = document.querySelector('.tabbar');
    if (tabbar) tabbar.remove();

    const host = document.getElementById('view');
    if ((location.hash || '').indexOf('#/ticket') === 0) {
      viewTicket(host);
    } else {
      viewLogin(host);
    }
    store.afterLogin = store.afterLogin || 'home';
    return;
  }

  // 静态部署且无后端时，先灌入演示数据，避免首屏空荡荡。
  // 用 then 链而非 async/await，因为 boot 是同步 IIFE。
  const backendPromise = window.Data
    ? window.Data.resolveBackend().catch(() => 'server')
    : Promise.resolve('server');

  backendPromise
    .then(function (backend) {
      if (backend !== 'local' || !window.LocalData || !window.LocalData.seedIfEmpty) return;
      return window.LocalData.seedIfEmpty();
    })
    .catch(function (err) {
      console.warn('[boot] 演示数据初始化失败', err);
    })
    .then(function () {
      return api.me()
        .then(function (user) {
          store.setMe(user);
          paintUser();
          refreshUnread();
        })
        .catch(function () {
          // 未登录，用访客身份静默建一个，保证提问等功能可用
          return api.guest()
            .then(function (r) {
              store.setMe(r.user);
              paintUser();
            })
            .catch(function () { /* 保持未登录 */ });
        });
    });

  function paintUser() {
    const chipAvatar = document.getElementById('userAvatar');
    const chipName = document.getElementById('userName');
    if (!chipAvatar || !store.me) return;
    chipAvatar.innerHTML = '';
    chipAvatar.appendChild(ui.avatar(store.me.avatar, 'avatar-sm', 'T'));
    chipName.textContent = store.me.nickname;
  }

  async function refreshUnread() {
    if (!store.me) return;
    try {
      const d = await api.messages();
      store.unread = d.unread;
      ['unreadBadge', 'unreadBadgeM'].forEach((id) => {
        const node = document.getElementById(id);
        if (!node) return;
        node.textContent = d.unread > 99 ? '99+' : String(d.unread);
        node.classList.toggle('hidden', d.unread === 0);
      });
    } catch (_) { /* ignore */ }
  }

  window.addEventListener('store:me', paintUser);
  setInterval(refreshUnread, 30000);

  // 搜索
  document.getElementById('searchBtn').onclick = openSearch;

  function openSearch() {
    const input = q('input', { class: 'input', placeholder: '搜坦白局、问题、回答…' });
    const results = q('div', { class: 'col gap-8 mt-12' });

    const panel = q('div', { class: 'col gap-10' }, [
      input,
      results,
    ]);

    const timer = ui.debounce(async () => {
      const kw = input.value.trim();
      if (!kw) {
        ui.render(results, q('div', { class: 't-sm c-3', text: '输入关键词开始搜索' }));
        return;
      }
      try {
        const [rooms, plaza] = await Promise.all([api.rooms(), api.plaza()]);
        const lower = kw.toLowerCase();

        const matchedRooms = rooms.list.filter((r) =>
          r.title.toLowerCase().includes(lower) ||
          r.subtitle.toLowerCase().includes(lower) ||
          (r.tags || []).some((t) => t.toLowerCase().includes(lower)) ||
          r.owner.nickname.toLowerCase().includes(lower)
        );

        const matchedPosts = (plaza.hotPosts || []).filter((p) =>
          p.text && p.text.toLowerCase().includes(lower)
        );

        const nodes = [];
        if (matchedRooms.length) {
          nodes.push(q('div', { class: 't-xs c-3 mt-4', text: '坦白局 · ' + matchedRooms.length }));
          matchedRooms.slice(0, 6).forEach((r) => {
            nodes.push(q('div', {
              class: 'card card-pad card-hover',
              style: { cursor: 'pointer' },
              onclick: () => { document.querySelector('.sheet-mask').remove(); document.body.style.overflow = ''; router.navigate('/room/' + r.id); },
            }, [
              q('div', { class: 'room-title', text: r.title }),
              q('div', { class: 't-xs c-3 mt-4', text: r.owner.nickname + ' · ' + r.counts.questions + ' 个问题' }),
            ]));
          });
        }
        if (matchedPosts.length) {
          nodes.push(q('div', { class: 't-xs c-3 mt-4', text: '内容 · ' + matchedPosts.length }));
          matchedPosts.slice(0, 8).forEach((p) => {
            nodes.push(q('div', {
              class: 'card card-pad',
              style: { cursor: 'pointer' },
              onclick: () => { document.querySelector('.sheet-mask').remove(); document.body.style.overflow = ''; router.navigate('/room/' + p.roomId); },
            }, [q('div', { class: 't-sm', text: p.text })]));
          });
        }
        ui.render(results, nodes.length
          ? nodes
          : q('div', { class: 'empty', style: { padding: '30px 10px' } }, [
              q('div', { class: 'empty-art', text: '?' }),
              q('div', { class: 't-sm', text: '没有找到相关内容' }),
            ]));
      } catch (err) {
        ui.render(results, q('div', { class: 't-sm c-danger', text: err.message }));
      }
    }, 260);

    input.oninput = timer;
    ui.sheet({ title: '搜索', content: panel });
    setTimeout(() => input.focus(), 100);
  }

  ui.bindRipple(document.body);
  router.start();
})();