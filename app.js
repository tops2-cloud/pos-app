'use strict';
/* ===================== helpers ===================== */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round((+n || 0) * 100) / 100;
const money = n => r2(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = v => { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? NaN : n; };
const DAY = 864e5;
const fmtDate = t => new Date(t).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
const fmtTime = t => new Date(t).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

/* ===================== IndexedDB ===================== */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('pos-db', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('products')) d.createObjectStore('products', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('sales')) d.createObjectStore('sales', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
    };
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });
}
const store = (s, mode = 'readonly') => db.transaction(s, mode).objectStore(s);
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const getAll = s => reqP(store(s).getAll());
const put = (s, v) => reqP(store(s, 'readwrite').put(v));
const del = (s, k) => reqP(store(s, 'readwrite').delete(k));

/* ===================== state ===================== */
let products = [];
const codeMap = new Map();           // code -> {p, i}
let cart = [];                       // {id, pid, ui, qty, disc}
let billDisc = null;                 // {type:'baht'|'pct', val}
let settings = { key: 'main', shopName: 'ร้านของฉัน', retentionDays: 30, lastBillNo: 0, paperMM: 58, receiptFooter: 'ขอบคุณที่ใช้บริการ', autoPrint: false };
let browseOpen = false;

function rebuildIndex() {
  products.sort((a, b) => a.name.localeCompare(b.name, 'th'));
  codeMap.clear();
  products.forEach(p => p.units.forEach((u, i) => { const c = String(u.code || '').trim(); if (c) codeMap.set(c, { p, i }); }));
}
async function loadAll() {
  products = await getAll('products');
  rebuildIndex();
  const s = await reqP(store('settings').get('main'));
  if (s) settings = { ...settings, ...s };
}
const saveSettings = () => put('settings', settings);
const getProduct = id => products.find(p => p.id === id);

/* ===================== UI helpers ===================== */
let toastT;
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
let actx;
function beep(ok = true) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = ok ? 1500 : 260; g.gain.value = 0.08;
    o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + (ok ? 0.08 : 0.3));
  } catch (e) { /* ignore */ }
  if (navigator.vibrate) navigator.vibrate(ok ? 40 : [80, 60, 80]);
}
function showModal(html) { $('#sheet').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#sheet').innerHTML = ''; }
function download(name, text, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([type.startsWith('text/csv') ? '﻿' + text : text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
const csvCell = v => { v = String(v ?? ''); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCSV = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n');
function parseCSV(t) {
  t = t.replace(/^﻿/, '');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
const todayStr = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);

/* ===================== pricing ===================== */
function discAmt(base, d) {
  if (!d || !d.val) return 0;
  return r2(d.type === 'pct' ? base * Math.min(d.val, 100) / 100 : Math.min(d.val, base));
}
function lineInfo(l) {
  const p = getProduct(l.pid), u = p.units[l.ui];
  const base = r2(u.price * l.qty), d = discAmt(base, l.disc);
  return { p, u, base, d, total: r2(base - d) };
}
function cartTotals() {
  let sub = 0, itemDisc = 0;
  cart.forEach(l => { const i = lineInfo(l); sub += i.base; itemDisc += i.d; });
  const after = r2(sub - itemDisc), bd = discAmt(after, billDisc);
  return { sub: r2(sub), itemDisc: r2(itemDisc), billDisc: bd, total: r2(after - bd) };
}
const discLabel = d => d ? (d.type === 'pct' ? `${d.val}%` : `฿${money(d.val)}`) : '';

/* ===================== tabs ===================== */
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  $$('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $('#billbar').classList.toggle('hidden', name !== 'sell');
  document.body.classList.toggle('selling', name === 'sell');
  if (name === 'products') renderProducts();
  if (name === 'report') renderReport();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

/* ===================== SELL ===================== */
function addToCart(p, ui = 0, qty = 1) {
  let l = cart.find(x => x.pid === p.id && x.ui === ui);
  if (l) { l.qty = r2(l.qty + qty); cart.splice(cart.indexOf(l), 1); }
  else l = { id: uid(), pid: p.id, ui, qty, disc: null };
  cart.unshift(l);
  renderCart(l.id);
}
function parseQtyPrefix(text) {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*[*xX×]\s*(.+)$/);
  return m ? { qty: +m[1], text: m[2].trim() } : { qty: 1, text: text.trim() };
}
function addByCode(code, qty = 1) {
  const m = codeMap.get(String(code).trim());
  if (!m) { beep(false); return null; }
  addToCart(m.p, m.i, qty); beep(true);
  return m;
}
function searchProducts(q) {
  q = q.trim().toLowerCase();
  if (!q) return products;
  return products.filter(p => p.name.toLowerCase().includes(q) || p.units.some(u => String(u.code || '').toLowerCase().includes(q)));
}
function renderResults() {
  const raw = $('#q').value, box = $('#results');
  if (!raw.trim() && !browseOpen) { box.classList.add('hidden'); return; }
  const list = searchProducts(parseQtyPrefix(raw).text).slice(0, 60);
  box.classList.remove('hidden');
  box.innerHTML = list.length ? list.map(p => `<div class="res"><div class="res-name">${esc(p.name)}</div><div class="chips">${
    p.units.map((u, i) => `<button class="chip" data-pid="${p.id}" data-ui="${i}">${esc(u.unit)} · ฿${money(u.price)}</button>`).join('')}</div></div>`).join('')
    : `<div class="muted pad">${products.length ? 'ไม่พบสินค้า' : 'ยังไม่มีสินค้า — ไปเพิ่มที่แท็บ "สินค้า" ก่อน'}</div>`;
}
function hideResults() { browseOpen = false; $('#q').value = ''; renderResults(); }

function renderCart(flashId) {
  cart = cart.filter(l => { const p = getProduct(l.pid); if (!p) return false; if (l.ui >= p.units.length) l.ui = 0; return true; });
  const el = $('#cart');
  if (!cart.length) {
    el.innerHTML = `<div class="empty">ยังไม่มีสินค้าในบิล<br><span class="muted small">พิมพ์ชื่อ/รหัส · กด ☰ เพื่อเลือก · กด 📷 เพื่อสแกน</span></div>`;
  } else {
    el.innerHTML = cart.map((l, idx) => {
      const { p, u, base, d, total } = lineInfo(l);
      return `<div class="line ${l.id === flashId ? 'flash' : ''}" data-i="${idx}">
        <div class="l-top"><div class="l-name">${esc(p.name)}</div><button class="x" data-act="del" title="ลบรายการ">✕</button></div>
        <div class="l-mid">
          <select data-act="unit" ${p.units.length < 2 ? 'disabled' : ''}>${p.units.map((uu, i) => `<option value="${i}" ${i === l.ui ? 'selected' : ''}>${esc(uu.unit)}</option>`).join('')}</select>
          <span class="code">รหัส ${esc(u.code || '-')}</span>
          <span class="muted">@ ฿${money(u.price)}</span>
        </div>
        <div class="l-bot">
          <div class="qty"><button data-act="minus">−</button><input data-act="qty" inputmode="decimal" value="${l.qty}"><button data-act="plus">+</button></div>
          <button class="disc ${d ? 'on' : ''}" data-act="disc">${d ? `ลด ${discLabel(l.disc)} (−${money(d)})` : '+ ส่วนลด'}</button>
          <div class="l-total">${d ? `<s class="muted">${money(base)}</s> ` : ''}${money(total)}</div>
        </div></div>`;
    }).join('');
  }
  const t = cartTotals();
  $('#bCount').textContent = cart.length;
  $('#bSub').textContent = money(t.sub);
  $('#bTotal').textContent = money(t.total);
  $('#btnBillDisc').textContent = t.billDisc ? `ส่วนลดท้ายบิล ${discLabel(billDisc)} (−${money(t.billDisc)})` : '+ ส่วนลดท้ายบิล';
}

function changeUnit(l, newUi) {
  const other = cart.find(x => x !== l && x.pid === l.pid && x.ui === newUi);
  if (other) { other.qty = r2(other.qty + l.qty); cart.splice(cart.indexOf(l), 1); renderCart(other.id); }
  else { l.ui = newUi; renderCart(l.id); }
  const p = getProduct(other ? other.pid : l.pid);
  toast(`เปลี่ยนเป็น ${p.units[newUi].unit} · รหัส ${p.units[newUi].code || '-'}`);
}

function openDiscount({ title, base, cur, onSave }) {
  let type = cur?.type || 'baht';
  showModal(`<h3>${title}</h3><p class="muted">ยอดก่อนลด ฿${money(base)}</p>
    <div class="seg"><button data-t="baht" class="${type === 'baht' ? 'on' : ''}">บาท (฿)</button><button data-t="pct" class="${type === 'pct' ? 'on' : ''}">เปอร์เซ็นต์ (%)</button></div>
    <input id="dVal" inputmode="decimal" value="${cur?.val || ''}" placeholder="0">
    <p id="dPreview" class="muted small"></p>
    <div class="actions"><button class="btn danger" id="dRemove">ลบส่วนลด</button><button class="btn" id="dCancel">ยกเลิก</button><button class="btn primary" id="dSave">ตกลง</button></div>`);
  const preview = () => { const v = num($('#dVal').value) || 0; const a = discAmt(base, { type, val: v }); $('#dPreview').textContent = `ลด ฿${money(a)} → เหลือ ฿${money(base - a)}`; };
  $$('#sheet .seg button').forEach(b => b.onclick = () => { type = b.dataset.t; $$('#sheet .seg button').forEach(x => x.classList.toggle('on', x === b)); preview(); });
  $('#dVal').oninput = preview; preview();
  $('#dRemove').onclick = () => { onSave(null); closeModal(); };
  $('#dCancel').onclick = closeModal;
  $('#dSave').onclick = () => {
    const v = num($('#dVal').value) || 0;
    if (v < 0 || (type === 'pct' && v > 100)) return toast('ค่าส่วนลดไม่ถูกต้อง');
    if (type === 'baht' && v > base) return toast('ส่วนลดมากกว่ายอดเงิน');
    onSave(v ? { type, val: v } : null); closeModal();
  };
  setTimeout(() => $('#dVal').focus(), 60);
}

function openPay() {
  if (!cart.length) return toast('ยังไม่มีสินค้าในบิล');
  const t = cartTotals();
  let method = 'cash';
  const notes = [20, 50, 100, 500, 1000].filter(n => n > t.total).slice(0, 3);
  showModal(`<h3>ชำระเงิน</h3>
    <div class="pay-total">฿${money(t.total)}</div>
    ${t.itemDisc || t.billDisc ? `<p class="center muted small">ยอดก่อนลด ฿${money(t.sub)} · ส่วนลดรวม ฿${money(t.itemDisc + t.billDisc)}</p>` : ''}
    <div class="seg"><button data-m="cash" class="on">เงินสด</button><button data-m="transfer">โอน / QR</button></div>
    <div id="cashBox">
      <label>รับเงินมา<input id="pRecv" inputmode="decimal" placeholder="${money(t.total)}"></label>
      <div class="row gap wrap quick"><button class="btn small" data-q="${t.total}">พอดี</button>${notes.map(n => `<button class="btn small" data-q="${n}">฿${n}</button>`).join('')}</div>
      <div class="change">เงินทอน ฿<b id="pChange">0.00</b></div>
    </div>
    <div class="actions"><button class="btn" id="pCancel">ยกเลิก</button><button class="btn primary big" id="pOk">ยืนยันการขาย</button></div>`);
  const recv = () => { const v = num($('#pRecv').value); return isNaN(v) ? t.total : v; };
  const upd = () => { $('#pChange').textContent = money(Math.max(0, recv() - t.total)); };
  $('#pRecv').oninput = upd;
  $$('#sheet [data-q]').forEach(b => b.onclick = () => { $('#pRecv').value = b.dataset.q; upd(); });
  $$('#sheet .seg button').forEach(b => b.onclick = () => {
    method = b.dataset.m; $$('#sheet .seg button').forEach(x => x.classList.toggle('on', x === b));
    $('#cashBox').classList.toggle('hidden', method !== 'cash');
  });
  $('#pCancel').onclick = closeModal;
  $('#pOk').onclick = async () => {
    const received = method === 'cash' ? recv() : t.total;
    if (method === 'cash' && received < t.total) return toast('รับเงินไม่พอ');
    $('#pOk').disabled = true;
    try {
      const sale = await saveSale(t, method, received);
      cart = []; billDisc = null; renderCart();
      showReceipt(sale, true);
      purgeOld();
      if (settings.autoPrint) printReceipt(sale, $('#rPrint'));
    } catch (e) { $('#pOk').disabled = false; toast('บันทึกไม่สำเร็จ: ' + e.message); }
  };
}

async function saveSale(t, method, received) {
  settings.lastBillNo = (settings.lastBillNo || 0) + 1;
  await saveSettings();
  const sale = {
    id: uid(), no: settings.lastBillNo, createdAt: Date.now(),
    items: cart.map(l => { const { p, u, base, d, total } = lineInfo(l); return { pid: p.id, name: p.name, unit: u.unit, code: u.code || '', price: u.price, qty: l.qty, base, disc: l.disc, discAmt: d, total }; }),
    sub: t.sub, itemDisc: t.itemDisc, billDiscDef: billDisc, billDisc: t.billDisc, total: t.total,
    method, received: r2(received), change: r2(received - t.total)
  };
  await put('sales', sale);
  return sale;
}

function receiptHTML(s) {
  return `<div class="receipt">
    <div class="center"><b>${esc(settings.shopName)}</b><br><span class="muted small">บิล #${s.no} · ${fmtDate(s.createdAt)} ${fmtTime(s.createdAt)}</span></div>
    ${s.items.map(i => `<div class="r-line"><div>${esc(i.name)} <span class="muted">(${esc(i.unit)})</span><br><span class="muted small">${i.qty} × ${money(i.price)}${i.discAmt ? ` · ลด ${money(i.discAmt)}` : ''}${i.code ? ` · #${esc(i.code)}` : ''}</span></div><div>${money(i.total)}</div></div>`).join('')}
    <div class="r-sum"><span>รวม</span><span>${money(s.sub)}</span></div>
    ${s.itemDisc ? `<div class="r-sum"><span>ส่วนลดรายการ</span><span>−${money(s.itemDisc)}</span></div>` : ''}
    ${s.billDisc ? `<div class="r-sum"><span>ส่วนลดท้ายบิล</span><span>−${money(s.billDisc)}</span></div>` : ''}
    <div class="r-sum big"><span>สุทธิ</span><span>฿${money(s.total)}</span></div>
    <div class="r-sum"><span>${s.method === 'cash' ? 'เงินสด' : 'โอน/QR'}</span><span>${money(s.received)}</span></div>
    ${s.method === 'cash' ? `<div class="r-sum"><span>เงินทอน</span><span>${money(s.change)}</span></div>` : ''}
  </div>`;
}
function showReceipt(s, justSold) {
  showModal(`${justSold && s.method === 'cash' ? `<div class="change">เงินทอน ฿<b style="font-size:2rem">${money(s.change)}</b></div>` : ''}
    ${receiptHTML(s)}
    <div class="actions"><button class="btn" id="rPrint">🖨️ พิมพ์ใบเสร็จ</button><button class="btn" id="rShare">📤 แชร์รูป (LINE)</button></div>
    <div class="center"><button class="link small" id="rSysPrint">พิมพ์ผ่านแอพอื่น / ระบบ</button></div>
    <div class="actions">${justSold ? '<button class="btn primary big" id="rNew">บิลใหม่</button>' : '<button class="btn danger" id="rDel">ลบบิลนี้</button><button class="btn" id="rClose">ปิด</button>'}</div>`);
  $('#rPrint').onclick = e => printReceipt(s, e.currentTarget);
  $('#rShare').onclick = () => shareReceipt(s);
  $('#rSysPrint').onclick = () => printViaSystem(s);
  if (justSold) $('#rNew').onclick = () => { closeModal(); toast('บันทึกการขายแล้ว'); };
  else {
    $('#rClose').onclick = closeModal;
    $('#rDel').onclick = async () => { if (!confirm(`ลบบิล #${s.no} ออกจากประวัติ?`)) return; await del('sales', s.id); closeModal(); renderReport(); toast('ลบบิลแล้ว'); };
  }
}

/* ---- scanner ---- */
let qr = null;
async function openScanner(onCode, { continuous = false, title = 'สแกนบาร์โค้ด' } = {}) {
  if (!window.Html5Qrcode) return toast('ตัวสแกนยังโหลดไม่เสร็จ ลองใหม่อีกครั้ง');
  $('#scanTitle').textContent = title;
  $('#scanMsg').innerHTML = '<span class="muted">เล็งกล้องไปที่บาร์โค้ดหรือ QR</span>';
  $('#scanOverlay').classList.remove('hidden');
  let last = '', lastT = 0;
  try {
    qr = new Html5Qrcode('reader', { verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
    await qr.start({ facingMode: 'environment' },
      { fps: 12, qrbox: (w, h) => ({ width: Math.floor(Math.min(w * 0.9, 380)), height: Math.floor(Math.min(h * 0.55, 200)) }) },
      txt => {
        txt = String(txt).trim(); const now = Date.now();
        if (txt === last && now - lastT < 1800) return;
        last = txt; lastT = now;
        if (continuous) $('#scanMsg').innerHTML = onCode(txt) || '';
        else { beep(true); closeScanner(); onCode(txt); }
      }, () => {});
  } catch (e) {
    $('#scanMsg').innerHTML = `เปิดกล้องไม่ได้: ${esc(e?.message || e)}<br><span class="muted small">กรุณาอนุญาตให้เว็บนี้ใช้กล้อง</span>`;
  }
}
async function closeScanner() {
  $('#scanOverlay').classList.add('hidden');
  const q = qr; qr = null;
  if (q) { try { if (q.isScanning) await q.stop(); q.clear(); } catch (e) { /* ignore */ } }
}
function sellScanHandler(code) {
  const m = addByCode(code);
  if (m) return `✅ <b>${esc(m.p.name)}</b> (${esc(m.p.units[m.i].unit)}) เพิ่มแล้ว · สแกนต่อได้เลย`;
  return `❌ ไม่พบรหัส <b>${esc(code)}</b><br><button class="btn small" data-newcode="${esc(code)}">+ เพิ่มเป็นสินค้าใหม่</button>`;
}
function askNewProduct(code) {
  showModal(`<h3>ไม่พบรหัส ${esc(code)}</h3><p class="muted">ต้องการเพิ่มเป็นสินค้าใหม่หรือไม่?</p>
    <div class="actions"><button class="btn" id="nNo">ไม่</button><button class="btn primary" id="nYes">เพิ่มสินค้า</button></div>`);
  $('#nNo').onclick = closeModal;
  $('#nYes').onclick = () => openProductForm(null, { code, addAfter: true });
}

/* ===================== PRODUCTS ===================== */
function renderProducts() {
  const list = searchProducts($('#pq').value);
  $('#pcount').textContent = `ทั้งหมด ${products.length} รายการ`;
  $('#plist').innerHTML = list.length ? list.map(p => `<div class="plist-item" data-pid="${p.id}"><b>${esc(p.name)}</b>
      <div class="units">${p.units.map(u => `<span>${esc(u.unit)} · #${esc(u.code || '-')} · ฿${money(u.price)}</span>`).join('')}</div></div>`).join('')
    : `<div class="empty muted">${products.length ? 'ไม่พบสินค้า' : `ยังไม่มีสินค้า<br><button class="btn small" id="btnDemo">ใส่สินค้าตัวอย่าง</button>`}</div>`;
  const demo = $('#btnDemo'); if (demo) demo.onclick = addDemo;
}
async function addDemo() {
  const demo = [
    { name: 'น้ำดื่ม 600ml', units: [{ unit: 'ขวด', code: '11111', price: 7 }, { unit: 'แพค (12 ขวด)', code: '11112', price: 75 }] },
    { name: 'มาม่า ต้มยำกุ้ง', units: [{ unit: 'ซอง', code: '22221', price: 7 }, { unit: 'แพค (10 ซอง)', code: '22222', price: 65 }, { unit: 'ลัง (30 ซอง)', code: '22223', price: 190 }] },
    { name: 'ไข่ไก่ เบอร์ 2', units: [{ unit: 'ฟอง', code: '33331', price: 5 }, { unit: 'แผง (30 ฟอง)', code: '33332', price: 135 }] }
  ];
  for (const d of demo) await put('products', { id: uid(), ...d });
  products = await getAll('products'); rebuildIndex(); renderProducts(); toast('เพิ่มสินค้าตัวอย่างแล้ว');
}

function openProductForm(p, opts = {}) {
  const isNew = !p;
  const draft = p ? JSON.parse(JSON.stringify(p)) : { id: uid(), name: '', units: [{ unit: 'ชิ้น', code: opts.code || '', price: '' }] };
  const sync = () => {
    draft.name = $('#fName').value;
    $$('#fUnits .unit-row').forEach(r => { const u = draft.units[+r.dataset.i]; r.querySelectorAll('[data-f]').forEach(inp => u[inp.dataset.f] = inp.value); });
  };
  const render = () => {
    showModal(`<h3>${isNew ? 'เพิ่มสินค้า' : 'แก้ไขสินค้า'}</h3>
      <label>ชื่อสินค้า<input id="fName" value="${esc(draft.name)}" placeholder="เช่น น้ำดื่ม 600ml"></label>
      <div class="muted small">หน่วยนับ — แต่ละหน่วยมีรหัส/บาร์โค้ด และราคาของตัวเอง (เช่น ขวด / แพค / ลัง)</div>
      <div id="fUnits">${draft.units.map((u, i) => `<div class="unit-row" data-i="${i}">
        <label class="ul u">หน่วย<input data-f="unit" placeholder="เช่น ชิ้น" value="${esc(u.unit)}"></label>
        <label class="ul p">ราคา (บาท)<input data-f="price" placeholder="0" inputmode="decimal" value="${esc(u.price)}"></label>
        <button class="icon-btn sm" data-act="rm" title="ลบหน่วยนี้">✕</button>
        <label class="ul c">รหัส / บาร์โค้ด<input data-f="code" placeholder="สแกนหรือพิมพ์" value="${esc(u.code)}"></label>
        <button class="icon-btn sm" data-act="scan" title="สแกนรหัส">📷</button>
      </div>`).join('')}</div>
      <button class="btn small" id="fAddUnit">+ เพิ่มหน่วยนับ</button>
      <div class="actions">${isNew ? '' : '<button class="btn danger" id="fDel">ลบ</button>'}<button class="btn" id="fCancel">ยกเลิก</button><button class="btn primary" id="fSave">บันทึก</button></div>`);
    $('#fAddUnit').onclick = () => { sync(); draft.units.push({ unit: '', code: '', price: '' }); render(); };
    $('#fUnits').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      sync(); const i = +b.closest('.unit-row').dataset.i;
      if (b.dataset.act === 'rm') { if (draft.units.length < 2) return toast('ต้องมีอย่างน้อย 1 หน่วย'); draft.units.splice(i, 1); render(); }
      if (b.dataset.act === 'scan') openScanner(code => { draft.units[i].code = code; render(); }, { title: `สแกนรหัสหน่วย "${draft.units[i].unit || ''}"` });
    };
    $('#fCancel').onclick = closeModal;
    if (!isNew) $('#fDel').onclick = async () => {
      if (!confirm(`ลบสินค้า "${p.name}"?`)) return;
      await del('products', p.id); products = products.filter(x => x.id !== p.id); rebuildIndex();
      closeModal(); renderProducts(); renderCart(); toast('ลบสินค้าแล้ว');
    };
    $('#fSave').onclick = async () => {
      sync();
      const name = draft.name.trim();
      if (!name) return toast('กรุณาใส่ชื่อสินค้า');
      const units = draft.units.map(u => ({ unit: String(u.unit).trim(), code: String(u.code).trim(), price: num(u.price) }));
      if (units.some(u => !u.unit)) return toast('กรุณาใส่ชื่อหน่วยนับให้ครบ');
      if (units.some(u => isNaN(u.price) || u.price < 0)) return toast('กรุณาใส่ราคาให้ถูกต้อง');
      const un = units.map(u => u.unit.toLowerCase()); if (new Set(un).size !== un.length) return toast('ชื่อหน่วยนับซ้ำกัน');
      const codes = units.map(u => u.code).filter(Boolean);
      if (new Set(codes).size !== codes.length) return toast('รหัสสินค้าซ้ำกันในสินค้านี้');
      for (const c of codes) { const m = codeMap.get(c); if (m && m.p.id !== draft.id) return toast(`รหัส ${c} ถูกใช้แล้วกับ "${m.p.name}"`); }
      const rec = { id: draft.id, name, units };
      await put('products', rec);
      products = products.filter(x => x.id !== rec.id).concat(rec); rebuildIndex();
      closeModal(); renderProducts(); renderCart(); renderResults();
      toast('บันทึกสินค้าแล้ว');
      if (opts.addAfter) { const ui = Math.max(0, units.findIndex(u => u.code === opts.code)); addToCart(rec, ui); }
    };
  };
  render();
  if (isNew) setTimeout(() => $('#fName')?.focus(), 60);
}

async function importProductsCSV(text) {
  const rows = parseCSV(text);
  if (rows.length && isNaN(num(rows[0][3]))) rows.shift(); // header
  let added = 0, updated = 0, skipped = 0;
  const byName = new Map(products.map(p => [p.name.trim().toLowerCase(), p]));
  const touched = new Set();
  for (const r of rows) {
    const [name, unit, code, price] = r.map(x => String(x ?? '').trim());
    const pr = num(price);
    if (!name || !unit || isNaN(pr)) { skipped++; continue; }
    let p = byName.get(name.toLowerCase());
    if (!p) { p = { id: uid(), name, units: [] }; byName.set(name.toLowerCase(), p); products.push(p); }
    const owner = code && codeMap.get(code);
    if (owner && owner.p.id !== p.id) { skipped++; continue; }
    const u = p.units.find(x => (code && x.code === code) || x.unit.toLowerCase() === unit.toLowerCase());
    if (u) { u.unit = unit; u.code = code; u.price = pr; updated++; } else { p.units.push({ unit, code, price: pr }); added++; }
    if (code) codeMap.set(code, { p, i: p.units.length - 1 });
    touched.add(p);
  }
  for (const p of touched) await put('products', p);
  products = await getAll('products'); rebuildIndex(); renderProducts();
  toast(`นำเข้า: เพิ่ม ${added} · อัปเดต ${updated}${skipped ? ` · ข้าม ${skipped}` : ''}`, 3500);
}
function exportProductsCSV() {
  const rows = [['ชื่อสินค้า', 'หน่วย', 'รหัส', 'ราคา']];
  products.forEach(p => p.units.forEach(u => rows.push([p.name, u.unit, u.code, u.price])));
  download(`products-${todayStr()}.csv`, toCSV(rows));
}

/* ===================== REPORT ===================== */
function setRange(r) {
  const now = new Date(); let from = new Date(now);
  if (r === 'month') from = new Date(now.getFullYear(), now.getMonth(), 1);
  else if (r !== 'today') from = new Date(now.getTime() - (+r - 1) * DAY);
  $('#dFrom').value = todayStr(from); $('#dTo').value = todayStr(now);
  renderReport();
}
async function salesInRange() {
  const f = new Date($('#dFrom').value + 'T00:00:00').getTime();
  const t = new Date($('#dTo').value + 'T23:59:59.999').getTime();
  if (isNaN(f) || isNaN(t)) return [];
  const list = await reqP(store('sales').index('createdAt').getAll(IDBKeyRange.bound(Math.min(f, t), Math.max(f, t))));
  return list.sort((a, b) => b.createdAt - a.createdAt);
}
async function renderReport() {
  if (!db) return;
  const list = await salesInRange();
  const sum = k => r2(list.reduce((a, s) => a + (s[k] || 0), 0));
  const cash = r2(list.filter(s => s.method === 'cash').reduce((a, s) => a + s.total, 0));
  const items = new Map();
  list.forEach(s => s.items.forEach(i => {
    const k = i.name + '|' + i.unit; const x = items.get(k) || { name: i.name, unit: i.unit, qty: 0, total: 0 };
    x.qty = r2(x.qty + i.qty); x.total = r2(x.total + i.total); items.set(k, x);
  }));
  const top = [...items.values()].sort((a, b) => b.total - a.total).slice(0, 15);
  const multiDay = $('#dFrom').value !== $('#dTo').value;
  $('#report').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="v">฿${money(sum('total'))}</div><div class="k">ยอดขายสุทธิ</div></div>
      <div class="stat"><div class="v">${list.length}</div><div class="k">จำนวนบิล</div></div>
      <div class="stat"><div class="v">฿${money(cash)}</div><div class="k">เงินสด · โอน ฿${money(sum('total') - cash)}</div></div>
      <div class="stat"><div class="v">฿${money(sum('itemDisc') + sum('billDisc'))}</div><div class="k">ส่วนลดรวม</div></div>
    </div>
    ${top.length ? `<div class="card"><h3>สินค้าขายดี</h3><table class="tbl"><tr><th>สินค้า</th><th class="num">จำนวน</th><th class="num">ยอด</th></tr>
      ${top.map(x => `<tr><td>${esc(x.name)} <span class="muted small">(${esc(x.unit)})</span></td><td class="num">${x.qty}</td><td class="num">${money(x.total)}</td></tr>`).join('')}</table></div>` : ''}
    <div class="card"><h3>รายการบิล</h3>${list.length ? `<table class="tbl"><tr><th>บิล</th><th>เวลา</th><th class="num">รายการ</th><th class="num">ยอด</th></tr>
      ${list.map(s => `<tr class="bill-row" data-sid="${s.id}"><td>#${s.no}</td><td>${multiDay ? fmtDate(s.createdAt) + ' ' : ''}${fmtTime(s.createdAt)}</td><td class="num">${s.items.length}</td><td class="num">${money(s.total)}</td></tr>`).join('')}</table>`
      : '<p class="muted">ไม่มีการขายในช่วงนี้</p>'}</div>`;
  $$('#report .bill-row').forEach(tr => tr.onclick = () => showReceipt(list.find(s => s.id === tr.dataset.sid), false));
}
async function exportSalesCSV() {
  const list = (await salesInRange()).reverse();
  if (!list.length) return toast('ไม่มีข้อมูลในช่วงนี้');
  const rows = [['วันที่', 'เวลา', 'เลขบิล', 'สินค้า', 'หน่วย', 'รหัส', 'ราคา', 'จำนวน', 'ส่วนลด', 'รวม', 'ชำระโดย']];
  list.forEach(s => {
    const d = todayStr(new Date(s.createdAt)), t = fmtTime(s.createdAt), m = s.method === 'cash' ? 'เงินสด' : 'โอน/QR';
    s.items.forEach(i => rows.push([d, t, s.no, i.name, i.unit, i.code, i.price, i.qty, i.discAmt, i.total, m]));
    if (s.billDisc) rows.push([d, t, s.no, 'ส่วนลดท้ายบิล', '', '', '', '', s.billDisc, -s.billDisc, m]);
  });
  download(`sales-${$('#dFrom').value}_${$('#dTo').value}.csv`, toCSV(rows));
}

/* ===================== SETTINGS & retention ===================== */
async function countOlderThan(days) {
  if (!days) return 0;
  return reqP(store('sales').index('createdAt').count(IDBKeyRange.upperBound(Date.now() - days * DAY, true)));
}
function purgeOld() {
  const d = +settings.retentionDays;
  if (!d) return Promise.resolve(0);
  const cutoff = Date.now() - d * DAY;
  return new Promise((res, rej) => {
    let n = 0;
    const r = store('sales', 'readwrite').index('createdAt').openCursor(IDBKeyRange.upperBound(cutoff, true));
    r.onsuccess = () => { const c = r.result; if (c) { c.delete(); n++; c.continue(); } else res(n); };
    r.onerror = () => rej(r.error);
  });
}
async function renderSettings() {
  $('#sShop').value = settings.shopName;
  $('#sRetention').value = String(settings.retentionDays);
  $('#sPaper').value = String(settings.paperMM === 80 ? 80 : 58);
  $('#sFooter').value = settings.receiptFooter || '';
  $('#sAutoPrint').checked = !!settings.autoPrint;
  $('#sPrinter').textContent = !navigator.bluetooth ? 'เบราว์เซอร์นี้ไม่รองรับบลูทูธ — ใช้ปุ่ม "พิมพ์ผ่านแอพอื่น" แทน'
    : settings.printerName ? `เครื่องพิมพ์ที่ใช้: ${settings.printerName}` : 'ยังไม่ได้เลือกเครื่องพิมพ์';
  const all = await getAll('sales');
  const oldest = all.reduce((m, s) => Math.min(m, s.createdAt), Infinity);
  let est = '';
  try { const e = await navigator.storage?.estimate?.(); if (e) est = ` · ใช้พื้นที่ ~${(e.usage / 1048576).toFixed(1)} MB`; } catch (e) { /* ignore */ }
  $('#sStats').textContent = `มีบิลในเครื่อง ${all.length} บิล${all.length ? ` · เก่าสุด ${fmtDate(oldest)}` : ''} · สินค้า ${products.length} รายการ${est}`;
}
async function backup() {
  const data = { app: 'pos', version: 1, exportedAt: new Date().toISOString(), settings, products: await getAll('products'), sales: await getAll('sales') };
  download(`pos-backup-${todayStr()}.json`, JSON.stringify(data), 'application/json');
}
async function restore(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return toast('ไฟล์ไม่ถูกต้อง'); }
  if (data.app !== 'pos' || !Array.isArray(data.products)) return toast('ไม่ใช่ไฟล์สำรองของแอพนี้');
  if (!confirm(`กู้คืนข้อมูล: สินค้า ${data.products.length} รายการ, บิล ${(data.sales || []).length} บิล\nข้อมูลปัจจุบันในเครื่องจะถูกแทนที่ทั้งหมด ยืนยัน?`)) return;
  await new Promise((res, rej) => {
    const tx = db.transaction(['products', 'sales', 'settings'], 'readwrite');
    ['products', 'sales'].forEach(s => tx.objectStore(s).clear());
    data.products.forEach(p => tx.objectStore('products').put(p));
    (data.sales || []).forEach(s => tx.objectStore('sales').put(s));
    if (data.settings) tx.objectStore('settings').put({ ...data.settings, key: 'main' });
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  await loadAll(); cart = []; billDisc = null; renderCart();
  $('#shopTitle').textContent = settings.shopName; renderSettings(); toast('กู้คืนข้อมูลเรียบร้อย');
}

/* ===================== wiring ===================== */
function bind() {
  $$('nav.tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

  // sell: search / enter
  $('#q').addEventListener('input', renderResults);
  $('#q').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const { qty, text } = parseQtyPrefix($('#q').value);
    if (!text) return;
    if (addByCode(text, qty)) { hideResults(); return; }
    const list = searchProducts(text);
    if (list.length === 1 && list[0].units.length === 1) { addToCart(list[0], 0, qty); beep(true); hideResults(); return; }
    if (!list.length && /^[\w-]+$/.test(text)) { askNewProduct(text); return; }
    toast('เลือกหน่วยจากรายการด้านล่าง');
  });
  $('#results').onclick = e => {
    const c = e.target.closest('.chip'); if (!c) return;
    const { qty } = parseQtyPrefix($('#q').value);
    addToCart(getProduct(c.dataset.pid), +c.dataset.ui, qty); beep(true); hideResults();
  };
  $('#btnBrowse').onclick = () => { browseOpen = !browseOpen; renderResults(); };
  $('#btnScan').onclick = () => openScanner(sellScanHandler, { continuous: true, title: 'สแกนสินค้า (สแกนต่อเนื่องได้)' });
  $('#scanClose').onclick = closeScanner;
  $('#scanMsg').onclick = e => {
    const b = e.target.closest('[data-newcode]'); if (!b) return;
    const code = b.dataset.newcode; closeScanner(); openProductForm(null, { code, addAfter: true });
  };

  // cart lines
  $('#cart').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const line = b.closest('.line'); if (!line) return;
    const l = cart[+line.dataset.i];
    switch (b.dataset.act) {
      case 'del': cart.splice(cart.indexOf(l), 1); renderCart(); break;
      case 'plus': l.qty = r2(l.qty + 1); renderCart(); break;
      case 'minus': if (l.qty > 1) { l.qty = r2(l.qty - 1); renderCart(); } else if (confirm('ลบรายการนี้?')) { cart.splice(cart.indexOf(l), 1); renderCart(); } break;
      case 'disc': { const { p, base } = lineInfo(l); openDiscount({ title: `ส่วนลด: ${p.name}`, base, cur: l.disc, onSave: d => { l.disc = d; renderCart(); } }); break; }
    }
  };
  $('#cart').onchange = e => {
    const line = e.target.closest('.line'); if (!line) return;
    const l = cart[+line.dataset.i];
    if (e.target.dataset.act === 'unit') changeUnit(l, +e.target.value);
    if (e.target.dataset.act === 'qty') {
      const v = num(e.target.value);
      if (isNaN(v) || v <= 0) { if (confirm('ลบรายการนี้?')) cart.splice(cart.indexOf(l), 1); }
      else l.qty = r2(v);
      renderCart();
    }
  };
  $('#cart').addEventListener('focusin', e => { if (e.target.dataset.act === 'qty') e.target.select(); });
  $('#btnBillDisc').onclick = () => {
    if (!cart.length) return toast('ยังไม่มีสินค้าในบิล');
    const t = cartTotals();
    openDiscount({ title: 'ส่วนลดท้ายบิล', base: r2(t.sub - t.itemDisc), cur: billDisc, onSave: d => { billDisc = d; renderCart(); } });
  };
  $('#btnClear').onclick = () => { if (cart.length && confirm('ล้างรายการทั้งหมดในบิลนี้?')) { cart = []; billDisc = null; renderCart(); } };
  $('#btnPay').onclick = openPay;

  // products
  $('#pq').oninput = renderProducts;
  $('#btnAddProduct').onclick = () => openProductForm(null);
  $('#plist').onclick = e => { const it = e.target.closest('.plist-item'); if (it) openProductForm(getProduct(it.dataset.pid)); };
  $('#btnImport').onclick = () => {
    showModal(`<h3>นำเข้าสินค้าจาก CSV</h3>
      <p class="small">ไฟล์ต้องมี 4 คอลัมน์ตามลำดับ: <b>ชื่อสินค้า, หน่วย, รหัส, ราคา</b><br>สินค้าที่มีหลายหน่วย ให้ใส่ชื่อสินค้าเดียวกันหลายแถว เช่น</p>
      <pre class="code" style="display:block;white-space:pre-wrap">ชื่อสินค้า,หน่วย,รหัส,ราคา\nน้ำดื่ม 600ml,ขวด,11111,7\nน้ำดื่ม 600ml,แพค,11112,75</pre>
      <p class="muted small">ทำใน Excel / Google Sheets แล้วบันทึกเป็น CSV (UTF-8) — กด "ส่งออก CSV" เพื่อดูตัวอย่างไฟล์ได้</p>
      <div class="actions"><button class="btn" id="iCancel">ยกเลิก</button><button class="btn primary" id="iPick">เลือกไฟล์</button></div>`);
    $('#iCancel').onclick = closeModal;
    $('#iPick').onclick = () => { closeModal(); $('#fileCsv').click(); };
  };
  $('#fileCsv').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) importProductsCSV(await f.text()); };
  $('#btnExportProducts').onclick = () => products.length ? exportProductsCSV() : toast('ยังไม่มีสินค้า');

  // report
  $$('#tab-report [data-range]').forEach(b => b.onclick = () => setRange(b.dataset.range));
  $('#dFrom').onchange = $('#dTo').onchange = renderReport;
  $('#btnExportSales').onclick = exportSalesCSV;

  // settings
  $('#sShop').onchange = async e => { settings.shopName = e.target.value.trim() || 'ร้านของฉัน'; await saveSettings(); $('#shopTitle').textContent = settings.shopName; toast('บันทึกแล้ว'); };
  $('#sRetention').onchange = async e => {
    const d = +e.target.value;
    const n = await countOlderThan(d);
    if (n && !confirm(`มีบิลที่เก่ากว่า ${d} วัน จำนวน ${n} บิล ซึ่งจะถูกลบทันที\nแนะนำให้ส่งออก CSV หรือสำรองข้อมูลก่อน — ยืนยันลบ?`)) { e.target.value = String(settings.retentionDays); return; }
    settings.retentionDays = d; await saveSettings();
    const k = await purgeOld();
    toast(d ? `ตั้งค่าเก็บข้อมูล ${d} วันแล้ว${k ? ` · ลบบิลเก่า ${k} บิล` : ''}` : 'ตั้งค่าเก็บข้อมูลตลอดแล้ว');
    renderSettings();
  };
  $('#sPaper').onchange = async e => { settings.paperMM = +e.target.value; await saveSettings(); toast(`กระดาษ ${settings.paperMM} มม.`); };
  $('#sFooter').onchange = async e => { settings.receiptFooter = e.target.value.trim(); await saveSettings(); toast('บันทึกแล้ว'); };
  $('#sAutoPrint').onchange = async e => { settings.autoPrint = e.target.checked; await saveSettings(); };
  $('#btnPickPrinter').onclick = async () => {
    try { await btPick(); toast('เชื่อมต่อเครื่องพิมพ์แล้ว'); }
    catch (e) { toast(e.name === 'NotFoundError' ? 'ยกเลิกการเลือก' : e.message, 4500); }
    renderSettings();
  };
  $('#btnTestPrint').onclick = e => printReceipt(testReceipt(), e.currentTarget);
  $('#btnTestShare').onclick = () => printViaSystem(testReceipt());
  $('#btnBackup').onclick = backup;
  $('#btnRestore').onclick = () => $('#fileBackup').click();
  $('#fileBackup').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) restore(await f.text()); };
  $('#btnClearSales').onclick = async () => {
    if (!confirm('ลบประวัติการขายทั้งหมด? (สินค้าจะไม่ถูกลบ)')) return;
    await reqP(store('sales', 'readwrite').clear()); renderSettings(); toast('ลบประวัติการขายแล้ว');
  };
}

function tickClock() { $('#clock').textContent = new Date().toLocaleString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }

async function init() {
  try {
    await openDB(); await loadAll();
  } catch (e) { document.body.innerHTML = `<p style="padding:20px">เปิดฐานข้อมูลไม่ได้: ${esc(e.message)}</p>`; return; }
  $('#shopTitle').textContent = settings.shopName;
  bind(); renderCart(); setRange('today'); switchTab('sell');
  tickClock(); setInterval(tickClock, 30000);
  const n = await purgeOld();
  if (n) toast(`ลบบิลที่เก่ากว่า ${settings.retentionDays} วันแล้ว ${n} บิล`, 3500);
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);
