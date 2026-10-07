/**
 * 哈希路由。
 *
 * 设计要点：路由表从全局视图函数自动构建，而不是依赖手写注册。
 * 早期版本依赖各处调用 router.register()，一旦漏掉注册，
 * 路由表为空、页面直接崩成白屏 —— 而单元测试直接调视图函数，
 * 刚好绕过了这条路径，形成「测试全绿但网站打不开」的假象。
 * 现在改为：脚本加载完自动扫描 window.view* 并登记，
 * 既保留手动 register 的扩展能力，又不可能漏注册。
 */

const routes = Object.create(null);
let currentCleanup = null;
let booted = false;

/** 手动注册（扩展点：非 window.view* 命名的视图可在此登记） */
function register(name, view) {
  if (typeof view !== 'function') {
    console.error('[router] 视图必须是函数: ' + name);
    return false;
  }
  routes[name] = view;
  return true;
}

/**
 * 自动发现：把所有全局 viewXxx 函数按名称登记。
 * viewHome -> home, viewRoom -> room, viewMeWithId -> meWithId
 */
function autodiscover(scope) {
  const root = scope || window;
  const found = [];
  Object.keys(root).forEach((key) => {
    if (key.indexOf('view') !== 0) return;
    if (typeof root[key] !== 'function') return;
    const name = key.slice(4).charAt(0).toLowerCase() + key.slice(5);
    if (!routes[name]) {
      routes[name] = root[key];
      found.push(name);
    }
  });
  return found;
}

function parseHash() {
  const raw = (location.hash || '#/').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  return {
    name: parts[0] || 'home',
    params: { id: parts[1] || '', sub: parts[2] || '' },
  };
}

/** 别名：让部分路径复用同一视图 */
const ALIASES = {
  index: 'home',
  plaza: 'home',
  user: 'me',
  room: 'room',
  notification: 'messages',
  msg: 'messages',
  detail: 'room',
};

function navigate(path) {
  const target = path.startsWith('#') ? path : '#/' + path.replace(/^\/+/, '');
  if (location.hash === target) {
    handleRoute();
    return;
  }
  location.hash = target;
}

async function handleRoute() {
  const route = parseHash();
  const key = ALIASES[route.name] || route.name;
  const view = routes[key] || routes.home;

  // 上一个视图的定时器与监听要清理，否则叠加泄漏
  if (typeof currentCleanup === 'function') {
    try {
      currentCleanup();
    } catch (err) {
      console.warn('[router] cleanup 出错', err);
    }
  }
  currentCleanup = null;

  store.route = route;

  const host = document.getElementById('view');
  if (!host) {
    console.error('[router] 缺少 #view 容器');
    return;
  }

  renderShell(host, route.name);
  try {
    window.scrollTo(0, 0);
  } catch (_) { /* 某些环境无 scrollTo */ }

  if (typeof view !== 'function') {
    host.innerHTML =
      '<div class="empty"><div class="empty-art">!</div>' +
      '<p>页面 ' + ui.esc(route.name) + ' 尚未实现</p>' +
      '<button class="btn btn-ghost btn-sm" onclick="location.hash=\'#/home\'">回到广场</button></div>';
    return;
  }

  ui.render(host, ui.el('div', { class: 'view-loading' }, [
    ui.el('div', { class: 'skel', style: { height: '140px', borderRadius: '22px' } }),
    ui.el('div', { class: 'skel', style: { height: '260px', borderRadius: '16px' } }),
  ]));

  try {
    const result = await view(host, route.params);
    if (typeof result === 'function') currentCleanup = result;
  } catch (err) {
    console.error('[route:' + route.name + ']', err);
    ui.render(host, [
      ui.el('div', { class: 'empty' }, [
        ui.el('div', { class: 'empty-art', text: '!' }),
        ui.el('p', { text: err && err.message ? err.message : '页面出错了' }),
        ui.el('button', {
          class: 'btn btn-ghost btn-sm',
          text: '重新加载',
          onclick: () => location.reload(),
        }),
      ]),
    ]);
  }

  // 导航高亮：首页同时覆盖别名
  const activeName = key === 'home' ? 'home' : route.name;
  document.querySelectorAll('[data-route]').forEach((n) => {
    n.classList.toggle('on', n.getAttribute('data-route') === activeName);
  });
}

/** 更新文档标题，让多标签页切换时也能看出所在页面 */
function renderShell(host, name) {
  const titles = {
    home: '广场', room: '坦白局', create: '发起', me: '我的',
    messages: '通知', login: '登录', plaza: '广场', user: '个人主页',
  };
  document.title = (titles[name] ? titles[name] + ' · ' : '') + '坦白局';
}

function startRouter() {
  if (booted) return;
  const found = autodiscover(window);
  console.log('[router] 已登记视图:', found.join(', ') || '（无）');
  if (!routes.home) {
    console.error('[router] 缺少 home 视图');
  }
  window.addEventListener('hashchange', handleRoute);
  booted = true;
  handleRoute();
}

window.router = {
  register: register,
  navigate: navigate,
  start: startRouter,
  parse: parseHash,
  autodiscover: autodiscover,
  routes: routes,
  // 登录页要把自己摘掉、交还给路由时用
  handleRoute: handleRoute,
  started: () => booted,
};