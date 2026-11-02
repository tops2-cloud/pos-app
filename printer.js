'use strict';
/* =========================================================
   ใบเสร็จ: วาดเป็นรูป (canvas) → พิมพ์ผ่านบลูทูธ (ESC/POS raster)
   หรือ พิมพ์ผ่านระบบ (window.print) หรือ แชร์เป็นรูป (LINE ฯลฯ)
   ใช้ settings, money, esc, toast, saveSettings จาก app.js
   ========================================================= */
const PAPER_DOTS = { 58: 384, 80: 576 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- วาดใบเสร็จ ---------- */
function receiptCanvas(s, W, fs) {
  const c = document.createElement('canvas');
  c.width = W; c.height = 8000;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, c.height);
  x.fillStyle = '#000'; x.textBaseline = 'top';
  const pad = Math.round(W * 0.03), inner = W - pad * 2;
  const font = (sz, b) => `${b ? 'bold ' : ''}${Math.round(sz)}px "Sarabun","Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif`;
  let y = pad;

  const seg = (() => { try { return new Intl.Segmenter('th', { granularity: 'word' }); } catch (e) { return null; } })();
  const pieces = t => seg ? [...seg.segment(t)].map(p => p.segment) : Array.from(t);
  const wrap = (t, maxW) => {
    const out = []; let line = '';
    for (const p of pieces(String(t))) {
      if (x.measureText(line + p).width > maxW && line) { out.push(line.trimEnd()); line = p.trimStart(); }
      else line += p;
    }
    if (line) out.push(line);
    return out.length ? out : [''];
  };
  const center = (t, sz = fs, b = false) => {
    x.font = font(sz, b);
    wrap(t, inner).forEach(l => { x.fillText(l, (W - x.measureText(l).width) / 2, y); y += sz * 1.45; });
  };
  const lr = (l, r, sz = fs, b = false) => {
    x.font = font(sz, b);
    const rw = r ? x.measureText(r).width : 0;
    const lines = wrap(l, inner - rw - fs * 0.6);
    lines.forEach((ln, i) => {
      x.fillText(ln, pad, y);
      if (i === 0 && r) x.fillText(r, W - pad - rw, y);
      y += sz * 1.45;
    });
  };
  const hr = () => {
    y += fs * 0.25;
    for (let px = pad; px < W - pad; px += 10) x.fillRect(px, y, 6, 2);
    y += fs * 0.55;
  };

  const unpaid = s.status === 'unpaid';
  center(settings.shopName || 'ร้านค้า', fs * 1.3, true);
  center(`${unpaid ? 'ใบแจ้งยอด (ยังไม่ชำระ)' : 'ใบเสร็จ'} · บิล #${s.no}`, fs * 0.9);
  center(new Date(s.createdAt).toLocaleString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }), fs * 0.9);
  if (s.note) center(`ลูกค้า: ${s.note}`, fs * 0.9);
  hr();
  s.items.forEach(i => {
    lr(`${i.name} (${i.unit})`, '', fs, true);
    lr(`   ${i.qty} × ${money(i.price)}`, money(i.base ?? i.price * i.qty));
    if (i.discAmt) lr('   ส่วนลด', '-' + money(i.discAmt));
  });
  hr();
  lr('รวม', money(s.sub));
  if (s.itemDisc) lr('ส่วนลดรายการ', '-' + money(s.itemDisc));
  if (s.billDisc) lr('ส่วนลดท้ายบิล', '-' + money(s.billDisc));
  y += fs * 0.15;
  lr(unpaid ? 'ยอดที่ต้องชำระ' : 'สุทธิ', money(s.total), fs * 1.3, true);
  if (unpaid) {
    const qt = typeof billQRText === 'function' ? billQRText(s) : '';
    hr();
    if (qt) {
      center(payScanLabel(), fs * 0.95, true);
      const q = Math.round(Math.min(inner, W * 0.72));
      y += fs * 0.2; drawQR(x, qt, Math.round((W - q) / 2), Math.round(y), q); y += q + fs * 0.3;
      center(`฿${money(s.total)}`, fs * 1.3, true);
      const who = payWho();
      if (who) center(who, fs * 0.9);
    }
    if (settings.bankText) center(`${qt ? 'หรือโอนเข้า ' : 'โอนเข้า '}${settings.bankText}`, fs * 0.9);
  } else {
    lr(s.method === 'cash' ? 'รับเงินสด' : 'โอน / พร้อมเพย์', money(s.received));
    if (s.method === 'cash') lr('เงินทอน', money(s.change));
  }
  hr();
  if (settings.receiptFooter) center(settings.receiptFooter, fs * 0.95);
  y = Math.ceil(y + pad);

  const out = document.createElement('canvas');
  out.width = W; out.height = y;
  out.getContext('2d').drawImage(c, 0, 0);
  return out;
}

/* ---------- แปลงรูปเป็นคำสั่ง ESC/POS (GS v 0 raster) ---------- */
function canvasToEscPos(c) {
  const w = c.width, h = c.height, bw = Math.ceil(w / 8);
  const px = c.getContext('2d').getImageData(0, 0, w, h).data;
  const parts = [Uint8Array.from([0x1b, 0x40])]; // init
  const BAND = 96; // ส่งทีละแถบ เครื่องราคาถูกบางรุ่นรับรูปใหญ่ครั้งเดียวไม่ได้
  for (let y0 = 0; y0 < h; y0 += BAND) {
    const bh = Math.min(BAND, h - y0);
    const buf = new Uint8Array(8 + bw * bh);
    buf.set([0x1d, 0x76, 0x30, 0x00, bw & 255, bw >> 8, bh & 255, bh >> 8]);
    for (let y = 0; y < bh; y++) for (let xx = 0; xx < w; xx++) {
      const i = ((y0 + y) * w + xx) * 4;
      if (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114 < 150) buf[8 + y * bw + (xx >> 3)] |= 0x80 >> (xx & 7);
    }
    parts.push(buf);
  }
  parts.push(Uint8Array.from([0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00])); // feed + cut (ถ้ามีมีดตัด)
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; parts.forEach(p => { all.set(p, o); o += p.length; });
  return all;
}

/* ---------- บลูทูธ (Web Bluetooth, BLE) ---------- */
const BT_SERVICES = [
  0x18f0, 0xff00, 0xffe0, 0xfff0, 0xae30, 0xae00, 0xfee7, 0xae3a,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455'
];
let btDev = null, btChar = null;

async function btPick() {
  if (!navigator.bluetooth) throw new Error('เบราว์เซอร์นี้ไม่รองรับบลูทูธ — ใช้ Chrome บน Android หรือกด "พิมพ์ผ่านแอพอื่น"');
  btDev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BT_SERVICES });
  btChar = null;
  settings.printerId = btDev.id; settings.printerName = btDev.name || 'เครื่องพิมพ์';
  await saveSettings();
  return btConnect();
}
async function btConnect() {
  if (btChar && btDev?.gatt?.connected) return btChar;
  if (!btDev && navigator.bluetooth?.getDevices && settings.printerId) {
    try { btDev = (await navigator.bluetooth.getDevices()).find(d => d.id === settings.printerId) || null; } catch (e) { /* ignore */ }
  }
  if (!btDev) return btPick();
  btDev.ongattserverdisconnected = () => { btChar = null; };
  let server;
  try { server = await btDev.gatt.connect(); }
  catch (e) { btDev = null; throw new Error('เชื่อมต่อเครื่องพิมพ์ไม่ได้ — เปิดเครื่องพิมพ์แล้วกดพิมพ์อีกครั้ง'); }
  for (const sv of await server.getPrimaryServices()) {
    for (const ch of await sv.getCharacteristics()) {
      if (ch.properties.write || ch.properties.writeWithoutResponse) { btChar = ch; return ch; }
    }
  }
  throw new Error('ไม่พบช่องส่งข้อมูลของเครื่องพิมพ์ (เครื่องนี้อาจไม่รองรับ BLE)');
}
async function btSend(data, onProgress) {
  const ch = await btConnect();
  const withResp = ch.properties.write;
  let size = 180;
  for (let i = 0; i < data.length;) {
    const part = data.slice(i, i + size);
    try {
      if (withResp) await (ch.writeValueWithResponse ? ch.writeValueWithResponse(part) : ch.writeValue(part));
      else { await ch.writeValueWithoutResponse(part); await sleep(12); }
      i += part.length;
      onProgress?.(i / data.length);
    } catch (e) {
      if (size > 20) { size = 20; continue; } // MTU เล็ก ลองส่งก้อนเล็กลง
      throw e;
    }
  }
}

/* ---------- คำสั่งใช้งาน ---------- */
const paperMM = () => (+settings.paperMM === 80 ? 80 : 58);
const printCanvas = s => receiptCanvas(s, PAPER_DOTS[paperMM()], paperMM() === 80 ? 26 : 22);

async function printReceipt(s, btn) {
  if (!navigator.bluetooth) return printViaSystem(s);
  if (btn) btn.disabled = true;
  try {
    toast('กำลังพิมพ์…', 60000);
    await btSend(canvasToEscPos(printCanvas(s)), p => toast(`กำลังพิมพ์… ${Math.round(p * 100)}%`, 60000));
    toast('พิมพ์ใบเสร็จแล้ว');
  } catch (e) {
    toast(e.name === 'NotFoundError' ? 'ยกเลิกการเลือกเครื่องพิมพ์' : 'พิมพ์ไม่สำเร็จ: ' + e.message, 4500);
  } finally { if (btn) btn.disabled = false; }
}

function printViaSystem(s) {
  const mm = paperMM();
  $('#printArea').innerHTML = `<img src="${printCanvas(s).toDataURL('image/png')}" style="width:${mm - 6}mm">`;
  $('#pageStyle').textContent = `@page{size:${mm}mm ${Math.max(80, mm * 3)}mm;margin:2mm 3mm}`;
  setTimeout(() => window.print(), 100);
}

function dataURLtoBlob(u) {
  const [h, b] = u.split(','); const bin = atob(b); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: h.match(/:(.*?);/)[1] });
}
async function shareReceipt(s) {
  // วาดแบบ sync เพื่อให้ navigator.share ยังอยู่ในจังหวะที่ผู้ใช้กดปุ่ม
  const blob = dataURLtoBlob(receiptCanvas(s, 640, 28).toDataURL('image/png'));
  const kind = s.status === 'unpaid' ? 'bill' : 'receipt';
  const file = new File([blob], `${kind}-${s.no}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: `${kind === 'bill' ? 'บิล' : 'ใบเสร็จ'} #${s.no}` }); }
    catch (e) { if (e.name !== 'AbortError') toast('แชร์ไม่สำเร็จ: ' + e.message); }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = file.name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    toast(`บันทึกรูป${kind === 'bill' ? 'บิล' : 'ใบเสร็จ'}แล้ว ส่งทาง LINE ได้จากคลังรูป`, 3500);
  }
}

function testReceipt() {
  return {
    no: 0, createdAt: Date.now(),
    items: [
      { name: 'ทดสอบเครื่องพิมพ์ ภาษาไทย ก่อนใช้งานจริง', unit: 'ชิ้น', price: 25, qty: 2, base: 50, discAmt: 5, total: 45 },
      { name: 'สินค้าตัวอย่าง', unit: 'แพค', price: 120, qty: 1, base: 120, discAmt: 0, total: 120 }
    ],
    sub: 170, itemDisc: 5, billDisc: 0, total: 165, method: 'cash', received: 200, change: 35
  };
}
