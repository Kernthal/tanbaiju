/**
 * 浏览器端二维码封装。
 * 复用服务端的 lib/qr.js（同一套 Reed-Solomon 实现，前后台行为一致）。
 */
(function () {
  function toSvg(text, opts) {
    const options = Object.assign({ margin: 2, scalable: true }, opts || {});
    const qr = window.QR;
    if (!qr) return '';
    return qr.toSvg(text, options);
  }
  window.QRSvg = toSvg;
})();