/**
 * 通知中心：回答提醒、心动、追问。
 */

window.viewMessages = async function viewMessages(host) {
  const q = ui.el;

  if (!store.me) {
    ui.render(host, q('div', { class: 'login-wrap' }, [
      q('div', { class: 'login-card col gap-14' }, [
        q('div', { class: 't-2', style: { textAlign: 'center' }, text: '登录后查看通知' }),
        q('a', { class: 'btn btn-primary btn-block', href: '/login', text: '去登录' }),
      ]),
    ]));
    return;
  }

  ui.render(host, q('div', { style: { maxWidth: '620px', margin: '0 auto' } }, [
    q('div', { class: 'row between mb-16' }, [
      q('div', { class: 't-2', text: '通知' }),
      q('button', {
        class: 'btn btn-ghost btn-sm',
        text: '全部已读',
        onclick: async () => {
          await api.readMessages();
          ui.toast('已全部标记为已读', 'ok');
          router.navigate('/messages');
        },
      }),
    ]),
    q('div', { id: 'msgList' }, [q('div', { class: 'skel', style: { height: '90px', borderRadius: '16px' } })]),
  ]));

  try {
    const d = await api.messages();
    store.unread = d.unread;
    const list = document.getElementById('msgList');
    if (!d.list.length) {
      ui.render(list, q('div', { class: 'card card-pad-lg' }, [
        q('div', { class: 'empty' }, [
          q('div', { class: 'empty-art', text: '·' }),
          q('div', { text: '还没有通知' }),
          q('div', { class: 't-xs', text: '你提问的问题被回答时会收到提醒' }),
        ]),
      ]));
      return;
    }

    ui.render(list, q('div', { class: 'card col', style: { overflow: 'hidden' } },
      d.list.map((m) => q('div', {
        class: 'msg-item ' + (m.read ? '' : 'unread'),
        onclick: () => {
          if (m.roomId) router.navigate('/room/' + m.roomId);
        },
      }, [
        q('div', {
          style: {
            width: '34px', height: '34px', borderRadius: '50%',
            background: 'var(--brand-soft)', color: 'var(--brand)',
            display: 'grid', placeItems: 'center', flexShrink: '0',
          },
        }, [icon('bell', 16)]),
        q('div', { class: 'flex-1', style: { minWidth: '0' } }, [
          q('div', { class: 't-body', text: m.text }),
          q('div', { class: 't-xs c-3 mt-4', text: ui.timeAgo(m.createdAt) }),
        ]),
        !m.read ? q('span', { style: { width: '7px', height: '7px', borderRadius: '50%', background: 'var(--danger)', flexShrink: '0' } }) : null,
      ]))
    ));
  } catch (err) {
    ui.toast(err.message, 'err');
  }
};