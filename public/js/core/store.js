/**
 * 应用状态：当前用户、路由、缓存。极简发布订阅。
 */

const store = {
  me: null,
  unread: 0,
  online: 0,
  route: { name: 'home', params: {} },
  _subs: {},

  on(evt, fn) {
    (this._subs[evt] = this._subs[evt] || []).push(fn);
    return () => {
      this._subs[evt] = this._subs[evt].filter((f) => f !== fn);
    };
  },

  emit(evt, payload) {
    (this._subs[evt] || []).forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error('[store:' + evt + ']', err);
      }
    });
  },

  setMe(user) {
    this.me = user;
    this.emit('me', user);
  },

  get isLogin() {
    return !!this.me && this.me.identity !== 'guest';
  },

  /** 主题 */
  get theme() {
    try {
      return localStorage.getItem('tb_theme') || 'light';
    } catch (_) {
      return 'light';
    }
  },

  setTheme(name) {
    document.documentElement.setAttribute('data-theme', name === 'light' ? '' : name);
    if (name === 'light') document.documentElement.removeAttribute('data-theme');
    try {
      localStorage.setItem('tb_theme', name);
    } catch (_) { /* ignore */ }
  },
};

window.store = store;