// データの置き場所を切り替える層。
// どちらも同じ形（subscribe / add / update / remove）を返すので、画面側は置き場所を意識しない。

export function newId() {
  const a = new Uint8Array(15);
  crypto.getRandomValues(a);
  return Array.from(a, b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

// ---- 共有コード ------------------------------------------------------------
// 紛らわしい文字（0/O、1/I/L）を除いた 32 文字 × 16 桁 ≒ 80bit。推測はまず不可能。
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newHouseholdCode() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

export function formatCode(code) {
  return code.match(/.{1,4}/g).join('-');
}

// 「ABCD-EFGH-…」でも、招待リンクごと貼られても読めるようにする
export function parseCode(text) {
  const m = String(text).match(/join=([A-Za-z0-9-]+)/);
  const raw = (m ? m[1] : text).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 16 && [...raw].every(c => CODE_CHARS.includes(c)) ? raw : null;
}

// ---- この端末だけ（localStorage） ------------------------------------------
const LOCAL_KEY = 'kaimono.local.v1';

function readLocal() {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY));
    if (v && v.stores && v.items) return { lists: {}, ...v };
  } catch {}
  return { lists: {}, stores: {}, items: {} };
}

export function localSnapshot() {
  return readLocal();
}

export function createLocalStore() {
  let data = readLocal();
  const listeners = { lists: new Set(), stores: new Set(), items: new Set() };

  const emit = coll => listeners[coll].forEach(fn => fn(Object.values(data[coll])));
  const save = coll => {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(data)); } catch {}
    emit(coll);
  };

  // 別タブで変わったとき
  window.addEventListener('storage', e => {
    if (e.key !== LOCAL_KEY) return;
    data = readLocal();
    Object.keys(listeners).forEach(emit);
  });

  return {
    mode: 'local',
    subscribe(coll, fn) {
      listeners[coll].add(fn);
      fn(Object.values(data[coll]));
      return () => listeners[coll].delete(fn);
    },
    add(coll, obj) {
      const id = obj.id || newId();
      data[coll][id] = { ...obj, id };
      save(coll);
      return id;
    },
    update(coll, id, patch) {
      if (!data[coll][id]) return;
      data[coll][id] = { ...data[coll][id], ...patch };
      save(coll);
    },
    remove(coll, ids) {
      [].concat(ids).forEach(id => delete data[coll][id]);
      save(coll);
    },
  };
}

// ---- 夫婦で共有（Firebase） -------------------------------------------------
const FB = 'https://www.gstatic.com/firebasejs/10.14.1';

export async function connectFirebase(config) {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-auth.js`),
    import(`${FB}/firebase-firestore.js`),
  ]);

  const app = initializeApp(config);
  const a = auth.getAuth(app);
  await a.authStateReady();
  if (!a.currentUser) await auth.signInAnonymously(a);

  // 電波の弱いお店の中でも使えるよう、端末にもデータを持たせる
  const db = fs.initializeFirestore(app, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
  });

  return {
    async householdExists(code) {
      const snap = await fs.getDoc(fs.doc(db, 'households', code));
      return snap.exists();
    },
    async createHousehold(code, seed) {
      await fs.setDoc(fs.doc(db, 'households', code), { createdAt: Date.now() });
      if (!seed) return;
      const rows = ['lists', 'stores', 'items']
        .flatMap(coll => Object.values(seed[coll] || {}).map(v => [coll, v]));
      for (let i = 0; i < rows.length; i += 400) {
        const batch = fs.writeBatch(db);
        rows.slice(i, i + 400).forEach(([coll, v]) =>
          batch.set(fs.doc(db, 'households', code, coll, v.id), v));
        await batch.commit();
      }
    },
    open(code) {
      const col = coll => fs.collection(db, 'households', code, coll);
      const fail = err => window.dispatchEvent(new CustomEvent('kaimono:error', { detail: err }));
      return {
        mode: 'shared',
        subscribe(coll, fn) {
          return fs.onSnapshot(col(coll),
            snap => fn(snap.docs.map(d => ({ ...d.data(), id: d.id }))),
            fail);
        },
        // 書き込みはサーバーの返事を待たない（画面には即反映され、電波が戻れば送られる）
        add(coll, obj) {
          const ref = obj.id ? fs.doc(col(coll), obj.id) : fs.doc(col(coll));
          fs.setDoc(ref, { ...obj, id: ref.id }).catch(fail);
          return ref.id;
        },
        update(coll, id, patch) {
          fs.updateDoc(fs.doc(col(coll), id), patch).catch(fail);
        },
        remove(coll, ids) {
          const list = [].concat(ids);
          for (let i = 0; i < list.length; i += 400) {
            const batch = fs.writeBatch(db);
            list.slice(i, i + 400).forEach(id => batch.delete(fs.doc(col(coll), id)));
            batch.commit().catch(fail);
          }
        },
      };
    },
  };
}
