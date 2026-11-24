/**
 * PostItDB
 * IndexedDB を使った付箋の永続化と、削除モード用の2段階削除（論理削除スタック → 一括物理削除）を管理するモジュール
 */
const PostItDB = (() => {
  const DB_NAME = 'PostItAppDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'notes';

  let dbInstance = null;
  // 論理削除された付箋IDを一時保持するスタック（LIFO）
  let pendingDeleteStack = [];

  /**
   * IndexedDB を開く（初回のみストア作成）
   */
  function openDB() {
    if (dbInstance) {
      return Promise.resolve(dbInstance);
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('dueDate', 'dueDate', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        dbInstance = event.target.result;
        resolve(dbInstance);
      };

      request.onerror = (event) => {
        reject(new Error(`IndexedDB 接続エラー: ${event.target.error?.message || '不明なエラー'}`));
      };
    });
  }

  /**
   * 新規付箋の初期データオブジェクトを生成
   */
  function createNoteData({ x = 40, y = 40, zIndex = 1, color = '#fff59d' } = {}) {
    const now = new Date().toISOString();
    const randomPart = Math.random().toString(36).slice(2, 6);
    return {
      id: `note_${Date.now()}_${randomPart}`,
      mode: 'text',        // 'text' | 'handwriting'
      text: '',
      drawingData: null,   // PNG DataURL
      x,
      y,
      zIndex,
      color,
      dueDate: null,       // 'YYYY-MM-DD' または null
      createdAt: now,
      updatedAt: now
    };
  }

  /**
   * 保存済みの全付箋を取得
   */
  async function getAllNotes() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 付箋を1件保存（新規作成・更新の両方に対応）
   */
  async function saveNote(note) {
    const db = await openDB();
    const record = {
      ...note,
      updatedAt: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(record);

      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('保存トランザクションが中断されました'));
    });
  }

  /**
   * 指定されたID配列の付箋を IndexedDB から一括物理削除
   */
  async function deleteNotesPhysical(ids) {
    if (!ids || ids.length === 0) {
      return [];
    }

    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      for (const id of ids) {
        store.delete(id);
      }

      tx.oncomplete = () => resolve([...ids]);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('削除トランザクションが中断されました'));
    });
  }

  /* =========================================================
   * 削除モード用：2段階削除（論理削除スタック / Undo / 確定）
   * ========================================================= */

  /**
   * 論理削除：削除予定スタックにIDを積む（DBはまだ消さない）
   */
  function stageDelete(id) {
    if (!pendingDeleteStack.includes(id)) {
      pendingDeleteStack.push(id);
    }
    return pendingDeleteStack.length;
  }

  /**
   * 復元（Undo）：直前に論理削除したIDを取り出して返す
   */
  function undoDelete() {
    if (pendingDeleteStack.length === 0) {
      return null;
    }
    return pendingDeleteStack.pop();
  }

  /**
   * 指定IDが現在論理削除中かどうかを判定
   */
  function isStagedForDelete(id) {
    return pendingDeleteStack.includes(id);
  }

  /**
   * 現在論理削除中の件数を取得
   */
  function getStagedDeleteCount() {
    return pendingDeleteStack.length;
  }

  /**
   * 物理削除の確定：スタックに溜まった全IDを IndexedDB から完全削除してリセット
   */
  async function commitPendingDeletes() {
    const targetIds = [...pendingDeleteStack];
    if (targetIds.length === 0) {
      return [];
    }

    await deleteNotesPhysical(targetIds);
    pendingDeleteStack = [];
    return targetIds;
  }

  /**
   * 論理削除スタックを破棄（全復元したい場合用）
   */
  function resetPendingDeletes() {
    const restoredIds = [...pendingDeleteStack];
    pendingDeleteStack = [];
    return restoredIds;
  }

  return {
    openDB,
    createNoteData,
    getAllNotes,
    saveNote,
    deleteNotesPhysical,
    stageDelete,
    undoDelete,
    isStagedForDelete,
    getStagedDeleteCount,
    commitPendingDeletes,
    resetPendingDeletes
  };
})();
