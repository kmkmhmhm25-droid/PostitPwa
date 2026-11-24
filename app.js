(() => {
  'use strict';

  /* =========================================================
   * 定数・アプリ状態
   * ========================================================= */
  const BOARD_SIZE = 3000;
  const NOTE_WIDTH = 165;
  const NOTE_HEIGHT = 165;
  const MIN_SCALE = 0.4;
  const MAX_SCALE = 2.5;
  const TAP_MOVE_THRESHOLD = 8;        // ドラッグとタップの境界(px)
  const TWO_FINGER_TAP_MAX_MS = 350;   // 2本指タップの許容時間(ms)
  const TWO_FINGER_TAP_MAX_MOVE = 14;  // 2本指タップの許容ブレ(px)

  const state = {
    notes: [],
    currentView: 'board', // 'board' | 'list'
    isDeleteMode: false,
    maxZIndex: 1,
    addOffsetStep: 0,
    board: {
      scale: 1,
      panX: 0,
      panY: 0
    }
  };

  /* =========================================================
   * DOM 要素参照
   * ========================================================= */
  const dom = {
    btnAdd: document.getElementById('btn-add'),
    btnDeleteMode: document.getElementById('btn-delete-mode'),
    btnUndo: document.getElementById('btn-undo'),
    btnToggleView: document.getElementById('btn-toggle-view'),
    deleteBanner: document.getElementById('delete-banner'),
    deleteCount: document.getElementById('delete-count'),
    boardView: document.getElementById('board-view'),
    boardViewport: document.getElementById('board-viewport'),
    boardCanvas: document.getElementById('board-canvas'),
    zoomIndicator: document.getElementById('zoom-indicator'),
    listView: document.getElementById('list-view'),
    noteList: document.getElementById('note-list'),
    listEmptyMsg: document.getElementById('list-empty-msg')
  };

  /* =========================================================
   * ユーティリティ
   * ========================================================= */
  function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
  }

  function getTodayLocalISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function getPointerDistance(p1, p2) {
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }

  function getPointerMidpoint(p1, p2, rect) {
    return {
      x: (p1.x + p2.x) / 2 - rect.left,
      y: (p1.y + p2.y) / 2 - rect.top
    };
  }

  /* =========================================================
   * ボード表示（パン・ズーム）制御
   * ========================================================= */
  function applyBoardTransform() {
    const { panX, panY, scale } = state.board;
    dom.boardCanvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    dom.zoomIndicator.textContent = `${Math.round(scale * 100)}%`;
  }

  /**
   * ビューポート内の指定座標 (vx, vy) を基準に拡大縮小する
   */
  function zoomAtPoint(targetScale, vx, vy) {
    const clampedScale = clamp(targetScale, MIN_SCALE, MAX_SCALE);
    const { scale, panX, panY } = state.board;

    const worldX = (vx - panX) / scale;
    const worldY = (vy - panY) / scale;

    state.board.scale = clampedScale;
    state.board.panX = vx - worldX * clampedScale;
    state.board.panY = vy - worldY * clampedScale;
    applyBoardTransform();
  }

  function resetBoardZoom() {
    const rect = dom.boardViewport.getBoundingClientRect();
    zoomAtPoint(1, rect.width / 2, rect.height / 2);
  }

  /* =========================================================
   * 付箋 DOM 生成・描画
   * ========================================================= */
  function createNoteElement(note) {
    const el = document.createElement('div');
    el.className = 'sticky-note';
    el.dataset.id = note.id;
    updateNoteElement(el, note);
    attachNotePointerEvents(el);
    return el;
  }

  function updateNoteElement(el, note) {
    el.style.left = `${note.x}px`;
    el.style.top = `${note.y}px`;
    el.style.zIndex = String(note.zIndex || 1);
    el.style.backgroundColor = note.color || '#fff59d';

    if (PostItDB.isStagedForDelete(note.id)) {
      el.classList.add('hidden');
    } else {
      el.classList.remove('hidden');
    }

    el.innerHTML = '';

    // 本文または手書き画像
    if (note.mode === 'handwriting' && note.drawingData) {
      const img = document.createElement('img');
      img.className = 'sticky-note-img';
      img.src = note.drawingData;
      img.alt = '手書きメモ';
      el.appendChild(img);
    } else {
      const content = document.createElement('div');
      content.className = 'sticky-note-content';
      if (note.text && note.text.trim() !== '') {
        content.textContent = note.text;
      } else {
        content.textContent = '（タップして編集）';
        content.style.opacity = '0.45';
      }
      el.appendChild(content);
    }

    // 期限表示
    if (note.dueDate) {
      const due = document.createElement('div');
      due.className = 'sticky-note-due';
      if (note.dueDate < getTodayLocalISO()) {
        due.classList.add('overdue');
      }
      due.textContent = `期限: ${note.dueDate}`;
      el.appendChild(due);
    }
  }

  function renderBoard() {
    dom.boardCanvas.innerHTML = '';
    for (const note of state.notes) {
      dom.boardCanvas.appendChild(createNoteElement(note));
    }
  }

  function getNoteById(id) {
    return state.notes.find((n) => n.id === id) || null;
  }

  function getNoteElementById(id) {
    return dom.boardCanvas.querySelector(`.sticky-note[data-id="${CSS.escape(id)}"]`);
  }

  /* =========================================================
   * 付箋の追加
   * ========================================================= */
  async function handleAddNote() {
    if (state.isDeleteMode) return;

    // 現在のビューポート中央付近に少しずらしながら配置
    const rect = dom.boardViewport.getBoundingClientRect();
    const { panX, panY, scale } = state.board;
    const offset = (state.addOffsetStep % 6) * 22;
    state.addOffsetStep += 1;

    const centerX = (rect.width / 2 - panX) / scale - NOTE_WIDTH / 2 + offset;
    const centerY = (rect.height / 2 - panY) / scale - NOTE_HEIGHT / 2 + offset;

    state.maxZIndex += 1;
    const newNote = PostItDB.createNoteData({
      x: Math.round(clamp(centerX, 10, BOARD_SIZE - NOTE_WIDTH - 10)),
      y: Math.round(clamp(centerY, 10, BOARD_SIZE - NOTE_HEIGHT - 10)),
      zIndex: state.maxZIndex,
      color: '#fff59d'
    });

    const saved = await PostItDB.saveNote(newNote);
    state.notes.push(saved);

    if (state.currentView === 'board') {
      dom.boardCanvas.appendChild(createNoteElement(saved));
    } else {
      renderListView();
    }
  }

  /* =========================================================
   * 削除モード（論理削除・Undo・物理削除確定）
   * ========================================================= */
  function updateDeleteModeUI() {
    const count = PostItDB.getStagedDeleteCount();

    document.body.classList.toggle('is-delete-mode', state.isDeleteMode);
    dom.btnDeleteMode.classList.toggle('delete-active', state.isDeleteMode);
    dom.btnDeleteMode.textContent = state.isDeleteMode ? '削除確定' : '削除';

    dom.deleteBanner.classList.toggle('hidden', !state.isDeleteMode);
    dom.deleteCount.textContent = String(count);

    dom.btnUndo.classList.toggle('hidden', !state.isDeleteMode);
    dom.btnUndo.disabled = count === 0;

    // 削除モード中は意図しない遷移・追加を防止
    dom.btnAdd.disabled = state.isDeleteMode;
    dom.btnToggleView.disabled = state.isDeleteMode;
  }

  async function toggleDeleteMode() {
    if (!state.isDeleteMode) {
      // 通常モード → 削除モードへ（一覧画面にいたらボード画面へ戻す）
      if (state.currentView !== 'board') {
        switchView('board');
      }
      state.isDeleteMode = true;
      updateDeleteModeUI();
      return;
    }

    // 削除モード → 通常モードへ（論理削除済み付箋を物理削除）
    try {
      const deletedIds = await PostItDB.commitPendingDeletes();
      if (deletedIds.length > 0) {
        const deletedSet = new Set(deletedIds);
        state.notes = state.notes.filter((n) => !deletedSet.has(n.id));
        for (const id of deletedIds) {
          const el = getNoteElementById(id);
          if (el) el.remove();
        }
      }
    } catch (err) {
      console.error('物理削除に失敗しました:', err);
      alert('削除の確定に失敗しました。もう一度お試しください。');
      return;
    }

    state.isDeleteMode = false;
    updateDeleteModeUI();
  }

  function stageDeleteNote(noteId) {
    PostItDB.stageDelete(noteId);
    const el = getNoteElementById(noteId);
    if (el) {
      el.classList.add('hidden');
    }
    updateDeleteModeUI();
  }

  function handleUndoDelete() {
    if (!state.isDeleteMode) return;
    const restoredId = PostItDB.undoDelete();
    if (!restoredId) return;

    const el = getNoteElementById(restoredId);
    if (el) {
      el.classList.remove('hidden');
    }
    updateDeleteModeUI();
  }

  /* =========================================================
   * ポインタ管理（付箋ドラッグ・ボードパン・2本指ピンチ＆2本指タップ）
   * ========================================================= */
  const activePointers = new Map();
  let noteDrag = null;
  let boardPan = null;
  let twoFinger = null;
  let suppressSingleUntilAllUp = false;

  /**
   * 2本指操作が始まった際、進行中の付箋ドラッグを元位置へ戻して中断
   */
  function cancelNoteDrag() {
    if (!noteDrag) return;
    const { el, startNoteX, startNoteY } = noteDrag;
    el.style.left = `${startNoteX}px`;
    el.style.top = `${startNoteY}px`;
    el.classList.remove('dragging');
    noteDrag = null;
  }

  function attachNotePointerEvents(el) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;

      // 既に1本以上の指が画面にある場合は2本指ジェスチャー側へ委譲
      if (activePointers.size >= 1 || suppressSingleUntilAllUp) {
        return;
      }

      const noteId = el.dataset.id;
      const note = getNoteById(noteId);
      if (!note) return;

      // 削除モード時はドラッグ開始せず、タップ判定のみ行う
      noteDrag = {
        pointerId: e.pointerId,
        noteId,
        el,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startNoteX: note.x,
        startNoteY: note.y,
        moved: false,
        isDeleteTap: state.isDeleteMode
      };
    });
  }

  function initBoardPointerEvents() {
    const vp = dom.boardViewport;

    vp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;

      activePointers.set(e.pointerId, {
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY
      });

      // 2本指操作の開始
      if (activePointers.size === 2) {
        cancelNoteDrag();
        boardPan = null;
        suppressSingleUntilAllUp = true;

        const [p1, p2] = Array.from(activePointers.values());
        const rect = vp.getBoundingClientRect();
        const mid = getPointerMidpoint(p1, p2, rect);

        twoFinger = {
          startTime: Date.now(),
          startDist: Math.max(getPointerDistance(p1, p2), 1),
          startScale: state.board.scale,
          startPanX: state.board.panX,
          startPanY: state.board.panY,
          startMidX: mid.x,
          startMidY: mid.y,
          moved: false
        };
        return;
      }

      // 3本指以上になった場合はタップ判定を無効化
      if (activePointers.size > 2) {
        if (twoFinger) twoFinger.moved = true;
        return;
      }

      // 1本指かつ付箋上でない場合 → ボード背景のパン移動を開始
      if (!noteDrag && !suppressSingleUntilAllUp) {
        boardPan = {
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startPanX: state.board.panX,
          startPanY: state.board.panY
        };
      }
    });

    vp.addEventListener('pointermove', (e) => {
      if (!activePointers.has(e.pointerId)) return;

      const ptr = activePointers.get(e.pointerId);
      ptr.x = e.clientX;
      ptr.y = e.clientY;

      // 1) 2本指ピンチズーム & 2本指パン
      if (activePointers.size === 2 && twoFinger) {
        const [p1, p2] = Array.from(activePointers.values());
        const rect = vp.getBoundingClientRect();
        const currentDist = Math.max(getPointerDistance(p1, p2), 1);
        const mid = getPointerMidpoint(p1, p2, rect);

        const p1Shift = Math.hypot(p1.x - p1.startX, p1.y - p1.startY);
        const p2Shift = Math.hypot(p2.x - p2.startX, p2.y - p2.startY);
        if (p1Shift > TWO_FINGER_TAP_MAX_MOVE || p2Shift > TWO_FINGER_TAP_MAX_MOVE) {
          twoFinger.moved = true;
        }

        const ratio = currentDist / twoFinger.startDist;
        const newScale = clamp(twoFinger.startScale * ratio, MIN_SCALE, MAX_SCALE);

        // ピンチ開始時のボード上の中心点を、現在の2指の中点に追従させる
        const worldX = (twoFinger.startMidX - twoFinger.startPanX) / twoFinger.startScale;
        const worldY = (twoFinger.startMidY - twoFinger.startPanY) / twoFinger.startScale;

        state.board.scale = newScale;
        state.board.panX = mid.x - worldX * newScale;
        state.board.panY = mid.y - worldY * newScale;
        applyBoardTransform();
        return;
      }

      // 2) 付箋のドラッグ移動
      if (noteDrag && noteDrag.pointerId === e.pointerId) {
        const dx = e.clientX - noteDrag.startClientX;
        const dy = e.clientY - noteDrag.startClientY;

        if (!noteDrag.moved && Math.hypot(dx, dy) > TAP_MOVE_THRESHOLD) {
          if (noteDrag.isDeleteTap) {
            // 削除モード中は誤タップ防止のため移動とみなしてキャンセル
            noteDrag.moved = true;
            return;
          }
          noteDrag.moved = true;
          noteDrag.el.classList.add('dragging');
          state.maxZIndex += 1;
          noteDrag.el.style.zIndex = String(state.maxZIndex);
        }

        if (noteDrag.moved && !noteDrag.isDeleteTap) {
          const nextX = clamp(
            noteDrag.startNoteX + dx / state.board.scale,
            0,
            BOARD_SIZE - NOTE_WIDTH
          );
          const nextY = clamp(
            noteDrag.startNoteY + dy / state.board.scale,
            0,
            BOARD_SIZE - NOTE_HEIGHT
          );
          noteDrag.el.style.left = `${nextX}px`;
          noteDrag.el.style.top = `${nextY}px`;
        }
        return;
      }

      // 3) ボード背景の1本指パン移動
      if (boardPan && boardPan.pointerId === e.pointerId) {
        const dx = e.clientX - boardPan.startClientX;
        const dy = e.clientY - boardPan.startClientY;
        state.board.panX = boardPan.startPanX + dx;
        state.board.panY = boardPan.startPanY + dy;
        applyBoardTransform();
      }
    });

    async function handlePointerEnd(e) {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.delete(e.pointerId);

      // 付箋ドラッグまたはタップの完了処理
      if (noteDrag && noteDrag.pointerId === e.pointerId) {
        const finished = noteDrag;
        noteDrag = null;
        finished.el.classList.remove('dragging');

        if (finished.isDeleteTap) {
          if (!finished.moved) {
            stageDeleteNote(finished.noteId);
          }
        } else if (finished.moved) {
          // ドラッグ後の座標とzIndexを保存
          const note = getNoteById(finished.noteId);
          if (note) {
            note.x = Math.round(parseFloat(finished.el.style.left) || note.x);
            note.y = Math.round(parseFloat(finished.el.style.top) || note.y);
            note.zIndex = state.maxZIndex;
            await PostItDB.saveNote(note);
          }
        } else {
          // タップ → 編集モードを開く
          openEditModal(finished.noteId);
        }
      }

      // ボードパン終了
      if (boardPan && boardPan.pointerId === e.pointerId) {
        boardPan = null;
      }

      // 2本指ジェスチャー終了（すべての指が離れた瞬間）
      if (activePointers.size === 0) {
        if (twoFinger) {
          const elapsed = Date.now() - twoFinger.startTime;
          if (!twoFinger.moved && elapsed <= TWO_FINGER_TAP_MAX_MS) {
            // 2本指タップ：拡大 ⇔ 100% をトグル
            const targetScale = state.board.scale < 1.25 ? 1.6 : 1.0;
            zoomAtPoint(targetScale, twoFinger.startMidX, twoFinger.startMidY);
          }
          twoFinger = null;
        }
        suppressSingleUntilAllUp = false;
      }
    }

    vp.addEventListener('pointerup', handlePointerEnd);
    vp.addEventListener('pointercancel', handlePointerEnd);

    // PCブラウザ確認用：マウスホイールでの拡大縮小
    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      zoomAtPoint(
        state.board.scale * factor,
        e.clientX - rect.left,
        e.clientY - rect.top
      );
    }, { passive: false });
  }

  /* =========================================================
   * 画面切替（ボード ⇔ 一覧）
   * ========================================================= */
  function switchView(viewName) {
    state.currentView = viewName;
    const isBoard = viewName === 'board';

    dom.boardView.classList.toggle('hidden', !isBoard);
    dom.boardView.classList.toggle('active', isBoard);
    dom.listView.classList.toggle('hidden', isBoard);
    dom.listView.classList.toggle('active', !isBoard);

    dom.btnToggleView.textContent = isBoard ? '一覧' : 'ボード';
    dom.btnDeleteMode.classList.toggle('hidden', !isBoard);

    if (isBoard) {
      renderBoard();
    } else {
      renderListView();
    }
  }

  /* =========================================================
   * ステップ5で本実装するプレースホルダ関数
   * ========================================================= */
  function openEditModal(noteId) {
    // ステップ5で編集モーダル（テキスト・手書き・色・期限）を実装
    console.log('編集モードを開く対象ID:', noteId);
  }

  function renderListView() {
    // ステップ5で付箋一覧画面を実装
    dom.noteList.innerHTML = '';
    dom.listEmptyMsg.classList.toggle('hidden', state.notes.length > 0);
  }

  /* =========================================================
   * 初期化・イベント登録
   * ========================================================= */
  async function init() {
    // Service Worker 登録（PWA対応）
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('Service Worker 登録スキップ:', err);
      });
    }

    // データ読み込み
    try {
      state.notes = await PostItDB.getAllNotes();
      state.maxZIndex = state.notes.reduce(
        (max, n) => Math.max(max, n.zIndex || 1),
        1
      );
    } catch (err) {
      console.error('付箋の読み込みに失敗しました:', err);
      state.notes = [];
    }

    // ヘッダー・UIイベント登録
    dom.btnAdd.addEventListener('click', handleAddNote);
    dom.btnDeleteMode.addEventListener('click', toggleDeleteMode);
    dom.btnUndo.addEventListener('click', handleUndoDelete);
    dom.btnToggleView.addEventListener('click', () => {
      switchView(state.currentView === 'board' ? 'list' : 'board');
    });
    dom.zoomIndicator.addEventListener('click', resetBoardZoom);

    initBoardPointerEvents();
    applyBoardTransform();
    updateDeleteModeUI();
    renderBoard();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
