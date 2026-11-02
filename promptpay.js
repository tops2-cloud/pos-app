'use strict';
/* =========================================================
   พร้อมเพย์: สร้างข้อมูล QR ตามมาตรฐาน EMVCo (Thai QR Payment)
   ฝังยอดเงินในตัว QR ได้ · ไม่ต้องต่อเน็ต ไม่ต้องใช้ API ธนาคาร
   ใช้ไลบรารี qrcode-generator (vendor/qrcode-generator.js) วาดรูป
   ========================================================= */

/** ทำความสะอาดและแยกประเภทรหัสพร้อมเพย์
 *  เบอร์มือถือ 10 หลัก (0xxxxxxxxx) · เลขบัตรประชาชน/ผู้เสียภาษี 13 หลัก · e-Wallet 15 หลัก */
function ppParseId(raw) {
  const d = String(raw || '').replace(/[^\d]/g, '');
  if (/^0\d{9}$/.test(d)) return { type: 'phone', id: d };
  if (/^66\d{9}$/.test(d)) return { type: 'phone', id: '0' + d.slice(2) };
  if (/^\d{13}$/.test(d)) return { type: 'nid', id: d };
  if (/^\d{15}$/.test(d)) return { type: 'ewallet', id: d };
  return null;
}
const PP_TYPE_LABEL = { phone: 'เบอร์มือถือ', nid: 'เลขบัตรประชาชน / เลขผู้เสียภาษี', ewallet: 'e-Wallet ID' };

/** แสดงรหัสแบบปิดบางส่วน เช่น 081-xxx-5678 */
function ppMask(raw) {
  const p = ppParseId(raw); if (!p) return '';
  if (p.type === 'phone') return `${p.id.slice(0, 3)}-xxx-${p.id.slice(6)}`;
  return `${p.id.slice(0, 1)}-xxxx-xxxxx-${p.id.slice(-3)}`;
}

function ppCRC16(s) {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
const ppTLV = (tag, v) => tag + String(v.length).padStart(2, '0') + v;

/** สร้างข้อความ QR พร้อมเพย์ · amount > 0 = ฝังยอดเงิน */
function promptPayPayload(raw, amount) {
  const p = ppParseId(raw);
  if (!p) throw new Error('รหัสพร้อมเพย์ไม่ถูกต้อง');
  const target = p.type === 'phone' ? ppTLV('01', ('0000' + '66' + p.id.slice(1)).slice(-13))
    : p.type === 'nid' ? ppTLV('02', p.id) : ppTLV('03', p.id);
  const amt = +amount > 0 ? Math.round(+amount * 100) / 100 : 0;
  const body = ppTLV('00', '01')
    + ppTLV('01', amt ? '12' : '11')
    + ppTLV('29', ppTLV('00', 'A000000677010111') + target)
    + ppTLV('58', 'TH')
    + ppTLV('53', '764')
    + (amt ? ppTLV('54', amt.toFixed(2)) : '')
    + '6304';
  return body + ppCRC16(body);
}

/** ตาราง module ของ QR (true = จุดดำ) */
function qrMatrix(text) {
  const q = qrcode(0, 'M');
  q.addData(text); q.make();
  const n = q.getModuleCount();
  return { n, dark: (r, c) => q.isDark(r, c) };
}

/** วาด QR ลงบน canvas context ที่ (x0, y0) ขนาด size px (รวมขอบขาว 4 module) */
function drawQR(ctx, text, x0, y0, size) {
  const m = qrMatrix(text), total = m.n + 8, cell = size / total;
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.fillRect(x0, y0, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < m.n; r++) for (let c = 0; c < m.n; c++) {
    if (m.dark(r, c)) {
      const x = Math.floor(x0 + (c + 4) * cell), y = Math.floor(y0 + (r + 4) * cell);
      ctx.fillRect(x, y, Math.ceil(x0 + (c + 5) * cell) - x, Math.ceil(y0 + (r + 5) * cell) - y);
    }
  }
  ctx.restore();
}

/** QR เป็น <canvas> สำหรับแสดงบนจอ */
function qrCanvas(text, size = 260) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = c.height = Math.round(size * dpr);
  c.style.width = c.style.height = size + 'px';
  drawQR(c.getContext('2d'), text, 0, 0, c.width);
  return c;
}

/* ---------- QR ร้านค้าที่ธนาคารออกให้ (Thai QR / แม่มณี / K SHOP ฯลฯ) ----------
   เอาข้อความที่อ่านได้จาก QR เดิมมาเติมยอดเงิน (tag 54) แล้วคำนวณ CRC ใหม่ */
function emvParse(s) {
  s = String(s || '').trim();
  const out = []; let i = 0;
  while (i < s.length) {
    const tag = s.substr(i, 2), len = parseInt(s.substr(i + 2, 2), 10);
    if (!/^\d\d$/.test(tag) || isNaN(len) || i + 4 + len > s.length) return null;
    out.push([tag, s.substr(i + 4, len)]); i += 4 + len;
  }
  return out;
}
/** ตรวจ QR ร้านค้า → {name, city, kind} หรือ {error} */
function merchantQRInfo(raw) {
  const s = String(raw || '').replace(/\s+/g, '');
  if (!s) return null;
  const f = emvParse(s);
  if (!f || !s.startsWith('000201')) return { error: 'ไม่ใช่ข้อความ QR รับเงิน (ต้องขึ้นต้นด้วย 000201)' };
  const crc = f.find(x => x[0] === '63');
  if (!crc || f[f.length - 1][0] !== '63' || ppCRC16(s.slice(0, -4)) !== crc[1].toUpperCase()) return { error: 'ข้อความไม่ครบหรือผิด (รหัสตรวจสอบไม่ตรง) ลองคัดลอกใหม่ทั้งหมด' };
  const get = t => (f.find(x => x[0] === t) || [])[1] || '';
  if (get('53') && get('53') !== '764') return { error: 'QR นี้ไม่ใช่สกุลเงินบาท' };
  const kind = get('30') ? 'merchant' : get('29') ? 'promptpay' : '';
  if (!kind) return { error: 'QR นี้ไม่ใช่ Thai QR / พร้อมเพย์' };
  return { s, name: get('59'), city: get('60'), kind };
}
/** ใส่ยอดเงินลงใน QR ร้านค้า */
function merchantQRWithAmount(raw, amount) {
  const info = merchantQRInfo(raw);
  if (!info || info.error) throw new Error(info?.error || 'ไม่มี QR ร้านค้า');
  const amt = +amount > 0 ? Math.round(+amount * 100) / 100 : 0;
  const f = emvParse(info.s).filter(([t]) => t !== '54' && t !== '63');
  const pi = f.findIndex(([t]) => t === '01');
  if (pi >= 0) f[pi][1] = amt ? '12' : '11';
  if (amt) {
    const at = f.findIndex(([t]) => +t > 54);
    f.splice(at < 0 ? f.length : at, 0, ['54', amt.toFixed(2)]);
  }
  const body = f.map(([t, v]) => ppTLV(t, v)).join('') + '6304';
  return body + ppCRC16(body);
}
