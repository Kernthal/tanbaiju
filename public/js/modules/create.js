/**
 * 创建坦白局：标题、简介、主题色、标签、规则、时限。
 */

window.viewCreate = async function viewCreate(host) {
  const q = ui.el;

  if (!store.me) {
    ui.render(host, q('div', { class: 'login-wrap' }, [
      q('div', { class: 'login-card col gap-14' }, [
        q('div', { class: 't-2', style: { textAlign: 'center' }, text: '创建坦白局需要登录' }),
        q('div', { class: 't-sm c-3', style: { textAlign: 'center' }, text: '登录后就能创建属于你的坦白局' }),
        q('a', { class: 'btn btn-primary btn-block', href: '/login', text: '去登录' }),
        q('a', { class: 'btn btn-ghost btn-block', href: '#/home', text: '先逛逛' }),
      ]),
    ]));
    return;
  }

  const state = {
    title: '',
    subtitle: '',
    slogan: '今天一人问一个问题，我全部如实回答',
    theme: 'yellow',
    tags: [],
    days: 1,
    rules: { onePerGuest: true, requireLogin: false, allowVoice: true, reviewFirst: false },
  };

  const TAG_PRESETS = ['生活', '情感', '工作', '校园', '未来', '情绪', '成长', '秘密', '梦想', '家人'];

  /* ---- 标题 ---- */
  const titleInput = q('input', {
    class: 'input',
    placeholder: '例如：小满的坦白局',
    maxlength: 30,
    oninput: (e) => { state.title = e.target.value; titleCount.textContent = e.target.value.length + ' / 30'; },
  });
  const titleCount = q('div', { class: 'counter', text: '0 / 30' });

  const subInput = q('input', {
    class: 'input',
    placeholder: '一句话说明这场坦白局聊什么（可选）',
    maxlength: 60,
    oninput: (e) => { state.subtitle = e.target.value; },
  });

  const sloganInput = q('input', {
    class: 'input',
    maxlength: 40,
    oninput: (e) => { state.slogan = e.target.value; },
  });

  /* ---- 主题色 ---- */
  const THEMES = [
    { k: 'yellow', l: '明黄', a: '#ffe066', b: '#fff3bf' },
    { k: 'mint', l: '薄荷', a: '#a8e6cf', b: '#d8f3ec' },
    { k: 'lilac', l: '丁香', a: '#c7b9ff', b: '#e6e1ff' },
    { k: 'sky', l: '天蓝', a: '#a6d8ff', b: '#dcefff' },
    { k: 'peach', l: '蜜桃', a: '#ffc4a3', b: '#ffe6d6' },
  ];

  const themeRow = q('div', { class: 'row wrap gap-8' });
  THEMES.forEach((t) => {
    const btn = q('button', {
      class: 'chip chip-lg ' + (state.theme === t.k ? 'chip-on' : ''),
      onclick: () => {
        state.theme = t.k;
        themeRow.querySelectorAll('.chip').forEach((c) => c.classList.remove('chip-on'));
        btn.classList.add('chip-on');
        preview();
      },
    }, [
      q('span', {
        style: {
          width: '13px', height: '13px', borderRadius: '4px',
          background: 'linear-gradient(135deg,' + t.a + ',' + t.b + ')',
          display: 'inline-block',
        },
      }),
      document.createTextNode(t.l),
    ]);
    themeRow.appendChild(btn);
  });

  /* ---- 标签 ---- */
  const tagRow = q('div', { class: 'row wrap gap-8' });
  TAG_PRESETS.forEach((t) => {
    const btn = q('button', {
      class: 'chip chip-lg',
      text: '#' + t,
      onclick: () => {
        const i = state.tags.indexOf(t);
        if (i === -1) {
          if (state.tags.length >= 4) return ui.toast('最多选 4 个标签', 'err');
          state.tags.push(t);
        } else {
          state.tags.splice(i, 1);
        }
        btn.classList.toggle('chip-on');
      },
    });
    tagRow.appendChild(btn);
  });

  /* ---- 时限 ---- */
  const DAYS = [
    { v: 1, l: '今天（24 小时）' },
    { v: 3, l: '3 天' },
    { v: 7, l: '7 天' },
    { v: 30, l: '30 天' },
  ];
  const daySeg = q('div', { class: 'segment', style: { display: 'flex', width: '100%' } });
  DAYS.forEach((d) => {
    daySeg.appendChild(q('button', {
      class: state.days === d.v ? 'on' : '',
      text: d.l,
      style: { flex: '1' },
      onclick: () => {
        state.days = d.v;
        daySeg.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
        daySeg.querySelectorAll('button')[DAYS.indexOf(d)].classList.add('on');
      },
    }));
  });

  /* ---- 规则开关 ---- */
  const RULE_DEFS = [
    { k: 'onePerGuest', l: '每人只能问一个问题', d: '经典玩法，聚焦真实答案' },
    { k: 'requireLogin', l: '提问需要登录', d: '开启后仅登录用户可提问' },
    { k: 'allowVoice', l: '允许语音回答', d: '你可以用语音回答问题' },
    { k: 'reviewFirst', l: '提问需先审核', d: '适合内容较私密的场次' },
  ];

  const ruleRows = RULE_DEFS.map((r) => {
    const sw = q('div', { class: 'switch' + (state.rules[r.k] ? ' on' : '') });
    const row = q('label', {
      class: 'checkrow',
      onclick: () => {
        state.rules[r.k] = !state.rules[r.k];
        sw.classList.toggle('on', state.rules[r.k]);
      },
    }, [
      q('div', { class: 'flex-1' }, [
        q('div', { class: 't-body', text: r.l }),
        q('div', { class: 't-xs c-3', text: r.d }),
      ]),
      sw,
    ]);
    return row;
  });

  /* ---- 预览 ---- */
  const previewHost = q('div');

  function preview() {
    const t = THEMES.find((x) => x.k === state.theme);
    ui.render(previewHost, q('div', {
      class: 'room-hero ' + state.theme,
      style: {
        backgroundImage: 'linear-gradient(135deg,' + t.a + ',' + t.b + ')',
        padding: '20px 18px',
      },
    }, [
      q('div', { class: 'row gap-10 mb-12' }, [
        ui.avatar(store.me.avatar, '', store.me.nickname.slice(0, 1)),
        q('div', { class: 't-2', text: store.me.nickname }),
      ]),
      q('div', {
        class: 'room-hero-title',
        style: { fontSize: '19px' },
        text: titleInput.value.trim() || '你的坦白局标题',
      }),
      q('div', { style: { fontSize: '12.5px', color: '#4a4f55', marginTop: '8px', fontWeight: '600' }, text: sloganInput.value || state.slogan }),
      state.tags.length ? q('div', { class: 'row wrap gap-6 mt-10' }, state.tags.map((x) =>
        q('span', { class: 'chip chip-line', style: { background: 'rgba(255,255,255,.55)', color: '#17191c' }, text: '#' + x }))) : null,
    ]));
  }
  titleInput.addEventListener('input', preview);
  sloganInput.addEventListener('input', preview);

  /* ---- 提交 ---- */
  const submit = q('button', { class: 'btn btn-primary btn-lg btn-block', text: '创建坦白局' });
  submit.onclick = async () => {
    if (state.title.trim().length < 2) {
      titleInput.classList.add('bad');
      titleInput.focus();
      setTimeout(() => titleInput.classList.remove('bad'), 1200);
      return ui.toast('给这场坦白局起个名字吧', 'err');
    }
    submit.classList.add('loading');
    try {
      const room = await api.createRoom({
        title: state.title.trim(),
        subtitle: state.subtitle.trim(),
        slogan: state.slogan,
        theme: state.theme,
        tags: state.tags,
        days: state.days,
        rules: state.rules,
      });
      ui.toast('创建成功', 'ok');
      router.navigate('/room/' + room.id);
    } catch (err) {
      ui.toast(err.message, 'err');
      submit.classList.remove('loading');
    }
  };

  ui.render(host, q('div', { class: 'layout-desk' }, [
    q('div', { class: 'col gap-16', style: { maxWidth: '680px' } }, [
      q('div', { class: 'card card-pad-lg col gap-16' }, [
        q('div', { class: 't-2', text: '创建你的坦白局' }),
        q('div', { class: 'field' }, [
          q('div', { class: 'field-label', text: '标题' }),
          titleInput,
          titleCount,
        ]),
        q('div', { class: 'field' }, [
          q('div', { class: 'field-label', text: '简介' }),
          subInput,
        ]),
        q('div', { class: 'field' }, [
          q('div', { class: 'field-label', text: '海报上的那句话' }),
          sloganInput,
        ]),
      ]),

      q('div', { class: 'card card-pad-lg col gap-14' }, [
        q('div', { class: 't-3', text: '配色' }),
        themeRow,
      ]),

      q('div', { class: 'card card-pad-lg col gap-12' }, [
        q('div', { class: 't-3', text: '标签' }),
        q('div', { class: 't-xs c-3', text: '最多 4 个，帮别人更快找到你' }),
        tagRow,
      ]),

      q('div', { class: 'card card-pad-lg col gap-12' }, [
        q('div', { class: 't-3', text: '开放时限' }),
        daySeg,
      ]),

      q('div', { class: 'card card-pad-lg col gap-4' }, [
        q('div', { class: 't-3 mb-8', text: '规则' }),
      ].concat(ruleRows)),

      submit,
    ]),

    q('div', { class: 'side' }, [
      q('div', { class: 'col gap-10' }, [
        q('div', { class: 't-sm c-3', text: '实时预览' }),
        previewHost,
      ]),
    ]),
  ]));

  preview();
};