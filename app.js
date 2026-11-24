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

  // 編集モーダル用の一時状態
  const editor = {
    noteId: null,
    mode: 'text',           // 'text' | 'handwriting'
    color: '#fff59d',
    tempDrawingData: null,  // 編集中の手書き画像スナップショット
    canvasReady: false,
    canvasCssWidth: 0,
    canvasCssHeight: 0,
    dpr: 1,
    penColor: '#222222',
    penSize: 4,
    isEraser: false,
    activePointerId: null,
    lastX: 0,
    lastY: 0
  };

  /* =========================================================
   * DOM 要素参照
   * ========================================================= */
  const dom = {
    // ヘッダー・モード通知
    btnAdd: document.getElementById('btn-add'),
    btnDeleteMode: document.getElementById('btn-delete-mode'),
    btnUndo: document.getElementById('btn-undo'),
    btnToggleView: document.getElementById('btn-toggle-view'),
    deleteBanner: document.getElementById('delete-banner'),
    deleteCount: document.getElementById('delete-count'),

    // ボード画面
    boardView: document.getElementById('board-view'),
    boardViewport: document.getElementById('board-viewport'),
    boardCanvas: document.getElementById('board-canvas'),
    zoomIndicator: document.getElementById('zoom-indicator'),

    // 一覧画面
    listView: document.getElementById('list-view'),
    noteList: document.getElementById('note-list'),
    listEmptyMsg: document.getElementById('list-empty-msg'),

    // 編集モーダル
    editModal: document.getElementById('edit-modal'),
    editModalCard: document.getElementById('edit-modal-card'),
    btnModeText: document.getElementById('btn-mode-text'),
    btnModeDraw: document.getElementById('btn-mode-draw'),
    colorSwatches: document.querySelectorAll('.color-swatch'),
    editDueDate: document.getElementById('edit-due-date'),
    btnClearDate: document.getElementById('btn-clear-date'),
    textEditorArea: document.getElementById('text-editor-area'),
    noteTextarea: document.getElementById('note-textarea'),
    drawEditorArea: document.getElementById('draw-editor-area'),
    penColors: document.querySelectorAll('.pen-color'),
    penSize: document.getElementById('pen-size'),
    btnEraser: document.getElementById('btn-eraser'),
    btnClearCanvas: document.getElementById('btn-clear-canvas'),
    drawCanvas: document.getElementById('draw-canvas'),
    btnEditCancel: document.getElementById('btn-edit-cancel'),
    btnEditSave: document.getElementById('btn-edit-save')
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

  function formatDateTime(isoString) {
    if (!isoString) return '-';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '-';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}/${m}/${day} ${hh}:${mm}`;
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

  function getNoteById(id) {
    return state.notes.find((n) => n.id === id) || null;
  }

  function getNoteElementById(id) {
    return dom.boardCanvas.querySelector(`.sticky-note[data-id="${CSS.escape(id)}"]`);
  }

  /* =========================================================
   * ボード表示（パン・ズーム）制御
   * ========================================================= */
  function applyBoardTransform() {
    const { panX, panY, scale } = state.board;
    dom.boardCanvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    dom.zoomIndicator.textContent = `${Math.round(scale * 100)}%`;
  }

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
   * ボード画面：付箋 DOM 生成・描画
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

  /* =========================================================
   * 付箋一覧画面の描画
   * ========================================================= */
  function renderListView() {
    dom.noteList.innerHTML = '';

    // 論理削除されていない付箋を作成日の新しい順に表示
    const visibleNotes = state.notes
      .filter((n) => !PostItDB.isStagedForDelete(n.id))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    dom.listEmptyMsg.classList.toggle('hidden', visibleNotes.length > 0);
    const today = getTodayLocalISO();

    for (const note of visibleNotes) {
      const card = document.createElement('article');
      card.className = 'list-card';
      card.style.backgroundColor = note.color || '#fff59d';

      // 内容（手書き画像 or テキスト）
      if (note.mode === 'handwriting' && note.drawingData) {
        const img = document.createElement('img');
        img.className = 'list-card-thumb';
        img.src = note.drawingData;
        img.alt = '手書き付箋';
        card.appendChild(img);
      } else {
        const body = document.createElement('div');
        body.className = 'list-card-body';
        if (note.text && note.text.trim() !== '') {
          body.textContent = note.text;
        } else {
          body.textContent = '（内容なし）';
          body.style.opacity = '0.5';
        }
        card.appendChild(body);
      }

      // メタ情報（期限・作成日）
      const meta = document.createElement('div');
      meta.className = 'list-card-meta';

      const dueSpan = document.createElement('span');
      if (note.dueDate) {
        dueSpan.textContent = `期限: ${note.dueDate}`;
        if (note.dueDate < today) {
          dueSpan.classList.add('overdue');
          dueSpan.style.color = '#c62828';
          dueSpan.style.fontWeight = '700';
        }
      } else {
        dueSpan.textContent = '期限: 未設定';
      }

      const createdSpan = document.createElement('span');
      createdSpan.textContent = `作成: ${formatDateTime(note.createdAt)}`;

      meta.appendChild(dueSpan);
      meta.appendChild(createdSpan);
      card.appendChild(meta);

      // タップで編集モーダルを開く
      card.addEventListener('click', () => openEditModal(note.id));
      dom.noteList.appendChild(card);
    }
  }

  /* =========================================================
   * 付箋の追加
   * ========================================================= */
  async function handleAddNote() {
    if (state.isDeleteMode) return;

    const rect = dom.boardViewport.getBoundingClientRect();
    const { panX, panY, scale } = state.board;
    const offset = (state.addOffsetStep % 6) * 22;
    state.addOffsetStep += 1;

    const viewW = rect.width || window.innerWidth;
    const viewH = rect.height || window.innerHeight - 56;
    const centerX = (viewW / 2 - panX) / scale - NOTE_WIDTH / 2 + offset;
    const centerY = (viewH / 2 - panY) / scale - NOTE_HEIGHT / 2 + offset;

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

    dom.btnAdd.disabled = state.isDeleteMode;
    dom.btnToggleView.disabled = state.isDeleteMode;
  }

  async function toggleDeleteMode() {
    if (!state.isDeleteMode) {
      if (state.currentView !== 'board') {
        switchView('board');
      }
      state.isDeleteMode = true;
      updateDeleteModeUI();
      return;
    }

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
   * ボード操作（ドラッグ移動・パン・2本指ピンチ＆2本指タップ）
   * ========================================================= */
  const activePointers = new Map();
  let noteDrag = null;
  let boardPan = null;
  let twoFinger = null;
  let suppressSingleUntilAllUp = false;

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
      if (activePointers.size >= 1 || suppressSingleUntilAllUp) return;

      const noteId = el.dataset.id;
      const note = getNoteById(noteId);
      if (!note) return;

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

      if (activePointers.size > 2) {
        if (twoFinger) twoFinger.moved = true;
        return;
      }

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

      // 1) 2本指ピンチズーム & パン
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

      // 3) ボード背景のパン移動
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

      if (noteDrag && noteDrag.pointerId === e.pointerId) {
        const finished = noteDrag;
        noteDrag = null;
        finished.el.classList.remove('dragging');

        if (finished.isDeleteTap) {
          if (!finished.moved) {
            stageDeleteNote(finished.noteId);
          }
        } else if (finished.moved) {
          const note = getNoteById(finished.noteId);
          if (note) {
            note.x = Math.round(parseFloat(finished.el.style.left) || note.x);
            note.y = Math.round(parseFloat(finished.el.style.top) || note.y);
            note.zIndex = state.maxZIndex;
            await PostItDB.saveNote(note);
          }
        } else {
          openEditModal(finished.noteId);
        }
      }

      if (boardPan && boardPan.pointerId === e.pointerId) {
        boardPan = null;
      }

      if (activePointers.size === 0) {
        if (twoFinger) {
          const elapsed = Date.now() - twoFinger.startTime;
          if (!twoFinger.moved && elapsed <= TWO_FINGER_TAP_MAX_MS) {
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

    // PCブラウザ確認用ホイールズーム
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
   * 編集モーダル（テキスト・手書きキャンバス・色変更・期限）
   * ========================================================= */
  function applyEditorColor(color) {
    editor.color = color;
    dom.editModalCard.style.backgroundColor = color;
    dom.colorSwatches.forEach((btn) => {
      btn.classList.toggle('selected', btn.dataset.color === color);
    });
  }

  function isCanvasBlank(canvas) {
    if (canvas.width === 0 || canvas.height === 0) return true;
    const ctx = canvas.getContext('2d');
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 0) return false;
    }
    return true;
  }

  function captureCanvasSnapshot() {
    if (!editor.canvasReady) return editor.tempDrawingData;
    if (isCanvasBlank(dom.drawCanvas)) {
      editor.tempDrawingData = null;
    } else {
      editor.tempDrawingData = dom.drawCanvas.toDataURL('image/png');
    }
    return editor.tempDrawingData;
  }

  function clearDrawCanvas() {
    const canvas = dom.drawCanvas;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    editor.tempDrawingData = null;
  }

  /**
   * 手書きキャンバスの解像度を初期化し、既存画像があればアスペクト比維持で復元する
   */
  function setupDrawCanvas() {
    const canvas = dom.drawCanvas;
    const wrapper = canvas.parentElement;
    const rect = wrapper.getBoundingClientRect();

    const cssW = Math.max(Math.floor(rect.width), 280);
    const cssH = Math.max(Math.floor(rect.height), 240);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);

    editor.canvasCssWidth = cssW;
    editor.canvasCssHeight = cssH;
    editor.dpr = dpr;
    editor.canvasReady = true;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (editor.tempDrawingData) {
      const img = new Image();
      img.onload = () => {
        // モーダルがすでに閉じられていれば描画しない
        if (!editor.noteId || !editor.canvasReady) return;
        const scale = Math.min(cssW / img.width, cssH / img.height);
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        const offsetX = (cssW - drawW) / 2;
        const offsetY = (cssH - drawH) / 2;

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
        ctx.restore();
      };
      img.src = editor.tempDrawingData;
    }
  }

  function setEditMode(mode) {
    // 手書きモードから離脱する前に描画内容を退避
    if (editor.mode === 'handwriting' && mode !== 'handwriting' && editor.canvasReady) {
      captureCanvasSnapshot();
    }

    editor.mode = mode;
    const isText = mode === 'text';

    dom.btnModeText.classList.toggle('active', isText);
    dom.btnModeDraw.classList.toggle('active', !isText);
    dom.textEditorArea.classList.toggle('hidden', !isText);
    dom.drawEditorArea.classList.toggle('hidden', isText);

    if (!isText) {
      // テキスト入力キーボードを閉じてからキャンバスサイズを確定
      dom.noteTextarea.blur();
      requestAnimationFrame(() => {
        setupDrawCanvas();
      });
    }
  }

  function openEditModal(noteId) {
    const note = getNoteById(noteId);
    if (!note) return;

    editor.noteId = note.id;
    editor.tempDrawingData = note.drawingData || null;
    editor.canvasReady = false;
    editor.isEraser = false;
    editor.activePointerId = null;

    dom.btnEraser.classList.remove('active');
    dom.noteTextarea.value = note.text || '';
    dom.editDueDate.value = note.dueDate || '';
    applyEditorColor(note.color || '#fff59d');

    dom.editModal.classList.remove('hidden');
    setEditMode(note.mode || 'text');
  }

  function closeEditModal() {
    dom.noteTextarea.blur();
    dom.editModal.classList.add('hidden');
    editor.noteId = null;
    editor.tempDrawingData = null;
    editor.canvasReady = false;
    editor.activePointerId = null;
  }

  async function saveEditModal() {
    const note = getNoteById(editor.noteId);
    if (!note) {
      closeEditModal();
      return;
    }

    if (editor.mode === 'handwriting' && editor.canvasReady) {
      captureCanvasSnapshot();
    }

    note.mode = editor.mode;
    note.color = editor.color;
    note.text = dom.noteTextarea.value;
    note.drawingData = editor.tempDrawingData;
    note.dueDate = dom.editDueDate.value || null;

    try {
      const saved = await PostItDB.saveNote(note);
      const idx = state.notes.findIndex((n) => n.id === saved.id);
      if (idx !== -1) {
        state.notes[idx] = saved;
      }

      // ボード側のDOM更新
      const el = getNoteElementById(saved.id);
      if (el) {
        updateNoteElement(el, saved);
      }

      // 一覧画面表示中なら一覧を再描画
      if (state.currentView === 'list') {
        renderListView();
      }
    } catch (err) {
      console.error('付箋の保存に失敗しました:', err);
      alert('保存に失敗しました。ストレージ容量を確認してください。');
      return;
    }

    closeEditModal();
  }

  function initDrawCanvasEvents() {
    const canvas = dom.drawCanvas;

    function getCanvasPoint(e) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
    }

    function applyStrokeStyle(ctx) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (editor.isEraser) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.lineWidth = editor.penSize * 2.5;
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = editor.penColor;
        ctx.lineWidth = editor.penSize;
      }
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (editor.activePointerId !== null) return;
      if (!editor.canvasReady) return;

      e.preventDefault();
      editor.activePointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);

      const pt = getCanvasPoint(e);
      editor.lastX = pt.x;
      editor.lastY = pt.y;

      // 単タップでも点が打てるように微小ストロークを描画
      const ctx = canvas.getContext('2d');
      applyStrokeStyle(ctx);
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.lineTo(pt.x + 0.1, pt.y + 0.1);
      ctx.stroke();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (editor.activePointerId !== e.pointerId) return;
      e.preventDefault();

      const pt = getCanvasPoint(e);
      const ctx = canvas.getContext('2d');
      applyStrokeStyle(ctx);
      ctx.beginPath();
      ctx.moveTo(editor.lastX, editor.lastY);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();

      editor.lastX = pt.x;
      editor.lastY = pt.y;
    });

    function endStroke(e) {
      if (editor.activePointerId !== e.pointerId) return;
      editor.activePointerId = null;
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    }

    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);
  }

  function initEditModalEvents() {
    dom.btnModeText.addEventListener('click', () => setEditMode('text'));
    dom.btnModeDraw.addEventListener('click', () => setEditMode('handwriting'));

    dom.colorSwatches.forEach((btn) => {
      btn.addEventListener('click', () => applyEditorColor(btn.dataset.color));
    });

    dom.btnClearDate.addEventListener('click', () => {
      dom.editDueDate.value = '';
    });

    dom.penColors.forEach((btn) => {
      btn.addEventListener('click', () => {
        editor.penColor = btn.dataset.pen;
        editor.isEraser = false;
        dom.btnEraser.classList.remove('active');
        dom.penColors.forEach((b) => b.classList.toggle('active', b === btn));
      });
    });

    dom.penSize.addEventListener('input', (e) => {
      editor.penSize = Number(e.target.value) || 4;
    });

    dom.btnEraser.addEventListener('click', () => {
      editor.isEraser = !editor.isEraser;
      dom.btnEraser.classList.toggle('active', editor.isEraser);
    });

    dom.btnClearCanvas.addEventListener('click', () => {
      if (!editor.canvasReady) return;
      clearDrawCanvas();
    });

    dom.btnEditCancel.addEventListener('click', closeEditModal);
    dom.btnEditSave.addEventListener('click', saveEditModal);

    initDrawCanvasEvents();
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
   * 初期化・イベント登録
   * ========================================================= */
  async function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('Service Worker 登録スキップ:', err);
      });
    }

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

    dom.btnAdd.addEventListener('click', handleAddNote);
    dom.btnDeleteMode.addEventListener('click', toggleDeleteMode);
    dom.btnUndo.addEventListener('click', handleUndoDelete);
    dom.btnToggleView.addEventListener('click', () => {
      switchView(state.currentView === 'board' ? 'list' : 'board');
    });
    dom.zoomIndicator.addEventListener('click', resetBoardZoom);

    initBoardPointerEvents();
    initEditModalEvents();
    applyBoardTransform();
    updateDeleteModeUI();
    renderBoard();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
