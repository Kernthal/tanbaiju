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
    const inner = q('div', { class: 'col gap-16 center', style: { alignItems: 'center' } });
    // 只清自己的内容，不能动 box：
    // box 是整块面板，里面还有通道切换的按钮（扫码登录 / 手机号 / 账号），
    // 清空会把它们一起抹掉，导致用户无法切换登录方式。
    inner.innerHTML = '';
    box.appendChild(inner);

    inner.appendChild(q('div', { class: 't-2' }, '扫码登录'));
    inner.appendChild(q('div', { class: 't-sm c-3', text: '用微信扫一扫下方二维码' }));

    const qrBox = q('div', { class: 'qr-box' }, [q('div', { class: 't-sm c-3', text: '二维码生成中' })]);
    const status = q('div', { class: 'scan-hint' }, [
      q('div', { class: 'scan-line' }),
      q('div', { text: '等待扫码…' }),
    ]);
    const refresh = q('button', { class: 'btn btn-ghost btn-sm', text: '刷新二维码' });

    inner.appendChild(qrBox);
    inner.appendChild(status);
    inner.appendChild(refresh);

    try {
      const data = await api.qrTicket();
      currentTicket = data.ticket;
      qrBox.innerHTML = data.svg;
      const statusText = status.lastChild;
      refresh.onclick = () => renderQr(box);

      // 轮询票据状态
      pollTimer = setInterval(async () => {
        try {
          const r = await api.qrPoll(currentTicket);
          if (r.status === 'confirmed') {
            cleanup();
            statusText.textContent = '登录成功，正在进入…';
            store.setMe(await api.me());
            ui.toast('登录成功', 'ok');
            setTimeout(() => router.navigate('/home'), 500);
          } else if (r.status === 'expired') {
            cleanup();
            statusText.textContent = r.message;
            refresh.textContent = '点击刷新';
          } else if (r.status === 'waiting') {
            statusText.textContent = '已扫描，请在手机上确认';
          }
        } catch (_) { /* 网络抖动忽略，下轮重试 */ }
      }, 1800);
    } catch (err) {
      qrBox.innerHTML = '';
      qrBox.appendChild(q('div', { class: 't-sm c-danger', text: err.message }));
    }
  }

  /* ---------- 手机号通道 ---------- */

  function renderPhone(box) {
    const phone = q('input', { class: 'input', placeholder: '11 位手机号', maxlength: 11, inputmode: 'numeric' });
    const code = q('input', { class: 'input', placeholder: '验证码', maxlength: 6, inputmode: 'numeric' });
    const sendBtn = q('button', { class: 'btn btn-ghost', text: '获取验证码' });
    const submit = q('button', { class: 'btn btn-primary btn-block btn-lg', text: '登录' });

    code.style.flex = '1';

    sendBtn.onclick = async () => {
      const v = phone.value.trim();
      if (!/^1\d{10}$/.test(v)) return ui.toast('请输入正确的手机号', 'err');
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

    submit.onclick = async () => {
      submit.classList.add('loading');
      try {
        const r = await api.phoneLogin(phone.value.trim(), code.value.trim());
        store.setMe(r.user);
        ui.toast('登录成功', 'ok');
        router.navigate('/home');
      } catch (err) {
        ui.toast(err.message, 'err');
        submit.classList.remove('loading');
      }
    };

    ui.render(box, [
      q('div', { class: 't-2 mb-16', text: '手机号登录' }),
      q('div', { class: 'field mb-12' }, [q('div', { class: 'field-label', text: '手机号' }), phone]),
      q('div', { class: 'field mb-16' }, [q('div', { class: 'field-label', text: '验证码' }),
        q('div', { class: 'row gap-8' }, [code, sendBtn])]),
      submit,
      q('div', { class: 't-xs c-3 mt-12', text: '演示环境不接短信网关，验证码会在获取后自动填入。' }),
    ]);
  }

  /* ---------- 账号通道 ---------- */

  function renderAccount(box) {
    const isRegister = mode === 'account';
    const username = q('input', { class: 'input', placeholder: '用户名（字母数字下划线）' });
    const password = q('input', { class: 'input', type: 'password', placeholder: '密码（至少 6 位）' });
    const nickname = q('input', { class: 'input', placeholder: '昵称（可选）' });
    const submit = q('button', {
      class: 'btn btn-primary btn-block btn-lg',
      text: isRegister ? '注册并登录' : '登录',
    });

    submit.onclick = async () => {
      submit.classList.add('loading');
      try {
        const r = isRegister
          ? await api.register(username.value.trim(), password.value, nickname.value.trim())
          : await api.login(username.value.trim(), password.value);
        store.setMe(r.user);
        ui.toast(isRegister ? '注册成功' : '登录成功', 'ok');
        router.navigate('/home');
      } catch (err) {
        ui.toast(err.message, 'err');
        submit.classList.remove('loading');
      }
    };

    const switcher = q('button', {
      class: 'btn btn-soft btn-block mt-12',
      text: isRegister ? '已有账号？去登录' : '没有账号？去注册',
      onclick: () => {
        mode = isRegister ? 'account' : 'register';
        renderMain();
      },
    });

    ui.render(box, [
      q('div', { class: 't-2 mb-16', text: isRegister ? '注册新账号' : '账号登录' }),
      q('div', { class: 'field mb-12' }, [q('div', { class: 'field-label', text: '用户名' }), username]),
      q('div', { class: 'field mb-12' }, [q('div', { class: 'field-label', text: '密码' }), password]),
      isRegister ? q('div', { class: 'field mb-16' }, [q('div', { class: 'field-label', text: '昵称' }), nickname]) : null,
      submit,
      switcher,
    ]);
  }

  /* ---------- 游客 ---------- */

  async function guestLogin() {
    try {
      const r = await api.guest();
      store.setMe(r.user);
      ui.toast('已以访客身份进入', 'ok');
      router.navigate('/home');
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

    panel.innerHTML = '';
    panel.appendChild(seg);

    if (mode === 'qr') renderQr(panel);
    else if (mode === 'phone') renderPhone(panel);
    else renderAccount(panel);

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