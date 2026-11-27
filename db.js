/**
 * PostItDB
 * IndexedDB を使った付箋の永続化と、削除モード用の2段階削除（論理削除スタック → 一括物理削除）を管理するモジュール
 */
const PostItDB = (() => {
  const DB_NAME = 'PostItAppDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'notes';

  let dbInstance = null;
  let pendingDeleteStack = [];

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

  function createNoteData({ x = 40, y = 40, zIndex = 1, color = '#fff59d' } = {}) {
    const now = new Date().toISOString();
    const randomPart = Math.random().toString(36).slice(2, 6);
    return {
      id: `note_${Date.now()}_${randomPart}`,
      mode: 'text',
      text: '',
      drawingData: null,
      x,
      y,
      zIndex,
      color,
      dueDate: null,
      createdAt: now,
      updatedAt: now
    };
  }

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
   * バックアップ復元用：複数付箋を一括保存（同IDは上書き、別IDは追加）
   */
  async function bulkSaveNotes(notes) {
    if (!Array.isArray(notes) || notes.length === 0) {
      return 0;
    }

    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      let count = 0;

      for (const note of notes) {
        if (!note || typeof note.id !== 'string') continue;
        store.put({
          id: note.id,
          mode: note.mode === 'handwriting' ? 'handwriting' : 'text',
          text: typeof note.text === 'string' ? note.text : '',
          drawingData: typeof note.drawingData === 'string' ? note.drawingData : null,
          x: Number.isFinite(note.x) ? note.x : 40,
          y: Number.isFinite(note.y) ? note.y : 40,
          zIndex: Number.isFinite(note.zIndex) ? note.zIndex : 1,
          color: typeof note.color === 'string' ? note.color : '#fff59d',
          dueDate: typeof note.dueDate === 'string' && note.dueDate ? note.dueDate : null,
          createdAt: typeof note.createdAt === 'string' ? note.createdAt : new Date().toISOString(),
          updatedAt: typeof note.updatedAt === 'string' ? note.updatedAt : new Date().toISOString()
        });
        count += 1;
      }

      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('復元トランザクションが中断されました'));
    });
  }

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

  function stageDelete(id) {
    if (!pendingDeleteStack.includes(id)) {
      pendingDeleteStack.push(id);
    }
    return pendingDeleteStack.length;
  }

  function undoDelete() {
    if (pendingDeleteStack.length === 0) {
      return null;
    }
    return pendingDeleteStack.pop();
  }

  function isStagedForDelete(id) {
    return pendingDeleteStack.includes(id);
  }

  function getStagedDeleteCount() {
    return pendingDeleteStack.length;
  }

  async function commitPendingDeletes() {
    const targetIds = [...pendingDeleteStack];
    if (targetIds.length === 0) {
      return [];
    }

    await deleteNotesPhysical(targetIds);
    pendingDeleteStack = [];
    return targetIds;
  }

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
    bulkSaveNotes,
    deleteNotesPhysical,
    stageDelete,
    undoDelete,
    isStagedForDelete,
    getStagedDeleteCount,
    commitPendingDeletes,
    resetPendingDeletes
  };
})();
