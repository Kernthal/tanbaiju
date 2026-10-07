/**
 * 坦白局详情页：核心问答区。
 * 包含：房间头部、问题气泡墙、提问框、主人回答、追问、精选、互动、访客墙、海报。
 */

window.viewRoom = async function viewRoom(host, params) {
  const q = ui.el;
  let room = null;
  let filter = 'all';
  let posts = [];
  let timer = null;
  let recorder = null;

  const wrap = q('div');
  ui.render(host, wrap);
  ui.render(wrap, q('div', { class: 'col gap-16' }, [
    q('div', { class: 'skel', style: { height: '150px', borderRadius: '22px' } }),
    q('div', { class: 'skel', style: { height: '300px', borderRadius: '16px' } }),
  ]));

  try {
    const data = await api.room(params.id);
    room = data;
    store.setMe(data.visitor);
  } catch (err) {
    ui.render(wrap, q('div', { class: 'empty' }, [
      q('div', { class: 'empty-art', text: '!' }),
      q('div', { text: err.message }),
      q('a', { class: 'btn btn-ghost btn-sm', href: '#/home', text: '回到广场' }),
    ]));
    return;
  }

  const isOwner = store.me && store.me.id === room.owner.id;

  /* ---------- 头部 ---------- */

  function heroNode() {
    const cd = ui.countdownParts(room.deadline);
    const stateNode = room.state === 'live'
      ? q('span', { class: 'state-live', text: '进行中' })
      : q('span', { class: 'chip state-done', text: room.state === 'closed' ? '已关闭' : '已到期' });

    return q('div', { class: 'room-hero ' + (room.theme || 'yellow') }, [
      q('div', { class: 'row between items-start mb-12' }, [
        q('div', { class: 'row gap-10 flex-1' }, [
          ui.avatar(room.avatar, 'avatar-lg', 'T'),
          q('div', { class: 'col gap-4 flex-1' }, [
            q('div', { class: 't-2', text: room.owner.nickname }),
            q('div', { class: 't-sm c-3', text: room.subtitle || room.slogan }),
          ]),
        ]),
        stateNode,
      ]),
      q('div', { class: 'room-hero-title', text: room.title }),
      (room.tags && room.tags.length)
        ? q('div', { class: 'row wrap gap-6 mt-12' }, room.tags.map((t) =>
            q('span', { class: 'chip chip-line', style: { background: 'rgba(255,255,255,.5)', color: '#17191c' }, text: '#' + t })))
        : null,
      q('div', { class: 'row gap-12 mt-16 wrap', style: { fontSize: '12.5px', color: '#3d4349', fontWeight: '600' } }, [
        q('span', { class: 'row gap-4' }, [
          q('span', { text: '距截止 ' }),
          room.state === 'live'
            ? q('span', { class: 'countdown tnum' }, [
                cd.d > 0 ? q('span', { class: 'tnum', text: cd.d + '天' }) : null,
                q('span', { text: String(cd.h).padStart(2, '0') }),
                q('span', { text: ':' }),
                q('span', { text: String(cd.m).padStart(2, '0') }),
                q('span', { text: ':' }),
                q('span', { text: String(cd.s).padStart(2, '0') }),
              ])
            : q('span', { text: '已结束' }),
        ]),
        q('span', { text: '共 ' + room.counts.questions + ' 个问题' }),
      ]),
    ]);
  }

  /* ---------- 统计块 ---------- */

  function statsNode() {
    const items = [
      { n: room.counts.questions, l: '收到问题' },
      { n: room.counts.answers, l: '已回答' },
      { n: room.counts.pending, l: '待回答' },
      { n: room.counts.hearts, l: '心动' },
      { n: room.counts.visits, l: '来过' },
    ];
    return q('div', { class: 'stat-grid' }, items.map((it) =>
      q('div', { class: 'stat-box' }, [
        q('div', { class: 'stat-num c-brand tnum', text: ui.fmtCount(it.n) }),
        q('div', { class: 'stat-label', text: it.l }),
      ])));
  }

  /* ---------- 消息气泡 ---------- */

  function postNode(post) {
    const isMine = post.author.identity === (store.me && store.me.identity);
    const isHostAnswer = post.kind === 'answer' && isOwner;
    // 主人回答永远靠右，普通访客靠左
    const right = isHostAnswer;

    const avatar = right
      ? ui.avatar(room.avatar, '', room.owner.nickname.slice(0, 1))
      : ui.anonAvatar();

    const bubbleClasses = ['bubble'];
    if (post.kind === 'question' && !post.answered) bubbleClasses.push('bubble-pending');
    if (post.featured) bubbleClasses.push('bubble-featured');

    const bubble = q('div', { class: bubbleClasses.join(' ') }, [
      q('div', { class: 'bubble-meta mb-4' }, [
        q('span', { class: 'bubble-name', text: right ? room.owner.nickname : '匿名访客' }),
        post.featured ? q('span', { class: 'chip chip-on', style: { height: '18px', fontSize: '10px' }, text: '精选' }) : null,
        post.replyTo ? q('span', { style: { opacity: '.7' }, text: '追问' }) : null,
      ]),
      post.voice ? voiceNode(post.voice) : null,
      post.text ? q('div', { text: post.text }) : null,
      q('div', { class: 'bubble-meta' }, [
        q('span', { text: ui.timeAgo(post.createdAt) }),
      ]),
      interactRow(post),
    ]);

    return q('div', {
      class: 'msg ' + (right ? 'msg-right' : 'msg-left'),
      dataset: { postId: post.id },
    }, [avatar, bubble]);
  }

  /* ---------- 语音条 ---------- */

  function voiceNode(voice) {
    const bar = q('div', { class: 'row gap-8 mt-4' }, [
      q('button', {
        class: 'icon-btn',
        style: { background: 'rgba(255,255,255,.2)', width: '30px', height: '30px' },
        onclick: (e) => playVoice(voice.url, e.target),
      }, [icon('send', 12)]),
      q('div', { class: 'flex-1', style: { height: '4px', borderRadius: '99px', background: 'rgba(255,255,255,.35)', overflow: 'hidden' } }, [
        q('div', { style: { height: '100%', width: '0%', background: 'currentColor', borderRadius: '99px', transition: 'width .2s' } }),
      ]),
      q('span', { class: 't-xs', style: { opacity: '.75' }, text: Math.round((voice.duration || 0)) + 's' }),
    ]);
    return bar;
  }

  let currentAudio = null;
  function playVoice(url, btn) {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
      if (btn) btn.innerHTML = iconHTML('send', 12);
    }
    if (!url) return;
    const audio = new Audio(url);
    currentAudio = audio;
    if (btn) btn.innerHTML = iconHTML('close', 12);
    audio.play().catch(() => {});
    audio.onended = () => {
      currentAudio = null;
      if (btn) btn.innerHTML = iconHTML('send', 12);
    };
  }

  /* ---------- 互动条 ---------- */

  function interactRow(post) {
    const row = q('div', { class: 'react-row' });

    const heart = q('button', { class: 'react', dataset: { react: 'heart' } }, [
      q('span', {}, [icon('heart', 13)]),
      q('span', { class: 'tnum', text: String(post.hearts) }),
    ]);
    heart.onclick = async (e) => {
      e.stopPropagation();
      heart.classList.add('beat');
      setTimeout(() => heart.classList.remove('beat'), 340);
      try {
        const r = await api.react(post.id, 'heart');
        post.hearts = r.hearts;
        heart.lastChild.textContent = String(r.hearts);
        heart.classList.toggle('react-on', r.reacted);
      } catch (err) {
        ui.toast(err.message, 'err');
      }
    };
    row.appendChild(heart);

    if (post.kind === 'question') {
      const clap = q('button', { class: 'react' }, [
        q('span', {}, [icon('check', 13)]),
        q('span', { class: 'tnum', text: String(post.claps) }),
      ]);
      clap.onclick = async (e) => {
        e.stopPropagation();
        try {
          const r = await api.react(post.id, 'clap');
          post.claps = r.claps;
          clap.lastChild.textContent = String(r.claps);
          clap.classList.toggle('react-on-clap', r.reacted);
        } catch (err) {
          ui.toast(err.message, 'err');
        }
      };
      row.appendChild(clap);

      if (!post.answered && room.state === 'live') {
        const follow = q('button', { class: 'react', text: '追问' });
        follow.onclick = (e) => {
          e.stopPropagation();
          openFollowup(post);
        };
        row.appendChild(follow);
      }
    }

    const more = q('button', { class: 'react', text: '···' });
    more.onclick = (e) => {
      e.stopPropagation();
      openActions(post);
    };
    row.appendChild(more);

    return row;
  }

  /* ---------- 更多操作 ---------- */

  function openActions(post) {
    const body = q('div', { class: 'col gap-8' });

    if (isOwner && post.kind === 'answer') {
      body.appendChild(q('button', {
        class: 'btn btn-ghost btn-block',
        text: post.featured ? '取消精选' : '设为精选',
        onclick: async () => {
          try {
            await api.feature(post.id);
            ui.toast('已更新', 'ok');
            document.querySelector('.sheet-mask').remove();
            document.body.style.overflow = '';
            loadPosts();
          } catch (err) {
            ui.toast(err.message, 'err');
          }
        },
      }));
    }

    body.appendChild(q('button', {
      class: 'btn btn-ghost btn-block',
      text: '举报这条内容',
      onclick: () => {
        document.querySelector('.sheet-mask').remove();
        document.body.style.overflow = '';
        openReport(post);
      },
    }));

    const canDelete = isOwner || (store.me && post.author.identity === store.me.identity);
    if (canDelete) {
      body.appendChild(q('button', {
        class: 'btn btn-danger btn-block',
        text: '删除',
        onclick: async () => {
          const yes = await ui.confirm('删除后无法恢复，确定吗？', { danger: true, okText: '删除' });
          if (!yes) return;
          try {
            await api.removePost(post.id);
            ui.toast('已删除', 'ok');
            loadPosts();
          } catch (err) {
            ui.toast(err.message, 'err');
          }
        },
      }));
    }

    ui.sheet({ title: '更多操作', content: body });
  }

  function openReport(post) {
    const reasons = ['不友善言论', '垃圾广告', '不实信息', '侵犯隐私', '其他'];
    const detail = q('textarea', { class: 'textarea', placeholder: '补充说明（可选）', style: { minHeight: '76px' } });
    let chosen = reasons[0];

    const body = q('div', { class: 'col gap-12' }, [
      q('div', { class: 'row wrap gap-6' }, reasons.map((r) =>
        q('button', {
          class: 'chip ' + (r === chosen ? 'chip-on' : ''),
          text: r,
          onclick: (e) => {
            chosen = r;
            e.target.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.remove('chip-on'));
            e.target.classList.add('chip-on');
          },
        }))),
      detail,
    ]);

    ui.sheet({
      title: '举报内容',
      content: body,
      footer: [
        q('button', {
          class: 'btn btn-primary btn-block',
          text: '提交举报',
          onclick: async (e) => {
            e.target.classList.add('loading');
            try {
              await api.report(post.id, chosen, detail.value);
              ui.toast('已收到，会尽快处理', 'ok');
              document.querySelector('.sheet-mask').remove();
              document.body.style.overflow = '';
            } catch (err) {
              ui.toast(err.message, 'err');
              e.target.classList.remove('loading');
            }
          },
        }),
      ],
    });
  }

  /* ---------- 追问 ---------- */

  function openFollowup(target) {
    const input = q('textarea', { class: 'textarea', placeholder: '想问得更具体一点…', maxlength: 200, style: { minHeight: '88px' } });
    const counter = q('div', { class: 'counter', text: '0 / 200' });
    input.oninput = () => {
      counter.textContent = input.value.length + ' / 200';
      counter.className = 'counter' + (input.value.length > 180 ? ' warn' : '');
    };
    ui.sheet({
      title: '追问这个问题',
      content: q('div', { class: 'col gap-10' }, [
        q('div', { class: 'notice' }, [
          q('span', { class: 'notice-icon', text: 'i' }),
          q('span', { text: target.text }),
        ]),
        input,
        counter,
      ]),
      footer: [
        q('button', {
          class: 'btn btn-primary btn-block',
          text: '发送追问',
          onclick: async (e) => {
            const text = input.value.trim();
            if (!text) return ui.toast('写点内容吧', 'err');
            e.target.classList.add('loading');
            try {
              await api.followup(target.id, text);
              ui.toast('追问已发送', 'ok');
              document.querySelector('.sheet-mask').remove();
              document.body.style.overflow = '';
              loadPosts();
            } catch (err) {
              ui.toast(err.message, 'err');
              e.target.classList.remove('loading');
            }
          },
        }),
      ],
    });
  }

  /* ---------- 主人回答 ---------- */

  function openAnswer(post) {
    const input = q('textarea', { class: 'textarea', placeholder: '如实回答就好…', maxlength: 300, style: { minHeight: '100px' } });
    const counter = q('div', { class: 'counter', text: '0 / 300' });
    let voice = null;

    input.oninput = () => {
      counter.textContent = input.value.length + ' / 300';
      counter.className = 'counter' + (input.value.length > 280 ? ' warn' : '');
    };

    const micBtn = q('button', {
      class: 'btn btn-ghost btn-sm',
      html: iconHTML('mic', 14) + '语音回答',
      onclick: () => {
        if (recorder) return stopRecord();
        startRecord();
      },
    });

    function startRecord() {
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        return ui.toast('当前环境不支持录音', 'err');
      }
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        recorder = new MediaRecorder(stream);
        const chunks = [];
        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const reader = new FileReader();
          reader.onload = () => {
            voice = { url: reader.result, duration: 0 };
            ui.toast('录音已附加', 'ok');
          };
          reader.readAsDataURL(blob);
        };
        recorder.start();
        micBtn.innerHTML = iconHTML('mic', 14) + '停止录音';
        micBtn.classList.add('btn-soft');
      }).catch(() => ui.toast('麦克风权限被拒绝', 'err'));
    }

    function stopRecord() {
      if (recorder) {
        recorder.stop();
        recorder = null;
        micBtn.innerHTML = iconHTML('mic', 14) + '语音回答';
        micBtn.classList.remove('btn-soft');
      }
    }

    ui.sheet({
      title: '回答这个问题',
      content: q('div', { class: 'col gap-10' }, [
        q('div', { class: 'notice notice-warn' }, [
          q('span', { class: 'notice-icon', text: 'Q' }),
          q('span', { text: post.text }),
        ]),
        input,
        counter,
        micBtn,
      ]),
      footer: [
        q('button', {
          class: 'btn btn-primary btn-block',
          text: '发布回答',
          onclick: async (e) => {
            const text = input.value.trim();
            if (!text && !voice) return ui.toast('写点什么或录段语音吧', 'err');
            e.target.classList.add('loading');
            try {
              await api.answer(post.id, { text: text, voice: voice });
              stopRecord();
              ui.toast('回答已发布', 'ok');
              document.querySelector('.sheet-mask').remove();
              document.body.style.overflow = '';
              loadPosts();
            } catch (err) {
              ui.toast(err.message, 'err');
              e.target.classList.remove('loading');
            }
          },
        }),
      ],
      onMount: (b, close) => {
        b.closest('.sheet').addEventListener('click', (e) => {
          if (e.target.closest('.sheet-foot')) stopRecord();
        });
      },
    });
  }

  /* ---------- 提问框 ---------- */

  function askBox() {
    if (room.state !== 'live') {
      return q('div', { class: 'ask-box col gap-10 center', style: { textAlign: 'center' } }, [
        q('div', { class: 't-sm c-3', text: room.state === 'closed' ? '这场坦白局已被发起者关闭' : '本场坦白局已到期，只能浏览' }),
      ]);
    }

    if (room.rules.onePerGuest && room.hasAnswered) {
      return q('div', { class: 'ask-box col gap-10' }, [
        q('div', { class: 'row gap-8' }, [
          q('span', { text: '✓' }),
          q('div', { class: 't-sm' }, [
            q('div', { class: 'bold', text: '你已经问过这个问题了' }),
            q('div', { class: 'c-3 mt-4', text: '本场限定每人一个问题，明天再来吧' }),
          ]),
        ]),
      ]);
    }

    const input = q('textarea', {
      class: 'textarea',
      placeholder: isOwner ? '可以自己置顶一个问题…' : '想问 TA 什么？真诚一点，TA 会看到的',
      maxlength: 300,
      style: { minHeight: '92px' },
    });
    const counter = q('div', { class: 'counter', text: '0 / 300' });
    const submit = q('button', { class: 'btn btn-primary btn-lg flex-1', text: isOwner ? '发布问题' : '向 TA 提问' });

    input.oninput = () => {
      const len = input.value.length;
      counter.textContent = len + ' / 300';
      counter.className = 'counter' + (len > 280 ? ' warn' : len > 300 ? ' over' : '');
    };

    // 草稿自动保存
    api.drafts().then((d) => {
      const hit = (d.list || []).find((x) => x.roomId === room.id);
      if (hit && hit.text) {
        input.value = hit.text;
        input.dispatchEvent(new Event('input'));
      }
    }).catch(() => {});
    input.oninput = ui.debounce(() => {
      if (input.value.trim()) api.saveDraft(room.id, input.value).catch(() => {});
    }, 800);

    submit.onclick = async () => {
      const text = input.value.trim();
      if (!text) return ui.toast('先写点内容吧', 'err');
      submit.classList.add('loading');
      try {
        const r = await api.createPost(room.id, { kind: 'question', text: text });
        input.value = '';
        api.saveDraft(room.id, '').catch(() => {});
        loadPosts();
        if (r.masked && r.masked.length) {
          ui.toast('已自动替换：' + r.masked.join('、'), '');
        }
        showSuccessDialog(text);
      } catch (err) {
        ui.toast(err.message, 'err');
        submit.classList.remove('loading');
      }
    };

    return q('div', { class: 'ask-box col gap-10' }, [
      q('div', { class: 'row gap-8' }, [
        ui.anonAvatar('avatar-sm'),
        q('div', { class: 'flex-1' }, [
          input,
        ]),
      ]),
      q('div', { class: 'row between items-start' }, [
        counter,
        submit,
      ]),
    ]);
  }

  /* ---------- 提问成功弹窗 ---------- */

  function showSuccessDialog(text) {
    const body = q('div', { class: 'col gap-12' });
    ui.sheet({
      title: '提问成功',
      content: q('div', { class: 'col gap-16', style: { textAlign: 'center' } }, [
        q('div', { class: 'col gap-8', style: { alignItems: 'center' } }, [
          q('div', {
            style: {
              width: '58px', height: '58px', borderRadius: '50%',
              background: 'var(--brand-soft)', color: 'var(--brand)',
              display: 'grid', placeItems: 'center', fontSize: '28px', fontWeight: '700',
              animation: 'popIn 420ms var(--ease-out) both',
            },
            text: '✓',
          }),
          q('div', { class: 't-3', text: '提问成功！' }),
          q('div', { class: 't-sm c-3', text: 'TA 会看到你的问题，' + (room.owner.nickname) + '回答后你会收到通知' }),
        ]),
        q('div', { class: 'row gap-10' }, [
          q('button', {
            class: 'btn btn-ghost flex-1',
            text: '返回',
            onclick: () => { document.querySelector('.sheet-mask').remove(); document.body.style.overflow = ''; },
          }),
          q('button', {
            class: 'btn btn-primary flex-1',
            text: '我也要玩',
            onclick: () => {
              document.querySelector('.sheet-mask').remove();
              document.body.style.overflow = '';
              router.navigate('/create');
            },
          }),
        ]),
        q('div', { class: 'divider-text', text: '也可以邀请好友来提问' }),
        q('div', { class: 'row gap-10' }, [
          q('button', { class: 'btn btn-soft flex-1', text: '生成海报', onclick: () => showPoster() }),
          q('button', { class: 'btn btn-ghost flex-1', text: '复制链接', onclick: copyLink }),
        ]),
      ]),
    });
  }

  async function copyLink() {
    const link = location.origin + '/#/room/' + room.id;
    try {
      await navigator.clipboard.writeText(link);
      ui.toast('链接已复制', 'ok');
    } catch (_) {
      ui.toast(link);
    }
  }

  /* ---------- 海报 ---------- */

  async function showPoster() {
    const shareUrl = location.origin + '/#/room/' + room.id;
    // 真·可扫二维码：与登录页同一套 Reed-Solomon 实现
    const qrSvg = window.QRSvg
      ? window.QRSvg(shareUrl, { margin: 1, scalable: true })
      : '<div style="width:100%;height:100%;background:#eee"></div>';

    const poster = q('div', { class: 'poster-card' }, [
      q('div', { class: 'poster-top' }, [
        q('h3', { text: '坦白局' }),
        q('p', {}, ['今天一人问一个问题', q('br'), '我全部如实回答']),
      ]),
      q('div', { class: 'poster-bottom' }, [
        ui.avatar(room.avatar, 'avatar-lg', 'T'),
        q('div', { class: 'col gap-4 flex-1', style: { textAlign: 'center' } }, [
          q('div', { class: 'poster-hint', text: '长按识别二维码' }),
          q('div', { class: 't-xs c-3 ellipsis', style: { maxWidth: '110px' }, text: room.title }),
        ]),
        q('div', { class: 'poster-qr', html: qrSvg }),
      ]),
      q('div', { class: 'poster-hint', style: { padding: '10px 0 16px' }, text: '长按保存图片，分享到朋友圈' }),
    ]);

    const stage = q('div', { class: 'poster-stage' }, [poster]);
    ui.sheet({
      title: '分享海报',
      content: q('div', { class: 'col gap-14' }, [
        stage,
        q('div', { class: 'row gap-10' }, [
          q('button', { class: 'btn btn-ghost flex-1', text: '复制链接', onclick: copyLink }),
          q('button', { class: 'btn btn-primary flex-1', text: '保存图片', onclick: () => savePoster(poster) }),
        ]),
      ]),
    });
  }

  function savePoster(node) {
    // 用 SVG 序列化 + canvas 导出，不依赖 html2canvas
    try {
      const rect = node.getBoundingClientRect();
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = rect.width * scale;
      canvas.height = rect.height * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, rect.width, rect.height);

      // 简化导出：仅渲染文本与二维码块，够用且稳定
      ctx.fillStyle = '#ffe14d';
      ctx.fillRect(0, 0, rect.width, 128);
      ctx.fillStyle = '#17191c';
      ctx.font = '800 34px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('坦白局', rect.width / 2, 62);
      ctx.font = '600 14px sans-serif';
      ctx.fillText('今天一人问一个问题', rect.width / 2, 92);
      ctx.fillText('我全部如实回答', rect.width / 2, 112);

      ctx.font = '600 15px sans-serif';
      ctx.fillText(room.title, rect.width / 2, 176);
      ctx.font = '400 12px sans-serif';
      ctx.fillStyle = '#9aa0a8';
      ctx.fillText(location.origin + '/#/room/' + room.id, rect.width / 2, 210);

      canvas.toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '坦白局-' + room.title.slice(0, 10) + '.png';
        a.click();
        ui.toast('已保存到下载目录', 'ok');
      });
    } catch (err) {
      ui.toast('保存失败，可截图后分享', 'err');
    }
  }

  /* ---------- 访客墙 ---------- */

  async function visitorsNode() {
    const box = q('div', { class: 'card card-pad' }, [
      q('div', { class: 't-3 mb-12', text: '来过的人' }),
      q('div', { class: 't-sm c-3', text: '加载中…' }),
    ]);
    try {
      const d = await api.visits(room.id);
      box.innerHTML = '';
      const seen = {};
      const unique = (d.list || []).filter((v) => {
        if (seen[v.name]) return false;
        seen[v.name] = 1;
        return true;
      });
      box.appendChild(q('div', { class: 't-3 mb-12' }, [
        '来过的人 ',
        q('span', { class: 'c-3 t-sm tnum', text: d.total + ' 次' }),
      ]));
      if (!unique.length) {
        box.appendChild(q('div', { class: 't-sm c-3', text: '还没有人来看过' }));
      } else {
        box.appendChild(q('div', { class: 'row wrap gap-10' }, unique.slice(0, 20).map((v) =>
          q('div', { class: 'visitor-cell' }, [
            ui.avatar(v.avatar, 'avatar-sm', v.name.slice(0, 1)),
            q('span', { text: v.name }),
          ]))));
      }
    } catch (_) { /* ignore */ }
    return box;
  }

  /* ---------- 加载帖子 ---------- */

  const listHost = q('div');

  async function loadPosts() {
    try {
      const d = await api.posts(room.id, filter !== 'all' ? { filter: filter } : null);
      posts = d.list;
      ui.render(listHost, posts.length
        ? q('div', { class: 'thread' }, posts.map(postNode))
        : q('div', { class: 'empty' }, [
            q('div', { class: 'empty-art', text: '?' }),
            q('div', { text: filter === 'all' ? '还没有人提问，来当第一个' : '这个分类下还没有内容' }),
          ]));
      // 同步统计
      const fresh = await api.room(room.id);
      room = Object.assign({}, room, fresh);
      const hero = document.querySelector('.room-hero');
      if (hero) hero.parentNode.replaceChild(heroNode(), hero);
    } catch (err) {
      ui.toast(err.message, 'err');
    }
  }

  /* ---------- 组装 ---------- */

  const seg = q('div', { class: 'segment', style: { display: 'flex', width: '100%' } });
  [
    { k: 'all', l: '全部' },
    { k: 'unanswered', l: '待回答' },
    { k: 'featured', l: '精选' },
    { k: 'mine', l: '我的' },
  ].forEach((t) => {
    seg.appendChild(q('button', {
      class: filter === t.k ? 'on' : '',
      text: t.l,
      style: { flex: '1' },
      onclick: () => {
        filter = t.k;
        seg.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
        seg.querySelectorAll('button')[['all', 'unanswered', 'featured', 'mine'].indexOf(t.k)].classList.add('on');
        loadPosts();
      },
    }));
  });

  ui.render(wrap, [
    heroNode(),
    q('div', { class: 'mt-16' }, statsNode()),
    q('div', { class: 'mt-16' }, askBox()),
    q('div', { class: 'row gap-8 mt-16 mb-12 items-start' }, [
      isOwner ? q('button', { class: 'btn btn-primary', text: '回答问题', onclick: openAnswerPicker }) : null,
      q('button', { class: 'btn btn-ghost', text: '分享海报', onclick: showPoster }),
    ]),
    seg,
    q('div', { class: 'mt-16' }, listHost),
  ]);

  await loadPosts();

  if (isOwner) visitorsNode().then((v) => wrap.appendChild(v));

  // 倒计时
  timer = setInterval(() => {
    const cd = ui.countdownParts(room.deadline);
    const el2 = document.querySelector('.countdown');
    if (!el2) return;
    if (cd.left <= 0) {
      clearInterval(timer);
      loadPosts();
      return;
    }
    const parts = [
      cd.d > 0 ? el('span', { class: 'tnum', text: cd.d + '天' }) : null,
      el('span', { text: String(cd.h).padStart(2, '0') }),
      el('span', { text: ':' }),
      el('span', { text: String(cd.m).padStart(2, '0') }),
      el('span', { text: ':' }),
      el('span', { text: String(cd.s).padStart(2, '0') }),
    ].filter(Boolean);
    ui.render(el2, parts);
  }, 1000);

  return () => {
    if (timer) clearInterval(timer);
    if (recorder && recorder.state === 'recording') recorder.stop();
  };

  /* ---------- 主人：挑一个问题回答 ---------- */

  async function openAnswerPicker() {
    const unanswered = posts.filter((p) => p.kind === 'question');
    if (!unanswered.length) return ui.toast('所有问题都回答完了', 'ok');
    const body = q('div', { class: 'col gap-8' });
    unanswered.forEach((p) => {
      body.appendChild(q('button', {
        class: 'card card-pad card-hover full',
        style: { textAlign: 'left', cursor: 'pointer' },
        onclick: () => {
          document.querySelector('.sheet-mask').remove();
          document.body.style.overflow = '';
          openAnswer(p);
        },
      }, [
        q('div', { class: 't-sm', text: p.text }),
        q('div', { class: 't-xs c-3 mt-4', text: ui.timeAgo(p.createdAt) }),
      ]));
    });
    ui.sheet({ title: '选一个问题回答', content: body });
  }
};