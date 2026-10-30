import { firebaseConfig } from './firebase-config.js';
import {
  createLocalStore, connectFirebase, localSnapshot,
  newHouseholdCode, formatCode, parseCode,
} from './data.js';

const HID_KEY = 'kaimono.household';
const DONE_OPEN_KEY = 'kaimono.doneOpen';
const STARTER_STORES = ['スーパー', 'ドラッグストア', '100円ショップ', 'ホームセンター'];

const S = {
  store: null,          // data.js が返す置き場所
  fb: null,             // Firebase 接続（共有を使うときだけ）
  hid: null,            // 共有コード
  stores: [],
  items: [],
  unsub: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ひらがな・カタカナ・全角半角・大文字小文字の違いを無視して比べる
const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

// ---- 起動 -------------------------------------------------------------------

async function boot() {
  window.addEventListener('kaimono:error', e => {
    console.error(e.detail);
    toast('うまく保存できませんでした。通信状態を確認してください');
  });
  window.addEventListener('hashchange', render);
  window.addEventListener('online', updateOffline);
  window.addEventListener('offline', updateOffline);

  if (!firebaseConfig) {
    useStore(createLocalStore());
    return;
  }

  S.hid = lsGet(HID_KEY, null);
  const joinFromLink = parseCode(location.hash);
  if (joinFromLink) history.replaceState(null, '', location.pathname);

  try {
    S.fb = await connectFirebase(firebaseConfig);
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="welcome"><h1>かいもの</h1>
      <p>共有サーバーにつながりませんでした。<br>電波のよい場所でもう一度開いてください。</p>
      <button class="primary" onclick="location.reload()">もう一度</button></div>`;
    return;
  }

  if (joinFromLink && joinFromLink !== S.hid) return renderWelcome(joinFromLink);
  if (!S.hid) return renderWelcome();
  openHousehold(S.hid);
}

function useStore(store) {
  S.unsub.forEach(fn => fn());
  S.store = store;
  S.storesReady = false;
  S.unsub = [
    store.subscribe('stores', rows => { S.stores = rows; S.storesReady = true; refresh(); }),
    store.subscribe('items', rows => { S.items = rows; refresh(); }),
  ];
  render();
}

function openHousehold(code) {
  S.hid = code;
  lsSet(HID_KEY, code);
  useStore(S.fb.open(code));
}

// ---- 共有のはじめかた ---------------------------------------------------------

function renderWelcome(prefill = '') {
  app.innerHTML = `
    <div class="welcome">
      <div class="welcome-mark" aria-hidden="true"></div>
      <h1>かいもの</h1>
      <p>お店ごとに、買うものをふたりで共有できます。</p>
      <button class="primary" id="w-new">新しく始める</button>
      <form id="w-join" class="join">
        <label for="w-code">招待コードで参加する</label>
        <input id="w-code" placeholder="XXXX-XXXX-XXXX-XXXX" autocapitalize="characters"
          autocomplete="off" spellcheck="false" value="${esc(prefill ? formatCode(prefill) : '')}">
        <button class="secondary" type="submit">参加する</button>
      </form>
    </div>`;

  $('#w-new').onclick = async () => {
    const code = newHouseholdCode();
    const local = localSnapshot();
    const seed = Object.keys(local.stores).length &&
      confirm('この端末に保存してあるリストを、共有リストに引き継ぎますか？') ? local : null;
    try {
      await S.fb.createHousehold(code, seed);
    } catch (err) {
      console.error(err);
      return toast('作成できませんでした。通信状態を確認してください');
    }
    openHousehold(code);
    setTimeout(openShareSheet, 300);
  };

  $('#w-join').onsubmit = async e => {
    e.preventDefault();
    const code = parseCode($('#w-code').value);
    if (!code) return toast('コードは英数字16桁です');
    try {
      if (!(await S.fb.householdExists(code))) return toast('そのコードのリストが見つかりません');
    } catch (err) {
      console.error(err);
      return toast('確認できませんでした。通信状態を確認してください');
    }
    openHousehold(code);
    toast('参加しました');
  };
}

// ---- 画面の切り替え -----------------------------------------------------------

function currentStoreId() {
  const m = location.hash.match(/^#\/store\/([\w-]+)/);
  return m ? m[1] : null;
}

function render() {
  if (!S.store || !S.storesReady) return;
  const id = currentStoreId();
  if (id) renderStore(id); else renderHome();
  updateOffline();
}

// データが変わったとき、入力中の文字やフォーカスを壊さないよう一覧だけ描き直す
function refresh() {
  if (!S.store || !S.storesReady) return;
  const id = currentStoreId();
  if (!app.dataset.view) return render();
  if (app.dataset.view === 'home' && !id) return fillHome();
  if (app.dataset.view === 'store' && id === app.dataset.storeId) {
    if (!S.stores.some(s => s.id === id)) { location.hash = ''; return; }
    return fillStore();
  }
  render();
}

const sortedStores = () => [...S.stores].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const itemsOf = storeId => S.items.filter(i => i.storeId === storeId);
const todoOf = storeId => itemsOf(storeId).filter(i => !i.done).sort((a, b) => a.addedAt - b.addedAt);
const doneOf = storeId => itemsOf(storeId).filter(i => i.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));

// ---- ホーム（お店の一覧） -----------------------------------------------------

function renderHome() {
  app.dataset.view = 'home';
  delete app.dataset.storeId;
  app.innerHTML = `
    <header class="bar">
      <h1 class="title-lg">かいもの</h1>
      <button class="icon-btn" id="settings" aria-label="設定">${icon('gear')}</button>
    </header>
    <div class="offline" hidden>オフライン — 電波が戻ると自動で同期します</div>
    <main>
      <ul class="stores" id="stores"></ul>
      <div class="empty" id="home-empty" hidden>
        <p>まずはお店を追加しましょう</p>
        <div class="chips">${STARTER_STORES.map(n =>
          `<button class="chip" data-starter="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      </div>
      <p class="hint" id="home-hint" hidden>長押しで名前の変更・並び替え・削除</p>
    </main>
    <footer class="dock">
      <button class="primary wide" id="add-store">${icon('plus')}お店を追加</button>
    </footer>`;

  $('#settings').onclick = openSettings;
  $('#add-store').onclick = () => openSheet({
    title: 'お店を追加',
    input: { placeholder: '例：スーパー' },
    actions: [{ label: '追加', primary: true, run: v => v && addStore(v) }],
  });
  $('#home-empty').onclick = e => {
    const b = e.target.closest('[data-starter]');
    if (b) addStore(b.dataset.starter);
  };

  const list = $('#stores');
  list.onclick = e => {
    const row = e.target.closest('[data-id]');
    if (row) location.hash = `#/store/${row.dataset.id}`;
  };
  onLongPress(list, row => storeSheet(row.dataset.id));

  fillHome();
}

function fillHome() {
  const stores = sortedStores();
  $('#home-empty').hidden = stores.length > 0;
  $('#home-hint').hidden = stores.length === 0;
  $('#stores').innerHTML = stores.map(s => {
    const todo = todoOf(s.id);
    const preview = todo.slice(0, 4).map(i => i.name).join('・') + (todo.length > 4 ? ' …' : '');
    return `
      <li class="store-row" data-id="${s.id}">
        <div class="store-main">
          <span class="store-name">${esc(s.name)}</span>
          <span class="store-sub">${todo.length ? esc(preview) : '買うものはありません'}</span>
        </div>
        ${todo.length ? `<span class="count">${todo.length}</span>` : ''}
        <span class="chev">${icon('chev')}</span>
      </li>`;
  }).join('');
}

function addStore(name) {
  const order = Math.max(0, ...S.stores.map(s => s.order ?? 0)) + 1;
  S.store.add('stores', { name: name.trim(), order, createdAt: Date.now() });
}

function storeSheet(id) {
  const s = S.stores.find(x => x.id === id);
  if (!s) return;
  const stores = sortedStores();
  const idx = stores.findIndex(x => x.id === id);
  const swap = j => {
    const o = stores[j];
    S.store.update('stores', s.id, { order: o.order ?? 0 });
    S.store.update('stores', o.id, { order: s.order ?? 0 });
  };
  const history = doneOf(id);
  openSheet({
    title: s.name,
    input: { value: s.name, placeholder: 'お店の名前' },
    actions: [
      { label: '名前を保存', primary: true, run: v => v && v !== s.name && S.store.update('stores', id, { name: v }) },
      idx > 0 && { label: '上へ移動', run: () => swap(idx - 1) },
      idx < stores.length - 1 && { label: '下へ移動', run: () => swap(idx + 1) },
      history.length && {
        label: `完了済みの履歴を消す（${history.length}件）`,
        run: () => confirm('完了済みの履歴をすべて消します。よろしいですか？') &&
          S.store.remove('items', history.map(i => i.id)),
      },
      {
        label: 'このお店を削除', danger: true,
        run: () => {
          if (!confirm(`「${s.name}」と、その中の買うもの・履歴をすべて削除します。よろしいですか？`)) return;
          S.store.remove('items', itemsOf(id).map(i => i.id));
          S.store.remove('stores', id);
          if (currentStoreId() === id) location.hash = '';
        },
      },
    ],
  });
}

// ---- お店の中（買うもの） -----------------------------------------------------

function renderStore(id) {
  const s = S.stores.find(x => x.id === id);
  if (!s) { location.hash = ''; return; }
  app.dataset.view = 'store';
  app.dataset.storeId = id;
  app.innerHTML = `
    <header class="bar">
      <button class="back" id="back">${icon('back')}お店</button>
      <h1 class="title" id="store-title"></h1>
      <button class="icon-btn" id="store-menu" aria-label="お店の設定">${icon('more')}</button>
    </header>
    <div class="offline" hidden>オフライン — 電波が戻ると自動で同期します</div>
    <form class="composer" id="composer" autocomplete="off">
      <input id="new-item" placeholder="買うものを追加" enterkeyhint="done" autocomplete="off">
      <button type="submit" class="add-btn" aria-label="追加">${icon('plus')}</button>
    </form>
    <div class="suggest" id="suggest" hidden></div>
    <main>
      <ul class="items" id="todo"></ul>
      <div class="empty small" id="todo-empty" hidden><p>買うものはありません</p></div>
      <section id="done-wrap" hidden>
        <button class="done-head" id="done-toggle"><span id="done-label"></span><span class="chev-s">${icon('chev')}</span></button>
        <ul class="items done" id="done"></ul>
      </section>
      <p class="hint">長押しで名前の変更・削除</p>
    </main>`;

  $('#back').onclick = () => { location.hash = ''; };
  $('#store-menu').onclick = () => storeSheet(id);

  const input = $('#new-item');
  $('#composer').onsubmit = e => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) { input.blur(); return; }
    addItem(id, v);
    input.value = '';
    fillSuggest();
  };
  input.addEventListener('focus', fillSuggest);
  input.addEventListener('input', fillSuggest);
  input.addEventListener('blur', () => { $('#suggest').hidden = true; });

  const sug = $('#suggest');
  sug.addEventListener('pointerdown', e => e.preventDefault()); // 入力欄のフォーカスを保つ
  sug.onclick = e => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    revive(b.dataset.id);
    input.value = '';
    fillSuggest();
  };

  const toggle = e => {
    const row = e.target.closest('[data-id]');
    if (row) toggleItem(row);
  };
  $('#todo').onclick = toggle;
  $('#done').onclick = toggle;
  onLongPress($('#todo'), row => itemSheet(row.dataset.id));
  onLongPress($('#done'), row => itemSheet(row.dataset.id));

  $('#done-toggle').onclick = () => {
    lsSet(DONE_OPEN_KEY, lsGet(DONE_OPEN_KEY, '1') === '1' ? '0' : '1');
    fillStore();
  };

  fillStore();
}

function fillStore() {
  const id = app.dataset.storeId;
  const s = S.stores.find(x => x.id === id);
  if (!s) return;
  $('#store-title').textContent = s.name;
  const todo = todoOf(id);
  const done = doneOf(id);
  const open = lsGet(DONE_OPEN_KEY, '1') === '1';

  $('#todo').innerHTML = todo.map(itemRow).join('');
  $('#todo-empty').hidden = todo.length > 0;
  $('#done-wrap').hidden = done.length === 0;
  $('#done-wrap').classList.toggle('open', open);
  $('#done-label').textContent = `完了済み ${done.length}`;
  $('#done').innerHTML = open ? done.map(itemRow).join('') : '';
  if (document.activeElement === $('#new-item')) fillSuggest();
}

function itemRow(i) {
  return `
    <li class="item${i.done ? ' is-done' : ''}" data-id="${i.id}">
      <span class="check" aria-hidden="true">${icon('check')}</span>
      <span class="item-name">${esc(i.name)}</span>
    </li>`;
}

// 入力中は、そのお店で前に買ったもの（完了済み）を候補に出す
function fillSuggest() {
  const box = $('#suggest');
  if (!box) return;
  const id = app.dataset.storeId;
  const q = norm($('#new-item').value);
  const done = doneOf(id);
  let hits, head;
  if (!q) {
    hits = done.slice(0, 16);
    head = '最近買ったもの';
  } else {
    hits = done.filter(i => norm(i.name).includes(q))
      .sort((a, b) => norm(a.name).startsWith(q) === norm(b.name).startsWith(q) ? 0 : norm(a.name).startsWith(q) ? -1 : 1)
      .slice(0, 16);
    head = '履歴から戻す';
  }
  const already = q && todoOf(id).find(i => norm(i.name) === q);
  if (!hits.length && !already) { box.hidden = true; return; }
  box.innerHTML = `
    ${hits.length ? `<div class="suggest-head">${head}</div>
      <div class="chips">${hits.map(i =>
        `<button type="button" class="chip" data-id="${i.id}">${icon('undo')}${esc(i.name)}</button>`).join('')}</div>` : ''}
    ${already ? `<div class="suggest-note">「${esc(already.name)}」はリストにあります</div>` : ''}`;
  box.hidden = false;
}

function addItem(storeId, name) {
  const key = norm(name);
  const same = itemsOf(storeId).find(i => norm(i.name) === key);
  if (same && !same.done) { toast(`「${same.name}」はリストにあります`); return; }
  if (same) { revive(same.id); return; }
  S.store.add('items', { storeId, name, done: false, addedAt: Date.now(), doneAt: null });
}

function revive(id) {
  S.store.update('items', id, { done: false, addedAt: Date.now(), doneAt: null });
}

function toggleItem(row) {
  const i = S.items.find(x => x.id === row.dataset.id);
  if (!i) return;
  if (i.done) return revive(i.id);
  // チェックの動きを一瞬見せてから下へ移す
  row.classList.add('is-done', 'settling');
  setTimeout(() => S.store.update('items', i.id, { done: true, doneAt: Date.now() }), 260);
}

function itemSheet(id) {
  const i = S.items.find(x => x.id === id);
  if (!i) return;
  const others = sortedStores().filter(s => s.id !== i.storeId);
  openSheet({
    title: i.name,
    input: { value: i.name, placeholder: '名前' },
    actions: [
      { label: '名前を保存', primary: true, run: v => v && v !== i.name && S.store.update('items', id, { name: v }) },
      others.length && {
        label: '別のお店へ移す',
        run: () => setTimeout(() => openSheet({
          title: `「${i.name}」の移動先`,
          actions: others.map(s => ({ label: s.name, run: () => S.store.update('items', id, { storeId: s.id }) })),
        }), 280),
      },
      { label: '削除', danger: true, run: () => S.store.remove('items', id) },
    ],
  });
}

// ---- 設定・共有 ---------------------------------------------------------------

function openSettings() {
  if (!firebaseConfig) {
    return openSheet({
      title: '設定',
      body: `<p>いまは<strong>この端末だけ</strong>に保存しています。</p>
        <p class="muted">ふたりで共有するには、Firebase の設定が必要です（手順書を参照）。</p>`,
      actions: [],
    });
  }
  openSheet({
    title: '設定',
    body: `<p>ふたりで共有しています。</p>
      <p class="muted">共有コード</p><p class="code">${formatCode(S.hid)}</p>`,
    actions: [
      { label: '招待する（コードを送る）', primary: true, run: () => setTimeout(openShareSheet, 280) },
      {
        label: '別のリストに参加する',
        run: () => {
          if (!confirm('いまのリストから離れて、別の共有コードで参加します。よろしいですか？\n（いまのリストは消えません。コードがあれば戻れます）')) return;
          lsSet(HID_KEY, null);
          S.unsub.forEach(fn => fn());
          S.store = null;
          delete app.dataset.view;
          renderWelcome();
        },
      },
    ],
  });
}

function openShareSheet() {
  const code = formatCode(S.hid);
  const url = `${location.origin}${location.pathname}#join=${S.hid}`;
  const text = `買い物リスト「かいもの」に招待します。\n${url}\n\nホーム画面に追加したアプリでは、このコードで参加してください：${code}`;
  openSheet({
    title: '奥さんを招待する',
    body: `<p class="muted">このコードを相手のアプリで入力すると、同じリストを使えます。</p>
      <p class="code">${code}</p>`,
    actions: [
      navigator.share && { label: '送る（LINE・メッセージなど）', primary: true, run: () => navigator.share({ text }).catch(() => {}) },
      { label: 'コードをコピー', primary: !navigator.share, run: () => copy(S.hid, 'コードをコピーしました') },
      { label: '招待文ごとコピー', run: () => copy(text, '招待文をコピーしました') },
    ],
  });
}

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { toast('コピーできませんでした'); }
}

// ---- 部品 ---------------------------------------------------------------------

function openSheet({ title, body = '', input, actions }) {
  const root = $('#sheet-root');
  const acts = actions.filter(Boolean);
  root.innerHTML = `
    <div class="backdrop"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="grabber"></div>
      <h2>${esc(title)}</h2>
      ${body ? `<div class="sheet-body">${body}</div>` : ''}
      ${input ? `<form class="sheet-form"><input value="${esc(input.value ?? '')}" placeholder="${esc(input.placeholder ?? '')}" enterkeyhint="done" autocomplete="off"></form>` : ''}
      <div class="sheet-actions">
        ${acts.map((a, n) => `<button class="${a.danger ? 'danger' : a.primary ? 'primary' : 'secondary'}" data-n="${n}">${esc(a.label)}</button>`).join('')}
        <button class="ghost" data-close>閉じる</button>
      </div>
    </div>`;
  const field = $('.sheet-form input', root);
  const close = () => {
    root.classList.remove('show');
    setTimeout(() => { if (!root.classList.contains('show')) root.innerHTML = ''; }, 250);
  };
  const run = n => {
    const v = field ? field.value.trim() : undefined;
    close();
    acts[n].run(v);
  };
  requestAnimationFrame(() => root.classList.add('show'));
  $('.backdrop', root).onclick = close;
  $('[data-close]', root).onclick = close;
  root.querySelectorAll('[data-n]').forEach(b => { b.onclick = () => run(+b.dataset.n); });
  if (field) {
    $('.sheet-form', root).onsubmit = e => {
      e.preventDefault();
      const first = acts.findIndex(a => a.primary);
      if (first >= 0) run(first);
    };
    // 新規入力のときだけキーボードを出す（名前の変更では勝手に出さない）
    if (!input.value) setTimeout(() => field.focus(), 60);
  }
}

// リストの行を長押ししたら fn(行) を呼ぶ。通常のタップとは区別する
function onLongPress(list, fn) {
  let timer = null, sx = 0, sy = 0, fired = false;
  list.addEventListener('pointerdown', e => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    fired = false; sx = e.clientX; sy = e.clientY;
    row.classList.add('pressing');
    timer = setTimeout(() => {
      fired = true;
      row.classList.remove('pressing');
      navigator.vibrate?.(10);
      fn(row);
    }, 480);
  });
  const cancel = () => {
    clearTimeout(timer);
    list.querySelectorAll('.pressing').forEach(r => r.classList.remove('pressing'));
  };
  list.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(n => list.addEventListener(n, cancel));
  list.addEventListener('click', e => {
    if (fired) { e.preventDefault(); e.stopImmediatePropagation(); fired = false; }
  }, true);
  list.addEventListener('contextmenu', e => e.preventDefault());
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function updateOffline() {
  const bar = $('.offline');
  if (bar) bar.hidden = !(S.store?.mode === 'shared' && !navigator.onLine);
}

function icon(name) {
  const p = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    chev: '<path d="M9 5l7 7-7 7"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    check: '<path d="M6 12.5l4 4 8-9"/>',
    undo: '<path d="M9 7L5 11l4 4"/><path d="M5 11h9a5 5 0 010 10h-2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  }[name];
  return `<svg class="i i-${name}" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
}

// ホーム画面に追加したとき、電波がなくても開けるようにする（開発中の localhost では使わない）
if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
