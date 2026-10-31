import { firebaseConfig } from './firebase-config.js';
import {
  createLocalStore, createDeferredStore, connectFirebase, localSnapshot,
  newHouseholdCode, formatCode, parseCode,
} from './data.js';

const APP_NAME = 'タスクネスト';
const HID_KEY = 'kaimono.household';
const DONE_OPEN_KEY = 'kaimono.doneOpen';
const AUTO_KEY = 'kaimono.autobackup';
const VIEW_CACHE_KEY = 'kaimono.viewcache';
const TRASH_DAYS = 30;
const AUTO_DAYS = 7;
const DAY = 86400000;

// 親リストのひな形。子の呼び名と、空のときに出す候補が変わる
const TEMPLATES = {
  shopping: { name: '買い物リスト', child: 'お店', starters: ['スーパー', 'ドラッグストア', '100円ショップ', 'ホームセンター'] },
  todo: { name: 'やること', child: 'カテゴリー', starters: ['家事', '手続き', '子ども', '仕事'] },
};
const tpl = list => TEMPLATES[list?.template] ?? { child: 'カテゴリー', starters: [] };

// データの3階層：lists（親）→ stores（子：お店・カテゴリー）→ items（孫：タスク）
// stores という名前は初版の名残。Firestore 上の置き場所を変えないためそのままにしている
const S = {
  store: null,
  fb: null,
  hid: null,
  lists: [], stores: [], items: [],
  ready: {},
  unsub: [],
  gesture: false,   // スワイプ・並び替えの最中は描き直しを待たせる
  pending: false,
  purged: false,
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
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---- データの見え方 -----------------------------------------------------------

const alive = x => !x.deletedAt;
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
const itemKey = i => i.order ?? i.addedAt ?? 0;

const listById = id => S.lists.find(l => l.id === id && alive(l));
const groupById = id => {
  const g = S.stores.find(x => x.id === id && alive(x));
  return g && listById(g.listId) ? g : null;
};
const listsV = () => S.lists.filter(alive).sort(byOrder);
const groupsOf = lid => S.stores.filter(g => alive(g) && g.listId === lid).sort(byOrder);
const itemsOf = gid => S.items.filter(i => alive(i) && i.storeId === gid);
const todoOf = gid => itemsOf(gid).filter(i => !i.done).sort((a, b) => itemKey(a) - itemKey(b));
const doneOf = gid => itemsOf(gid).filter(i => i.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
const nextOrder = rows => Math.max(0, ...rows.map(r => r.order ?? 0)) + 1;

// ---- 起動 -------------------------------------------------------------------

async function boot() {
  window.addEventListener('kaimono:error', e => {
    console.error(e.detail);
    toast('うまく保存できませんでした。通信状態を確認してください');
  });
  window.addEventListener('hashchange', render);
  window.addEventListener('online', updateOffline);
  window.addEventListener('offline', updateOffline);
  document.addEventListener('pointerdown', closeOpenRowOnOutside, true);

  // ?local を付けて開くと、共有せずこの端末だけで動く（動作確認用）
  if (!firebaseConfig || new URLSearchParams(location.search).has('local')) {
    useStore(createLocalStore());
    return;
  }

  S.hid = lsGet(HID_KEY, null);
  const joinFromLink = parseCode(location.hash);
  if (joinFromLink) history.replaceState(null, '', location.pathname);

  // 前回の表示内容があれば、サーバーにつながるのを待たずに先に出す
  const cached = !joinFromLink && S.hid ? readViewCache(S.hid) : null;
  const early = cached && createDeferredStore(cached);
  if (early) useStore(early);

  try {
    S.fb = await connectFirebase(firebaseConfig);
  } catch (err) {
    console.error(err);
    if (early) return toast('サーバーにつながっていません。電波のよい場所で開き直してください');
    app.innerHTML = `<div class="welcome"><h1>${APP_NAME}</h1>
      <p>共有サーバーにつながりませんでした。<br>電波のよい場所でもう一度開いてください。</p>
      <button class="primary" onclick="location.reload()">もう一度</button></div>`;
    return;
  }

  if (joinFromLink && joinFromLink !== S.hid) return renderWelcome(joinFromLink);
  if (!S.hid) return renderWelcome();
  if (!early) return openHousehold(S.hid);
  const real = S.fb.open(S.hid);
  early.attach(real);
  useStore(real); // 本物のデータがそろうまでは、いまの画面をそのまま見せておく
}

function readViewCache(hid) {
  try {
    const c = JSON.parse(lsGet(VIEW_CACHE_KEY, 'null'));
    return c?.hid === hid ? c : null;
  } catch { return null; }
}

let viewCacheTimer;
function saveViewCache() {
  if (S.store?.mode !== 'shared' || !S.hid) return;
  clearTimeout(viewCacheTimer);
  viewCacheTimer = setTimeout(() => lsSet(VIEW_CACHE_KEY,
    JSON.stringify({ hid: S.hid, lists: S.lists, stores: S.stores, items: S.items })), 600);
}

function useStore(store) {
  S.unsub.forEach(fn => fn());
  S.store = store;
  S.ready = {};
  S.unsub = ['lists', 'stores', 'items'].map(coll =>
    store.subscribe(coll, rows => { S[coll] = rows; S.ready[coll] = true; refresh(); }));
}

const isReady = () => S.store && S.ready.lists && S.ready.stores && S.ready.items;

function openHousehold(code) {
  S.hid = code;
  lsSet(HID_KEY, code);
  useStore(S.fb.open(code));
}

// 初版のデータ（親リストがないお店）を「買い物リスト」の下へ入れる。2台で同時に走っても結果は同じ
function migrate() {
  const orphans = S.stores.filter(g => !g.listId);
  if (!orphans.length) return;
  if (!S.lists.some(l => l.id === 'shopping')) {
    S.store.add('lists', { id: 'shopping', name: '買い物リスト', template: 'shopping', order: 1, createdAt: Date.now() });
  }
  orphans.forEach(g => S.store.update('stores', g.id, { listId: 'shopping' }));
}

// ゴミ箱に入れて30日たったものを完全に消す（中身ごと）
function purge() {
  if (S.purged) return;
  S.purged = true;
  const old = x => x.deletedAt && x.deletedAt < Date.now() - TRASH_DAYS * DAY;
  hardDelete(S.lists.filter(old).map(l => l.id), S.stores.filter(old).map(g => g.id), S.items.filter(old).map(i => i.id));
}

function hardDelete(listIds, groupIds, itemIds) {
  const gids = new Set([...groupIds, ...S.stores.filter(g => listIds.includes(g.listId)).map(g => g.id)]);
  const iids = new Set([...itemIds, ...S.items.filter(i => gids.has(i.storeId)).map(i => i.id)]);
  if (iids.size) S.store.remove('items', [...iids]);
  if (gids.size) S.store.remove('stores', [...gids]);
  if (listIds.length) S.store.remove('lists', listIds);
}

// ---- 共有のはじめかた ---------------------------------------------------------

function renderWelcome(prefill = '') {
  delete app.dataset.view;
  app.innerHTML = `
    <div class="welcome">
      <div class="welcome-mark" aria-hidden="true"></div>
      <h1>${APP_NAME}</h1>
      <p>リストを、ふたりで共有できます。</p>
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

function route() {
  let m;
  if ((m = location.hash.match(/^#\/g\/([\w-]+)/))) return { view: 'group', id: m[1] };
  if ((m = location.hash.match(/^#\/l\/([\w-]+)/))) return { view: 'list', id: m[1] };
  return { view: 'home', id: '' };
}

function render() {
  if (!isReady()) return;
  migrate();
  purge();
  openRow = null;
  const r = route();
  if (r.view === 'group') renderGroup(r.id);
  else if (r.view === 'list') renderList(r.id);
  else renderHome();
  updateOffline();
}

// データが変わったとき、入力中の文字やフォーカスを壊さないよう一覧だけ描き直す
function refresh() {
  if (!isReady()) return;
  scheduleAutoBackup();
  saveViewCache();
  if (S.gesture) { S.pending = true; return; }
  migrate();
  const r = route();
  if (app.dataset.view !== r.view || (app.dataset.id ?? '') !== r.id) return render();
  openRow = null;
  if (r.view === 'home') fillHome();
  else if (r.view === 'list') listById(r.id) ? fillList() : (location.hash = '');
  else groupById(r.id) ? fillGroup() : (location.hash = '');
}

function flush() {
  S.gesture = false;
  if (S.pending) { S.pending = false; refresh(); }
}

function setView(view, id = '') {
  app.dataset.view = view;
  app.dataset.id = id;
}

// ---- 共通の行 ---------------------------------------------------------------

// スワイプで出るボタン。右へスワイプ＝左側に 移動、左へスワイプ＝右側に 名前・削除
function rowActs(move) {
  return `
    <div class="acts acts-start">${move ? `<button class="act act-move" data-act="move">${icon('move')}移動</button>` : ''}</div>
    <div class="acts acts-end">
      <button class="act act-rename" data-act="rename">${icon('pen')}名前</button>
      <button class="act act-del" data-act="delete">${icon('trash')}削除</button>
    </div>`;
}

function cardRow({ id, name, sub, count, move }) {
  return `
    <li class="row card" data-id="${id}">
      ${rowActs(move)}
      <div class="row-content">
        <div class="card-main">
          <span class="card-name">${esc(name)}</span>
          <span class="card-sub">${esc(sub)}</span>
        </div>
        ${count ? `<span class="count">${count}</span>` : ''}
        <span class="chev">${icon('chev')}</span>
      </div>
    </li>`;
}

function itemRow(i) {
  return `
    <li class="row item${i.done ? ' is-done' : ''}" data-id="${i.id}">
      ${rowActs(true)}
      <div class="row-content">
        <span class="check" aria-hidden="true">${icon('check')}</span>
        <span class="item-name">${esc(i.name)}</span>
      </div>
    </li>`;
}

const hint = move => `左へスワイプで 名前の変更・削除${move ? '、右へスワイプで 移動' : ''}<br>長押しして持ち上げると並び替え`;

function header({ back, title, large, menu }) {
  return `
    <header class="bar">
      ${back ? `<button class="back" id="back">${icon('back')}<span>${esc(back)}</span></button>` : ''}
      <h1 class="${large ? 'title-lg' : 'title'}" id="title">${esc(title)}</h1>
      <button class="icon-btn" id="menu" aria-label="${menu}">${icon(large ? 'gear' : 'more')}</button>
    </header>
    <div class="offline" hidden>オフライン — 電波が戻ると自動で同期します</div>`;
}

// ---- ホーム（親リストの一覧） -------------------------------------------------

function renderHome() {
  setView('home');
  app.innerHTML = `
    ${header({ title: APP_NAME, large: true, menu: '設定' })}
    <main>
      <ul class="cards" id="rows"></ul>
      <div class="empty" id="empty" hidden>
        <p>まずはリストを作りましょう</p>
        <div class="chips">${Object.entries(TEMPLATES).map(([k, t]) =>
          `<button class="chip" data-tpl="${k}">${icon('plus')}${esc(t.name)}</button>`).join('')}</div>
      </div>
      <p class="hint" id="hint">${hint(false)}</p>
    </main>
    <footer class="dock">
      <button class="primary wide" id="add">${icon('plus')}リストを追加</button>
    </footer>`;

  $('#menu').onclick = openSettings;
  $('#add').onclick = addListSheet;
  $('#empty').onclick = e => {
    const b = e.target.closest('[data-tpl]');
    if (b) addList(TEMPLATES[b.dataset.tpl].name, b.dataset.tpl);
  };

  gestures($('#rows'), {
    onTap: row => { location.hash = `#/l/${row.dataset.id}`; },
    onRename: row => renameSheet('lists', row.dataset.id),
    onDelete: row => softDelete('lists', row.dataset.id),
    onReorder: (id, prev, next) => reorder('lists', listsV(), id, prev, next, x => x.order ?? 0),
  });
  fillHome();
}

function fillHome() {
  const lists = listsV();
  $('#empty').hidden = lists.length > 0;
  $('#hint').hidden = lists.length === 0;
  $('#rows').innerHTML = lists.map(l => {
    const groups = groupsOf(l.id);
    const n = groups.reduce((sum, g) => sum + todoOf(g.id).length, 0);
    const sub = groups.length
      ? groups.slice(0, 4).map(g => g.name).join('・') + (groups.length > 4 ? ' …' : '')
      : `${tpl(l).child}はまだありません`;
    return cardRow({ id: l.id, name: l.name, sub, count: n });
  }).join('');
}

function addListSheet() {
  openSheet({
    title: 'リストを追加',
    body: `<div class="chips">${Object.entries(TEMPLATES).map(([k, t]) =>
      `<button class="chip" data-tpl="${k}">${esc(t.name)}</button>`).join('')}</div>`,
    input: { placeholder: '例：旅行の準備' },
    actions: [{ label: '追加', primary: true, run: v => v && addList(v, Object.entries(TEMPLATES).find(([, t]) => t.name === v)?.[0]) }],
    onOpen: (root, close) => {
      root.querySelector('.sheet-body').onclick = e => {
        const b = e.target.closest('[data-tpl]');
        if (!b) return;
        close();
        addList(TEMPLATES[b.dataset.tpl].name, b.dataset.tpl);
      };
    },
  });
}

function addList(name, template) {
  const doc = { name: name.trim(), order: nextOrder(S.lists), createdAt: Date.now() };
  if (template) doc.template = template;
  S.store.add('lists', doc);
}

// ---- リストの中（お店・カテゴリーの一覧） -----------------------------------

function renderList(id) {
  const l = listById(id);
  if (!l) { location.hash = ''; return; }
  setView('list', id);
  const t = tpl(l);
  app.innerHTML = `
    ${header({ back: 'リスト', title: l.name, menu: 'リストの設定' })}
    <main>
      <ul class="cards" id="rows"></ul>
      <div class="empty" id="empty" hidden>
        <p>${esc(t.child)}を追加しましょう</p>
        <div class="chips">${t.starters.map(n =>
          `<button class="chip" data-starter="${esc(n)}">${icon('plus')}${esc(n)}</button>`).join('')}</div>
      </div>
      <p class="hint" id="hint">${hint(true)}</p>
    </main>
    <footer class="dock">
      <button class="primary wide" id="add">${icon('plus')}${esc(t.child)}を追加</button>
    </footer>`;

  $('#back').onclick = () => { location.hash = ''; };
  $('#menu').onclick = () => renameSheet('lists', id);
  $('#add').onclick = () => openSheet({
    title: `${t.child}を追加`,
    input: { placeholder: t.starters[0] ? `例：${t.starters[0]}` : '名前' },
    actions: [{ label: '追加', primary: true, run: v => v && addGroup(id, v) }],
  });
  $('#empty').onclick = e => {
    const b = e.target.closest('[data-starter]');
    if (b) addGroup(id, b.dataset.starter);
  };

  gestures($('#rows'), {
    onTap: row => { location.hash = `#/g/${row.dataset.id}`; },
    onRename: row => renameSheet('stores', row.dataset.id),
    onDelete: row => softDelete('stores', row.dataset.id),
    onMove: row => moveGroupSheet(row.dataset.id),
    onReorder: (gid, prev, next) => reorder('stores', groupsOf(id), gid, prev, next, x => x.order ?? 0),
  });
  fillList();
}

function fillList() {
  const l = listById(app.dataset.id);
  $('#title').textContent = l.name;
  const groups = groupsOf(l.id);
  $('#empty').hidden = groups.length > 0;
  $('#hint').hidden = groups.length === 0;
  $('#rows').innerHTML = groups.map(g => {
    const todo = todoOf(g.id);
    const sub = todo.length
      ? todo.slice(0, 4).map(i => i.name).join('・') + (todo.length > 4 ? ' …' : '')
      : 'タスクはありません';
    return cardRow({ id: g.id, name: g.name, sub, count: todo.length, move: true });
  }).join('');
}

function addGroup(listId, name) {
  S.store.add('stores', { listId, name: name.trim(), order: nextOrder(groupsOf(listId)), createdAt: Date.now() });
}

function moveGroupSheet(gid) {
  const g = groupById(gid);
  const others = listsV().filter(l => l.id !== g.listId);
  if (!others.length) return toast('移動先のリストがありません');
  openSheet({
    title: `「${g.name}」の移動先`,
    actions: others.map(l => ({
      label: l.name,
      run: () => {
        S.store.update('stores', gid, { listId: l.id, order: nextOrder(groupsOf(l.id)) });
        toast(`「${l.name}」へ移しました`);
      },
    })),
  });
}

// ---- お店・カテゴリーの中（タスク） ------------------------------------------

function renderGroup(id) {
  const g = groupById(id);
  if (!g) { location.hash = ''; return; }
  setView('group', id);
  const l = listById(g.listId);
  app.innerHTML = `
    ${header({ back: l.name, title: g.name, menu: `${tpl(l).child}の設定` })}
    <form class="composer" id="composer" autocomplete="off">
      <input id="new-item" placeholder="${l.template === 'shopping' ? '買うものを追加' : 'タスクを追加'}" enterkeyhint="done" autocomplete="off">
      <button type="submit" class="add-btn" aria-label="追加">${icon('plus')}</button>
    </form>
    <div class="suggest" id="suggest" hidden></div>
    <main>
      <ul class="items" id="todo"></ul>
      <div class="empty small" id="todo-empty" hidden><p>タスクはありません</p></div>
      <section id="done-wrap" hidden>
        <button class="done-head" id="done-toggle"><span id="done-label"></span><span class="chev-s">${icon('chev')}</span></button>
        <ul class="items done" id="done"></ul>
      </section>
      <p class="hint">${hint(true)}</p>
    </main>`;

  $('#back').onclick = () => { location.hash = `#/l/${groupById(id)?.listId ?? ''}`; };
  $('#menu').onclick = () => groupMenu(id);

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

  const common = {
    onTap: row => toggleItem(row),
    onRename: row => renameSheet('items', row.dataset.id),
    onDelete: row => softDelete('items', row.dataset.id),
    onMove: row => moveItemSheet(row.dataset.id),
  };
  gestures($('#todo'), {
    ...common,
    onReorder: (iid, prev, next) => reorder('items', todoOf(id), iid, prev, next, itemKey),
  });
  gestures($('#done'), common);

  $('#done-toggle').onclick = () => {
    lsSet(DONE_OPEN_KEY, lsGet(DONE_OPEN_KEY, '1') === '1' ? '0' : '1');
    fillGroup();
  };
  fillGroup();
}

function fillGroup() {
  const id = app.dataset.id;
  const g = groupById(id);
  $('#title').textContent = g.name;
  $('#back span').textContent = listById(g.listId).name;
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

// 入力中は、そのお店・カテゴリーで前に完了したものを候補に出す
function fillSuggest() {
  const box = $('#suggest');
  if (!box) return;
  const id = app.dataset.id;
  const q = norm($('#new-item').value);
  const done = doneOf(id);
  let hits, head;
  if (!q) {
    hits = done.slice(0, 16);
    head = '最近完了したもの';
  } else {
    const starts = i => norm(i.name).startsWith(q);
    hits = done.filter(i => norm(i.name).includes(q))
      .sort((a, b) => starts(b) - starts(a))
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

function addItem(gid, name) {
  const key = norm(name);
  const same = itemsOf(gid).find(i => norm(i.name) === key);
  if (same && !same.done) { toast(`「${same.name}」はリストにあります`); return; }
  if (same) { revive(same.id); return; }
  const now = Date.now();
  S.store.add('items', { storeId: gid, name, done: false, order: now, addedAt: now, doneAt: null });
}

function revive(id) {
  const now = Date.now();
  S.store.update('items', id, { done: false, order: now, addedAt: now, doneAt: null });
}

function toggleItem(row) {
  const i = S.items.find(x => x.id === row.dataset.id);
  if (!i) return;
  if (i.done) return revive(i.id);
  // チェックの動きを一瞬見せてから下へ移す
  row.classList.add('is-done', 'settling');
  setTimeout(() => S.store.update('items', i.id, { done: true, doneAt: Date.now() }), 260);
}

function moveItemSheet(iid) {
  const i = S.items.find(x => x.id === iid);
  const targets = listsV().flatMap(l => {
    const gs = groupsOf(l.id).filter(g => g.id !== i.storeId);
    return gs.length ? [{ heading: l.name }, ...gs.map(g => ({
      label: g.name,
      run: () => {
        S.store.update('items', iid, { storeId: g.id, order: Date.now() });
        toast(`「${g.name}」へ移しました`);
      },
    }))] : [];
  });
  if (!targets.length) return toast('移動先がありません');
  openSheet({ title: `「${i.name}」の移動先`, actions: targets });
}

function groupMenu(id) {
  const g = groupById(id);
  const history = doneOf(id);
  openSheet({
    title: g.name,
    actions: [
      { label: '名前を変更', primary: true, run: () => setTimeout(() => renameSheet('stores', id), 280) },
      history.length && {
        label: `完了済みを消す（${history.length}件）`,
        run: () => {
          const now = Date.now();
          history.forEach(i => S.store.update('items', i.id, { deletedAt: now }));
          toast(`${history.length}件をゴミ箱へ移しました`, {
            label: '元に戻す', run: () => history.forEach(i => S.store.update('items', i.id, { deletedAt: null })),
          });
        },
      },
    ],
  });
}

// ---- 名前の変更・並び替え・削除（3階層で共通） -------------------------------

function renameSheet(coll, id) {
  const x = (S[coll] ?? []).find(r => r.id === id);
  if (!x) return;
  openSheet({
    title: '名前を変更',
    input: { value: x.name, placeholder: '名前' },
    actions: [{ label: '保存', primary: true, run: v => v && v !== x.name && S.store.update(coll, id, { name: v }) }],
  });
}

// 前後の行のあいだの値を付けて、書き込みを1件で済ませる
function reorder(coll, rows, id, prevId, nextId, key) {
  const others = rows.filter(r => r.id !== id);
  const prev = others.find(r => r.id === prevId);
  const next = others.find(r => r.id === nextId);
  let v;
  if (prev && next) v = (key(prev) + key(next)) / 2;
  else if (prev) v = key(prev) + 1;
  else if (next) v = key(next) - 1;
  else return;
  if ((prev && v === key(prev)) || (next && v === key(next))) {
    // 間が詰まりすぎたら振り直す
    const pos = prev ? others.indexOf(prev) + 1 : 0;
    others.splice(pos, 0, { id });
    others.forEach((r, n) => S.store.update(coll, r.id, { order: n + 1 }));
    return;
  }
  S.store.update(coll, id, { order: v });
}

// 消してもすぐには消さない。30日はゴミ箱から戻せる
function softDelete(coll, id) {
  const x = S[coll].find(r => r.id === id);
  if (!x) return;
  S.store.update(coll, id, { deletedAt: Date.now() });
  toast(`「${x.name}」を削除しました`, { label: '元に戻す', run: () => S.store.update(coll, id, { deletedAt: null }) });
}

// ---- 設定・共有・データを守る -------------------------------------------------

function openSettings() {
  const shared = S.store.mode === 'shared';
  const trash = trashRows();
  openSheet({
    title: '設定',
    body: shared
      ? `<p>ふたりで共有しています。</p>
         <p class="muted">共有コード（機種変更のときに必要です。メモ帳などに控えておいてください）</p>
         <p class="code">${formatCode(S.hid)}</p>`
      : `<p>いまは<strong>この端末だけ</strong>に保存しています。</p>`,
    actions: [
      shared && { label: '招待する（コードを送る）', primary: true, run: () => setTimeout(openShareSheet, 280) },
      { heading: 'データを守る' },
      { label: `ゴミ箱（${trash.length}件）`, run: () => setTimeout(openTrash, 280) },
      { label: 'バックアップを保存', run: exportBackup },
      { label: 'バックアップから戻す', run: importBackup },
      { label: '自動バックアップから戻す', run: () => setTimeout(openAutoBackups, 280) },
      shared && { heading: 'そのほか' },
      shared && {
        label: '別の共有リストに参加する',
        run: () => {
          if (!confirm('いまのリストから離れて、別の共有コードで参加します。よろしいですか？\n（いまのリストは消えません。コードがあれば戻れます）')) return;
          lsSet(HID_KEY, null);
          S.unsub.forEach(fn => fn());
          S.store = null;
          renderWelcome();
        },
      },
    ],
  });
}

function openShareSheet() {
  const code = formatCode(S.hid);
  const url = `${location.origin}${location.pathname}#join=${S.hid}`;
  const text = `${APP_NAME}に招待します。\n${url}\n\nホーム画面に追加したアプリでは、このコードで参加してください：${code}`;
  openSheet({
    title: '招待する',
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

// 自分で消されたもの（親ごと消されたものは親の行にまとめる）
function trashRows() {
  const lists = S.lists.filter(l => l.deletedAt)
    .map(l => ({ coll: 'lists', x: l, where: 'リスト' }));
  const groups = S.stores.filter(g => g.deletedAt && listById(g.listId))
    .map(g => ({ coll: 'stores', x: g, where: listById(g.listId).name }));
  const items = S.items.filter(i => i.deletedAt && groupById(i.storeId))
    .map(i => ({ coll: 'items', x: i, where: groupById(i.storeId).name }));
  return [...lists, ...groups, ...items].sort((a, b) => b.x.deletedAt - a.x.deletedAt);
}

function openTrash() {
  const rows = trashRows();
  const left = x => Math.max(1, Math.ceil((x.deletedAt + TRASH_DAYS * DAY - Date.now()) / DAY));
  openSheet({
    title: 'ゴミ箱',
    body: rows.length
      ? `<p class="muted">削除してから${TRASH_DAYS}日たつと、完全に消えます。</p>
         <ul class="trash">${rows.map((r, n) => `
           <li><div><span>${esc(r.x.name)}</span><small>${esc(r.where)} ・ あと${left(r.x)}日</small></div>
           <button class="chip" data-restore="${n}">${icon('undo')}戻す</button></li>`).join('')}</ul>`
      : '<p class="muted">ゴミ箱は空です。</p>',
    actions: [
      rows.length && {
        label: 'ゴミ箱を空にする', danger: true,
        run: () => confirm(`${rows.length}件を完全に消します。元に戻せません。よろしいですか？`) && hardDelete(
          rows.filter(r => r.coll === 'lists').map(r => r.x.id),
          rows.filter(r => r.coll === 'stores').map(r => r.x.id),
          rows.filter(r => r.coll === 'items').map(r => r.x.id)),
      },
    ],
    onOpen: root => {
      root.querySelector('.trash')?.addEventListener('click', e => {
        const b = e.target.closest('[data-restore]');
        if (!b) return;
        const r = rows[+b.dataset.restore];
        S.store.update(r.coll, r.x.id, { deletedAt: null });
        b.closest('li').remove();
        toast(`「${r.x.name}」を戻しました`);
      });
    },
  });
}

function snapshot() {
  return { app: 'kaimono', version: 2, at: Date.now(), lists: S.lists, stores: S.stores, items: S.items };
}
const countOf = d => (d.lists?.length ?? 0) + (d.stores?.length ?? 0) + (d.items?.length ?? 0);

// 端末の中に、1日1つ・7日分のバックアップを自動で残す
let autoTimer;
function scheduleAutoBackup() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(saveAutoBackup, 3000);
}

function readAuto() {
  try { return JSON.parse(lsGet(AUTO_KEY, '[]')) || []; } catch { return []; }
}

function saveAutoBackup() {
  const snap = snapshot();
  const today = ymd(new Date());
  let arr = readAuto();
  const i = arr.findIndex(b => b.date === today);
  // 空になった状態で、その日の中身のあるバックアップを上書きしない
  if (i >= 0 && countOf(snap) === 0 && countOf(arr[i].data) > 0) return;
  const entry = { date: today, data: snap };
  if (i >= 0) arr[i] = entry; else arr.push(entry);
  arr = arr.sort((a, b) => b.date.localeCompare(a.date)).slice(0, AUTO_DAYS);
  while (arr.length) {
    try { localStorage.setItem(AUTO_KEY, JSON.stringify(arr)); return; } catch { arr.pop(); }
  }
}

function openAutoBackups() {
  const arr = readAuto();
  const summary = d => `リスト${d.lists?.filter(alive).length ?? 0}・タスク${d.items?.filter(alive).length ?? 0}件`;
  openSheet({
    title: '自動バックアップ',
    body: `<p class="muted">この端末に、毎日の最後の状態を${AUTO_DAYS}日分残しています。戻すと、その日の状態を上書きで書き戻します（その後に追加したものは残ります）。</p>`,
    actions: arr.length ? arr.map(b => ({
      label: `${b.date.slice(5).replace('-', '/')}（${summary(b.data)}）`,
      run: () => confirm(`${b.date} の状態に戻します。よろしいですか？`) && restore(b.data),
    })) : [{ heading: 'まだありません' }],
  });
}

async function exportBackup() {
  const name = `kaimono-backup-${ymd(new Date())}.json`;
  const file = new File([JSON.stringify(snapshot())], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    try {
      const d = JSON.parse(await input.files[0].text());
      if (d.app !== 'kaimono' || !Array.isArray(d.items)) throw new Error('format');
      if (confirm(`${new Date(d.at).toLocaleString('ja-JP')} のバックアップを書き戻します。よろしいですか？`)) restore(d);
    } catch {
      toast('このファイルは読み込めませんでした');
    }
  };
  input.click();
}

function restore(d) {
  ['lists', 'stores', 'items'].forEach(coll => (d[coll] ?? []).forEach(x => S.store.add(coll, x)));
  toast('書き戻しました');
}

// ---- 行のジェスチャー -------------------------------------------------------
// タップ／左へスワイプ＝名前・削除／右へスワイプ＝移動／長押しして持ち上げる＝並び替え

const ACT_W = 72;
const LIFT_MS = 380;
const EASE = 'cubic-bezier(.25, 1, .5, 1)';
let openRow = null;

// 行を横にずらし、空いた幅にだけボタンを出す（ボタンを行の下に敷かないので、どこからも透けない）。
// dur を付けると、そこまで減速しながら滑らかに動く
function setRowOffset(row, x, dur = 0) {
  const c = $('.row-content', row);
  const start = $('.acts-start', row);
  const end = $('.acts-end', row);
  const t = dur ? `${dur}ms ${EASE}` : '';
  clearTimeout(row._t);
  c.style.transition = t && `transform ${t}, background .15s ease`;
  start.style.transition = end.style.transition = t && `width ${t}`;
  c.style.transform = x ? `translate3d(${x}px, 0, 0)` : '';
  start.style.width = `${Math.max(0, x)}px`;
  end.style.width = `${Math.max(0, -x)}px`;
  if (dur) row._t = setTimeout(() => { c.style.transition = start.style.transition = end.style.transition = ''; }, dur + 20);
}

// 開いた位置（右へ開く・閉じる・左へ開く）に収める。開いておけるのは1行だけ
function settleRow(row, x, dur = 320) {
  if (x && openRow && openRow !== row) settleRow(openRow, 0);
  if (x) openRow = row;
  else if (openRow === row) openRow = null;
  row.dataset.x = x;
  setRowOffset(row, x, dur);
}
const closeRow = (row, dur) => settleRow(row, 0, dur);
const sideW = acts => acts.children.length * ACT_W;

// ほかの場所に触れたら、開いている行を閉じる（開いている行そのものは指で押し戻せる）
function closeOpenRowOnOutside(e) {
  if (!openRow || e.target.closest('[data-act]') || openRow.contains(e.target)) return;
  closeRow(openRow);
  e.kmClosed = true; // このタップでは行の操作をしない
}

function gestures(list, o) {
  let st = null;

  list.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const row = b.closest('.row');
    closeRow(row, 260);
    ({ rename: o.onRename, move: o.onMove, delete: o.onDelete })[b.dataset.act]?.(row);
  });

  list.addEventListener('pointerdown', e => {
    if (e.kmClosed || e.button > 0 || e.target.closest('[data-act]')) return;
    const row = e.target.closest('.row');
    if (!row) return;
    try { list.setPointerCapture(e.pointerId); } catch {}
    const base = +row.dataset.x || 0;
    st = {
      row, x0: e.clientX, y0: e.clientY, sy0: scrollY, mode: 'pending', base,
      startW: sideW($('.acts-start', row)), endW: sideW($('.acts-end', row)),
    };
    if (base) return; // 開いている行は、押し戻すか、タップで閉じるだけ
    row.classList.add('pressing');
    if (!o.onReorder) return;
    st.timer = setTimeout(() => {
      if (st?.mode !== 'pending') return;
      st.mode = 'lifted';
      S.gesture = true;
      row.classList.remove('pressing');
      row.classList.add('lifted');
      list.classList.add('sorting');
    }, LIFT_MS);
  });

  list.addEventListener('pointermove', e => {
    if (!st) return;
    const dx = e.clientX - st.x0, dy = e.clientY - st.y0;
    if (st.mode === 'pending') {
      const horizontal = Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.2;
      if (horizontal && (dx < 0 || st.startW || st.base)) {
        clearTimeout(st.timer);
        Object.assign(st, { mode: 'swipe', xs: e.clientX, samples: [] });
        S.gesture = true;
        st.row.classList.remove('pressing');
      } else if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        return reset();
      }
    }
    if (st.mode === 'swipe') {
      // 動き出した位置から数えるので、指に吸い付いたまま動く。ボタンの幅を超えたら重くなる
      const { startW, endW } = st;
      let x = st.base + (e.clientX - st.xs);
      if (x < -endW) x = -endW + (x + endW) * 0.35;
      if (x > startW) x = startW ? startW + (x - startW) * 0.35 : 0; // 右にボタンがない画面では動かさない
      st.x = x;
      st.samples.push([e.clientX, e.timeStamp]);
      if (st.samples.length > 5) st.samples.shift();
      setRowOffset(st.row, x);
    } else if (st.mode === 'lifted' && Math.hypot(dx, dy) > 4) {
      startDrag(e.clientY);
    } else if (st.mode === 'drag') {
      st.lastY = e.clientY;
      requestMove();
    }
  });

  list.addEventListener('pointerup', () => {
    if (!st) return;
    const { row, mode } = st;
    clearTimeout(st.timer);
    row.classList.remove('pressing');
    if (mode === 'pending') {
      if (st.base) closeRow(row);
      else o.onTap(row);
    } else if (mode === 'swipe') {
      finishSwipe();
    } else if (mode === 'lifted') {
      // 持ち上げただけで動かさなかった
      row.classList.remove('lifted');
      list.classList.remove('sorting');
    } else if (mode === 'drag') {
      moveDrag(); // 最後の指の位置を反映してから収める
      return endDrag();
    }
    st = null;
    flush();
  });

  // 離したときの位置と指の速さで、どこに収めるかを決める（はじけば少しの移動でも開閉する）
  function finishSwipe() {
    const { row, x = st.base, samples, startW, endW } = st;
    const a = samples[0], b = samples[samples.length - 1];
    const v = a && b && b[1] > a[1] ? (b[0] - a[0]) / (b[1] - a[1]) : 0; // px/ms、左がマイナス
    let to;
    if (v < -0.35) to = x > 0 ? 0 : -endW;
    else if (v > 0.35) to = x < 0 ? 0 : startW;
    else to = x < -endW / 2 ? -endW : startW && x > startW / 2 ? startW : 0;
    // 速くはじいたほど短い時間で収める
    const dist = Math.abs(to - x);
    const dur = Math.round(Math.max(180, Math.min(380, Math.abs(v) > 0.35 ? dist / Math.abs(v) * 1.6 : 340)));
    settleRow(row, to, dur);
  }

  list.addEventListener('pointercancel', reset);

  // 持ち上げ中・スワイプ中・並び替え中は画面をスクロールさせない
  list.addEventListener('touchmove', e => {
    if (st && st.mode !== 'pending') e.preventDefault();
  }, { passive: false });
  list.addEventListener('contextmenu', e => e.preventDefault());

  function reset() {
    if (!st) return;
    clearTimeout(st.timer);
    if (st.mode === 'drag') { st.target = st.idx; return endDrag(); }
    st.row.classList.remove('pressing', 'lifted');
    list.classList.remove('sorting');
    if (st.mode === 'swipe') closeRow(st.row);
    st = null;
    flush();
  }

  function startDrag(y) {
    const rows = [...list.children].filter(r => r.classList.contains('row'));
    const rects = rows.map(r => r.getBoundingClientRect());
    Object.assign(st, {
      mode: 'drag', rows, lastY: y,
      idx: rows.indexOf(st.row),
      centers: rects.map(r => r.top + scrollY + r.height / 2),
    });
    const gap = rows.length > 1 ? rects[1].top - rects[0].bottom : 0;
    st.step = rects[st.idx].height + gap;
    st.target = st.idx;
    rows.forEach(r => r !== st.row && r.classList.add('shifting'));
    st.row.classList.add('dragging');
    const tick = () => {
      if (!st || st.mode !== 'drag') return;
      const edge = 90;
      if (st.lastY < edge) { scrollBy(0, -10); moveDrag(); }
      else if (st.lastY > innerHeight - edge) { scrollBy(0, 10); moveDrag(); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    moveDrag();
  }

  // 指の動きは1フレームにまとめて反映する
  let raf = 0;
  function requestMove() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (st?.mode === 'drag') moveDrag(); });
  }

  function moveDrag() {
    const dy = st.lastY + scrollY - (st.y0 + st.sy0);
    st.row.style.transform = `translate3d(0, ${dy}px, 0) scale(1.03)`;
    const c = st.centers[st.idx] + dy;
    // 隣の行の真ん中より少し手前で入れ替える（指に遅れて見えないように）
    const lead = st.step * 0.15;
    let target = st.idx;
    st.rows.forEach((r, n) => {
      if (r === st.row) return;
      let shift = 0;
      if (n < st.idx && c < st.centers[n] + lead) { shift = st.step; target--; }
      else if (n > st.idx && c > st.centers[n] - lead) { shift = -st.step; target++; }
      r.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : '';
    });
    st.target = target;
  }

  // 指を離したら、収まる位置まで滑らかに動かしてから並びを確定する
  function endDrag() {
    const { rows, row, idx, target, step } = st;
    st = null;
    row.classList.add('dropping');
    row.style.transform = `translate3d(0, ${(target - idx) * step}px, 0)`;
    setTimeout(() => {
      rows.forEach(r => {
        r.classList.remove('shifting', 'dragging', 'lifted', 'dropping');
        r.style.transform = '';
      });
      list.classList.remove('sorting');
      if (target !== idx) {
        const rest = rows.filter(r => r !== row);
        list.insertBefore(row, rest[target] ?? null);
        o.onReorder(row.dataset.id, rest[target - 1]?.dataset.id, rest[target]?.dataset.id);
      }
      flush();
    }, 170);
  }
}

// ---- 部品 ---------------------------------------------------------------------

function openSheet({ title, body = '', input, actions = [], onOpen }) {
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
        ${acts.map((a, n) => a.heading
          ? `<div class="sheet-heading">${esc(a.heading)}</div>`
          : `<button class="${a.danger ? 'danger' : a.primary ? 'primary' : 'secondary'}" data-n="${n}">${esc(a.label)}</button>`).join('')}
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
    // 新規入力のときだけキーボードを出す
    if (!input.value) setTimeout(() => field.focus(), 60);
    else setTimeout(() => { field.focus(); field.select(); }, 300);
  }
  onOpen?.(root, close);
}

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  if (action) $('button', t).onclick = () => { t.classList.remove('show'); action.run(); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2200);
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
    pen: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    move: '<path d="M5 12h14M15 8l4 4-4 4"/><path d="M5 5v14"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  }[name];
  return `<svg class="i i-${name}" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
}

// ホーム画面に追加したとき、電波がなくても開けるようにする（開発中の localhost では使わない）
if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
