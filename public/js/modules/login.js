/**
 * 登录。三条通道，全部零资质可用：
 *   1. 扫码登录 —— 二维码内是本站一次性票据，微信扫一扫即可
 *   2. 手机验证码
 *   3. 账号密码
 * 外加游客模式与「换一台设备扫码确认」的演示通道。
 *
 * 说明：本项目不走微信开放平台扫码登录，因为那条链路强制要求企业主体
 * 300 元认证 + 域名备案 + 授权回调域。本方案交互形态一致，零资质即可运行。
 */

window.viewLogin = async function viewLogin(host) {
  const q = ui.el;

  let mode = 'qr'; // qr | phone | account
  let pollTimer = null;
  let currentTicket = null;

  const stage = q('div');

  function cleanup() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  /* ---------- 二维码通道 ---------- */

  async function renderQr(box) {
    cleanup();
    const inner = q('div', { class: 'col gap-14 center', style: { alignItems: 'center' } });
    // 只清自己的内容，不能动 box：
    // box 是整块面板，里面还有通道切换的按钮（扫码登录 / 手机号 / 账号），
    // 清空会把它们一起抹掉，导致用户无法切换登录方式。
    inner.innerHTML = '';
    box.appendChild(inner);

    inner.appendChild(q('div', { class: 'auth-head', style: { textAlign: 'center', marginBottom: '2px' } }, [
      q('div', { class: 'auth-title', text: '扫码登录' }),
      q('div', { class: 'auth-sub', text: '用微信或任意扫码 App 扫下方二维码' }),
    ]));

    const qrBox = q('div', { class: 'qr-box' }, [q('div', { class: 't-sm c-3', text: '二维码生成中' })]);
    const status = q('div', { class: 'scan-hint' }, [
      q('div', { class: 'scan-line' }),
      q('div', { class: 'scan-status', text: '正在申请票据…' }),
    ]);
    const refresh = q('button', { class: 'btn btn-ghost btn-sm', text: '刷新二维码' });

    inner.appendChild(qrBox);
    inner.appendChild(status);
    inner.appendChild(refresh);

    try {
      const data = await api.qrTicket();
      currentTicket = data.ticket;
      // 二维码由自研编码器生成（lib/qr.js，前后端同一份实现）
      qrBox.innerHTML = window.QRSvg ? window.QRSvg(data.url || ('#' + data.ticket)) : '';
      const statusText = status.lastChild;
      refresh.onclick = () => renderQr(box);
      statusText.textContent = '等待扫码…';

      // 轮询票据状态
      pollTimer = setInterval(async () => {
        try {
          const r = await api.qrPoll(currentTicket);
          if (r.status === 'confirmed') {
            cleanup();
            statusText.textContent = '登录成功，正在进入…';
            store.setMe(await api.me());
            ui.toast('登录成功', 'ok');
            setTimeout(() => {
              if (window.enterApp) window.enterApp('/home');
              else router.navigate('/home');
            }, 500);
          } else if (r.status === 'expired') {
            cleanup();
            statusText.textContent = '二维码已过期，请刷新';
            refresh.textContent = '点击刷新';
          } else if (r.status === 'invalid') {
            cleanup();
            statusText.textContent = '票据无效，请刷新二维码';
            refresh.textContent = '点击刷新';
          } else if (r.status === 'waiting') {
            statusText.textContent = '已扫描，请在手机上确认';
          }
        } catch (_) { /* 网络抖动忽略，下轮重试 */ }
      }, 1800);
    } catch (err) {
      // 拿不到票据就直说，不要留一个空框让人以为是自己手机的问题
      qrBox.innerHTML = '';
      qrBox.appendChild(q('div', { class: 'qr-failed' }, [
        q('div', { class: 't-sm', style: { color: 'var(--ink-2)' }, text: '扫码登录当前不可用' }),
        q('div', { class: 't-xs c-3 mt-4', style: { padding: '0 10px', lineHeight: '1.7' },
          text: err.message === '接口不存在'
            ? '当前部署环境没有服务端，无法签发票据。可改用手机号或账号登录。'
            : err.message }),
      ]));
      refresh.style.display = 'none';
      status.style.display = 'none';
    }
  }

  /* ---------- 手机号通道 ---------- */

  function renderPhone(box) {
    const phone = q('input', {
      class: 'input', placeholder: '11 位手机号', maxlength: 11, inputmode: 'numeric',
      autocomplete: 'tel',
    });
    const code = q('input', {
      class: 'input', placeholder: '6 位验证码', maxlength: 6, inputmode: 'numeric',
      autocomplete: 'one-time-code',
    });
    const sendBtn = q('button', { class: 'auth-code-btn', text: '获取验证码' });
    const submit = q('button', { class: 'btn btn-primary btn-block btn-lg', text: '登录' });

    sendBtn.onclick = async () => {
      const v = phone.value.trim();
      if (!/^1[3-9]\d{9}$/.test(v)) return ui.toast('请填写 11 位手机号', 'err');
      sendBtn.classList.add('loading');
      try {
        const r = await api.phoneCode(v);
        code.value = r.code;
        ui.toast(r.demo ? '演示模式，验证码已自动填入' : '验证码已发送', 'ok');
      } catch (err) {
        ui.toast(err.message, 'err');
      } finally {
        sendBtn.classList.remove('loading');
      }
    };

    // 回车提交；验证码框回车等同点登录
    [phone, code].forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit.click();
      });
    });

    submit.onclick = async () => {
      const p = phone.value.trim();
      const c = code.value.trim();
      if (!/^1[3-9]\d{9}$/.test(p)) return ui.toast('请填写 11 位手机号', 'err');
      if (!c) return ui.toast('请填写验证码', 'err');

      submit.classList.add('loading');
      try {
        const r = await api.phoneLogin(p, c);
        store.setMe(r.user);
        ui.toast('登录成功', 'ok');
        if (window.enterApp) window.enterApp('/home'); else router.navigate('/home');
      } catch (err) {
        ui.toast(err.message, 'err');
        submit.classList.remove('loading');
      }
    };

    ui.render(box, [
      q('div', { class: 'auth-head' }, [
        q('div', { class: 'auth-title', text: '手机号登录' }),
        q('div', { class: 'auth-sub', text: '未注册的手机号将自动创建账号' }),
      ]),
      q('div', { class: 'auth-fields' }, [
        q('div', { class: 'field' }, [
          q('label', { class: 'field-label', text: '手机号' }),
          phone,
        ]),
        q('div', { class: 'field' }, [
          q('label', { class: 'field-label', text: '验证码' }),
          q('div', { class: 'auth-code-row' }, [code, sendBtn]),
        ]),
      ]),
      submit,
      q('div', { class: 'auth-tip', text: '演示环境不会真的发短信，验证码固定为 8888' }),
    ]);
  }

  /* ---------- 账号通道 ---------- */

  function renderAccount(box) {
    const isRegister = mode === 'register' || mode === 'account';
    const wantRegister = mode === 'register';

    const username = q('input', {
      class: 'input', placeholder: '字母数字下划线，3-20 位',
      autocomplete: 'username', maxlength: 20,
    });
    const password = q('input', {
      class: 'input', type: 'password', placeholder: '至少 6 位',
      autocomplete: wantRegister ? 'new-password' : 'current-password', maxlength: 64,
    });
    const nickname = q('input', {
      class: 'input', placeholder: '别人看到的名字',
      maxlength: 16,
    });

    const submit = q('button', {
      class: 'btn btn-primary btn-block btn-lg',
      text: wantRegister ? '注册并登录' : '登录',
    });

    // 回车即提交，符合表单习惯
    [username, password, nickname].forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit.click();
      });
    });

    submit.onclick = async () => {
      const u = username.value.trim();
      const p = password.value;
      if (!u) return ui.toast('请填写用户名', 'err');
      if (!p) return ui.toast('请填写密码', 'err');
      if (wantRegister && !nickname.value.trim()) return ui.toast('请填一个昵称', 'err');

      submit.classList.add('loading');
      try {
        const r = wantRegister
          ? await api.register(u, p, nickname.value.trim())
          : await api.login(u, p);
        store.setMe(r.user);
        ui.toast(wantRegister ? '注册成功，已自动登录' : '登录成功', 'ok');
        if (window.enterApp) window.enterApp('/home'); else router.navigate('/home');
      } catch (err) {
        ui.toast(err.message, 'err');
        submit.classList.remove('loading');
      }
    };

    ui.render(box, [
      // 标题区：说清这一步在做什么
      q('div', { class: 'auth-head' }, [
        q('div', { class: 'auth-title', text: wantRegister ? '创建你的账号' : '欢迎回来' }),
        q('div', { class: 'auth-sub', text: wantRegister
          ? '起个用户名和昵称，下次直接登录'
          : '登录后可以创建坦白局、收藏问题、收到回答通知' }),
      ]),

      // 凭据区：两个字段一组，用分隔线把「注册才需要」的部分隔开
      q('div', { class: 'auth-fields' }, [
        field('用户名', username),
        field('密码', password),
        wantRegister ? q('div', { class: 'auth-divider' }) : null,
        wantRegister ? field('昵称', nickname, '别人看到的名字，可不填') : null,
      ]),

      submit,

      // 切换入口：做成文字链，视觉权重低于主按钮
      q('button', {
        class: 'auth-switch',
        text: wantRegister ? '已有账号？直接登录' : '还没有账号？去注册',
        onclick: () => {
          mode = wantRegister ? 'account' : 'register';
          renderMain();
        },
      }),
    ]);
  }

  /** 带标签的输入框 */
  function field(label, input, hint) {
    return q('div', { class: 'field' }, [
      q('label', { class: 'field-label', text: label }),
      input,
      hint ? q('div', { class: 'field-hint', text: hint }) : null,
    ]);
  }

  /* ---------- 游客 ---------- */

  async function guestLogin() {
    try {
      const r = await api.guest();
      store.setMe(r.user);
      ui.toast('已以访客身份进入', 'ok');
      if (window.enterApp) window.enterApp('/home'); else router.navigate('/home');
    } catch (err) {
      ui.toast(err.message, 'err');
    }
  }

  /* ---------- 演示：模拟手机扫码确认 ---------- */

  async function simulateScan() {
    if (!currentTicket) return ui.toast('二维码还没准备好', 'err');
    try {
      await api.qrBind(currentTicket, '扫码进来的你');
      ui.toast('已模拟扫码确认', 'ok');
    } catch (err) {
      ui.toast(err.message, 'err');
    }
  }

  /* ---------- 主渲染 ---------- */

  const panel = q('div');

  function renderMain() {
    cleanup();
    const seg = q('div', { class: 'segment mb-20', style: { display: 'flex', width: '100%' } });
    [
      { k: 'qr', label: '扫码登录' },
      { k: 'phone', label: '手机号' },
      { k: 'account', label: '账号' },
    ].forEach((t) => {
      const btn = q('button', {
        class: (mode === t.k || (t.k === 'account' && mode === 'register')) ? 'on' : '',
        text: t.label,
        style: { flex: '1' },
        onclick: () => {
          mode = t.k;
          renderMain();
        },
      });
      seg.appendChild(btn);
    });

    // 通道切换条与通道内容必须分属两个容器。
    // 之前各通道直接往 panel 里 ui.render()，而 ui.render 会先清空容器，
    // 于是每切一次通道就把切换条一起抹掉，用户再也换不回扫码/账号登录。
    panel.innerHTML = '';
    const body = q('div');
    panel.appendChild(seg);
    panel.appendChild(body);

    if (mode === 'qr') renderQr(body);
    else if (mode === 'phone') renderPhone(body);
    else renderAccount(body);

    // 演示辅助区：让没装微信的人也能完整体验扫码链路
    if (mode === 'qr') {
      panel.appendChild(q('div', { class: 'divider-text mt-24 mb-16', text: '没有微信？' }));
      panel.appendChild(q('div', { class: 'notice mb-12' }, [
        q('span', { class: 'notice-icon', text: 'i' }),
        q('span', { html: '用任意扫码 App 打开这个二维码也可以。手机上打开后会自动登录这台电脑。' }),
      ]));
      panel.appendChild(q('div', { class: 'row gap-8' }, [
        q('button', { class: 'btn btn-ghost btn-sm flex-1', text: '模拟扫码确认', onclick: simulateScan }),
        q('button', { class: 'btn btn-ghost btn-sm flex-1', text: '直接以访客进入', onclick: guestLogin }),
      ]));
    }
  }

  renderMain();

  ui.render(host, [
    q('div', { class: 'login-wrap' }, [
      q('div', { class: 'login-card' }, [
        q('div', { class: 'row center gap-10 mb-24' }, [
          q('div', { class: 'brand-mark', style: { width: '38px', height: '38px', fontSize: '19px' }, text: '坦' }),
          q('div', { class: 'col' }, [
            q('div', { style: { fontSize: '18px', fontWeight: '750' }, text: '坦白局' }),
            q('div', { class: 't-xs c-3', text: '今天一人问一个问题' }),
          ]),
        ]),
        panel,
        q('div', { class: 't-xs c-3 mt-24', style: { textAlign: 'center', lineHeight: '1.7' } }, [
          q('div', { text: '登录后可创建自己的坦白局、收藏问题、收到回答通知' }),
        ]),
      ]),
    ]),
  ]);

  return cleanup;
};

/** 票据确认页：手机扫码后打开的就是它 */
window.viewTicket = async function viewTicket(host) {
  const q = ui.el;
  const params = new URLSearchParams(location.search);
  const ticket = params.get('t');

  if (!ticket) {
    ui.render(host, q('div', { class: 'login-wrap' }, [
      q('div', { class: 'login-card col gap-16 center', style: { textAlign: 'center' } }, [
        q('div', { class: 't-2', text: '链接无效' }),
        q('div', { class: 't-sm c-3', text: '这个登录链接已经过期了，请回到电脑端重新生成二维码。' }),
        q('a', { class: 'btn btn-primary', href: '#/login', text: '前往登录页' }),
      ]),
    ]));
    return;
  }

  // 已登录 → 直接确认；未登录 → 先让这位访客登记身份
  const card = q('div', { class: 'login-card col gap-16' }, [
    q('div', { class: 't-2 center', style: { textAlign: 'center' }, text: '确认登录' }),
    q('div', { class: 't-sm c-3', style: { textAlign: 'center' }, text: '正在核对身份…' }),
  ]);
  ui.render(host, q('div', { class: 'login-wrap' }, card));

  const statusText = card.lastChild;

  try {
    if (store.me) {
      await api.qrConfirm(ticket);
      statusText.textContent = '确认成功，可以关掉这个页面了';
      ui.render(card, [
        q('div', { class: 't-2 center', style: { textAlign: 'center' }, text: '确认成功' }),
        q('div', { class: 't-sm c-3', style: { textAlign: 'center' }, text: '电脑端会自动进入，你也可以关掉这个页面了。' }),
        q('button', {
          class: 'btn btn-primary btn-block',
          text: '打开坦白局',
          // 用相对路径跳回站点首页：子路径部署下 '/' 会跳到域名根目录
          onclick: () => { location.href = './'; },
        }),
      ]);
    } else {
      const nicknameInput = q('input', { class: 'input', placeholder: '给自己起个名字（可选）', maxlength: 16 });
      statusText.textContent = '第一次来？留个名字就能确认';
      ui.render(card, [
        q('div', { class: 't-2', style: { textAlign: 'center' }, text: '确认登录' }),
        q('div', { class: 't-sm c-3', style: { textAlign: 'center', lineHeight: '1.7' } },
          ['确认后这台电脑会以你的身份登录。你也可以只作游客身份确认。']),
        nicknameInput,
        q('div', { class: 'row gap-8' }, [
          q('button', {
            class: 'btn btn-primary flex-1',
            text: '确认登录',
            onclick: async (e) => {
              e.target.classList.add('loading');
              try {
                await api.qrBind(ticket, nicknameInput.value.trim() || '扫码访客');
                ui.render(card, [
                  q('div', { class: 't-2', style: { textAlign: 'center' }, text: '确认成功' }),
                  q('div', { class: 't-sm c-3', style: { textAlign: 'center' }, text: '电脑端会自动进入。' }),
                ]);
              } catch (err) {
                ui.toast(err.message, 'err');
                e.target.classList.remove('loading');
              }
            },
          }),
          q('button', { class: 'btn btn-ghost', text: '游客确认', onclick: async () => {
            try {
              await api.qrBind(ticket, '扫码访客');
              ui.render(card, [
                q('div', { class: 't-2', style: { textAlign: 'center' }, text: '确认成功' }),
                q('div', { class: 't-sm c-3', style: { textAlign: 'center' }, text: '电脑端会自动进入。' }),
              ]);
            } catch (err) {
              ui.toast(err.message, 'err');
            }
          } }),
        ]),
      ]);
    }
  } catch (err) {
    statusText.textContent = err.message || '链接已失效';
  }
};