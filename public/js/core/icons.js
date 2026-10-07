/**
 * 手绘图标系统。
 *
 * 图标是独立的 PNG 图片文件（由 tools/make-icons.py 生成，非 SVG）。
 * 通过 CSS mask 承载颜色 —— currentColor 决定最终颜色，
 * 因此图标既能跟随主题/状态变色，又保持为真实的图片资源。
 */

const ICON_BASE = '/assets/icons/';

/**
 * 生成图标 DOM 节点。
 * @param {string} name  图标名，如 'heart'
 * @param {string} size  尺寸，如 '18' 或 '18px'
 * @param {string} extra 附加 class
 */
function icon(name, size, extra) {
  const px = (size || 20) + 'px';
  const node = document.createElement('i');
  node.className = 'hicon' + (extra ? ' ' + extra : '');
  node.style.width = px;
  node.style.height = px;
  node.style.webkitMaskImage = 'url(' + ICON_BASE + name + '.png)';
  node.style.maskImage = 'url(' + ICON_BASE + name + '.png)';
  node.setAttribute('aria-hidden', 'true');
  return node;
}

/** 同上，但直接插入字符串形式（用于 innerHTML 场景） */
function iconHTML(name, size, extra) {
  const px = (size || 20) + 'px';
  const url = ICON_BASE + name + '.png';
  return '<i class="hicon' + (extra ? ' ' + extra : '') + '" style="width:' + px + ';height:' + px +
    ';-webkit-mask-image:url(' + url + ');mask-image:url(' + url + ')" aria-hidden="true"></i>';
}

/** 品牌徽标：手绘的对话框图形，不是文字 */
function brandMark(size, extra) {
  return icon('sparkle', size || 30, 'brand-art' + (extra ? ' ' + extra : ''));
}

window.hicon = icon;
window.iconHTML = iconHTML;
window.brandMark = brandMark;
window.ICON_BASE = ICON_BASE;