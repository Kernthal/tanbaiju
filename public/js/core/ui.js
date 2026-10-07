/**
 * UI 工具箱：DOM 构造、提示、弹窗、抽屉、节流防抖、时间格式化。
 * 刻意保持无框架，便于后续往里塞更多模块。
 */

/* ---------- DOM ---------- */

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach((k) => {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : v);
    });
  }
  (Array.isArray(children) ? children : children === undefined || children === null ? [] : [children])
    .forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  return node;
}

/** 清空并填入 */
function render(host, children) {
  host.innerHTML = '';
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    host.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return host;
}

function esc(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- 轻提示 ---------- */

let toastHost = null;
function toast(message, kind, duration) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host' });
    document.body.appendChild(toastHost);
  }
  const icons = { ok: '✓', err: '!', '': '' };
  const node = el('div', { class: 'toast ' + (kind || ''), html: icons[kind] ? '<b>' + icons[kind] + '</b>' : '' }, [
    document.createTextNode(message),
  ]);
  toastHost.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  }, duration || 2200);
  return node;
}

/* ---------- 确认 / 提示 对话框 ---------- */

function dialog(opts) {
  return new Promise((resolve) => {
    const mask = el('div', { class: 'mask' });
    const buttons = [];
    const dlg = el('div', { class: 'dialog' }, [
      el('div', { class: 'dialog-body' }, [
        opts.icon ? el('div', { class: 't-1 mb-8', text: opts.icon }) : null,
        el('div', { class: 'dialog-title', text: opts.title || '' }),
        opts.text ? el('div', { class: 'dialog-text', html: opts.text }) : null,
      ]),
    ]);

    const foot = el('div', { class: 'dialog-foot' });
    (opts.buttons || [{ label: '好的', value: true }]).forEach((b) => {
      buttons.push(el('button', {
        class: b.kind || '',
        text: b.label,
        onclick: () => {
          mask.remove();
          resolve(b.value);
        },
      }));
    });
    buttons.forEach((b) => foot.appendChild(b));
    dlg.appendChild(foot);
    mask.appendChild(dlg);
    mask.addEventListener('click', (e) => {
      if (e.target === mask && opts.maskClose !== false) {
        mask.remove();
        resolve(null);
      }
    });
    document.body.appendChild(mask);
  });
}

function confirmBox(message, opts) {
  return dialog({
    title: (opts && opts.title) || '确认操作',
    text: message,
    buttons: [
      { label: (opts && opts.cancelText) || '取消', value: false },
      { label: (opts && opts.okText) || '确定', value: true, kind: (opts && opts.danger) ? 'danger' : 'primary' },
    ],
  });
}

function alertBox(title, text) {
  return dialog({ title: title, text: text, buttons: [{ label: '知道了', value: true, kind: 'primary' }] });
}

/* ---------- 底部抽屉 ---------- */

function sheet(opts) {
  const mask = el('div', { class: 'sheet-mask' });
  const body = el('div', { class: 'sheet-body' });
  const panel = el('div', { class: 'sheet' }, [
    el('div', { class: 'sheet-grab' }),
    el('div', { class: 'sheet-head' }, [
      el('div', { class: 'sheet-title', text: opts.title || '' }),
      el('button', {
        class: 'icon-btn',
        'aria-label': '关闭',
        onclick: () => close(null),
      }, [icon('close', 16)]),
    ]),
    body,
  ]);

  if (opts.content) body.appendChild(opts.content);
  if (opts.footer) {
    panel.appendChild(el('div', { class: 'sheet-foot' }, opts.footer));
  }

  function close(value) {
    mask.remove();
    document.body.style.overflow = '';
    resolve(value);
  }

  let resolve;
  const p = new Promise((r) => { resolve = r; });

  mask.addEventListener('click', (e) => {
    if (e.target === mask) close(null);
  });
  mask.appendChild(panel);
  document.body.appendChild(mask);
  document.body.style.overflow = 'hidden';
  if (opts.onMount) opts.onMount(body, close);
  return p;
}

/* ---------- 按钮涟漪 ---------- */

function bindRipple(root) {
  root.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest ? e.target.closest('.btn') : null;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    const dot = el('span', {
      class: 'ripple',
      style: {
        width: size + 'px', height: size + 'px',
        left: e.clientX - r.left - size / 2 + 'px',
        top: e.clientY - r.top - size / 2 + 'px',
      },
    });
    btn.appendChild(dot);
    setTimeout(() => dot.remove(), 640);
  });
}

/* ---------- 时间格式化 ---------- */

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + ' 小时前';
  const day = Math.floor(hour / 24);
  if (day < 30) return day + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN');
}

function countdownParts(deadline) {
  const left = Math.max(0, deadline - Date.now());
  return {
    left: left,
    d: Math.floor(left / 86400000),
    h: Math.floor(left / 3600000) % 24,
    m: Math.floor(left / 60000) % 60,
    s: Math.floor(left / 1000) % 60,
  };
}

function fmtCount(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + 'k';
  return (n / 10000).toFixed(1) + 'w';
}

/* ---------- 节流 / 防抖 ---------- */

function throttle(fn, wait) {
  let last = 0;
  let timer = null;
  return function () {
    const now = Date.now();
    const args = arguments;
    const self = this;
    if (now - last >= (wait || 200)) {
      last = now;
      fn.apply(self, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn.apply(self, args);
      }, wait - (now - last));
    }
  };
}

function debounce(fn, wait) {
  let timer = null;
  return function () {
    const args = arguments;
    const self = this;
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(self, args), wait || 300);
  };
}

/* ---------- 头像 ---------- */

function avatarNode(avatar, sizeClass, fallbackText) {
  if (avatar && avatar.image) {
    return el('div', { class: 'avatar ' + (sizeClass || '') }, [
      el('img', { src: avatar.image, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' } }),
    ]);
  }
  const hue = avatar && typeof avatar.hue === 'number' ? avatar.hue : 210;
  const text = (avatar && avatar.text) || fallbackText || '匿';
  return el('div', {
    class: 'avatar avatar-ring ' + (sizeClass || ''),
    style: { '--h': hue },
    text: text,
  });
}

/** 匿名：虚线灰圈，不暴露身份 */
function anonAvatar(sizeClass) {
  return el('div', {
    class: 'avatar avatar-anon ' + (sizeClass || ''),
  }, [icon('user', 18)]);
}

window.ui = {
  el: el, render: render, esc: esc, toast: toast, dialog: dialog,
  confirm: confirmBox, alert: alertBox, sheet: sheet, bindRipple: bindRipple,
  timeAgo: timeAgo, countdownParts: countdownParts, fmtCount: fmtCount,
  throttle: throttle, debounce: debounce, avatar: avatarNode, anonAvatar: anonAvatar,
};