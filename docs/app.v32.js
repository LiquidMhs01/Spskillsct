const CTS_VERSION = 'v32';
console.log('[Central SpSkills]', CTS_VERSION, 'loaded');
// Central de Treinamento SpSkills (v20) - reconstruído e inicialização segura
// Objetivo: zero 'await' fora de funções async (evita "Unexpected reserved word" em qualquer browser).
(function () {
  "use strict";

  // PDF.js worker
  if (globalThis.pdfjsLib && globalThis.pdfjsLib.GlobalWorkerOptions) {
    globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  }

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const escapeHtml = (s) =>
    String(s).replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Storage
  const db = {
    app: localforage.createInstance({ name: "ctspskills", storeName: "app" }),
    schedule: localforage.createInstance({ name: "ctspskills", storeName: "schedule" }),
  };

  const DEFAULT_STATE = {
    board: [
      { id: crypto.randomUUID(), title: "A Fazer", tasks: [] },
      { id: crypto.randomUUID(), title: "Fazendo", tasks: [] },
      { id: crypto.randomUUID(), title: "Feito", tasks: [] },
    ],
    labels: [],
    attachments: {}, // taskId -> [{id,name,type,size,blob}]
    timers: [],
    ui: { hideTimerChart: false, timerFilter: 'stopwatch' },
  };

  function structuredCloneSafe(obj) {
    try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj)); }
  }

  function migrateState(s) {
    if (!s || typeof s !== "object") return structuredCloneSafe(DEFAULT_STATE);
    if (!Array.isArray(s.board)) s.board = structuredCloneSafe(DEFAULT_STATE.board);
    if (!Array.isArray(s.labels)) s.labels = [];
    if (!s.attachments || typeof s.attachments !== "object") s.attachments = {};
    if (!Array.isArray(s.timers)) s.timers = [];
    if (!s.ui || typeof s.ui !== "object") s.ui = { hideTimerChart: false };
    for (const l of s.board) {
      if (!Array.isArray(l.tasks)) l.tasks = [];
      for (const t of l.tasks) {
        if (!Array.isArray(t.labelIds)) t.labelIds = [];
      }
    }
    return s;
  }

  let state = null;
  const saveState = () => db.app.setItem("state", state);

  // ---------- Tabs ----------
  const tabMeta = {
    schedule: { title: "Cronograma", subtitle: "Importe PNG/JPG, XLSX/XML ou PDF e use zoom/pan." },
    tasks: { title: "Tarefas", subtitle: "Listas e tarefas estilo Trello, com etiquetas e anexos." },
    timers: { title: "Cronômetros", subtitle: "Cronômetros independentes (estilo Windows)." },
  };

  function setTab(tab) {
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $$(".tab").forEach((s) => s.classList.remove("active"));
    $(`#tab-${tab}`).classList.add("active");
    $("#pageTitle").textContent = tabMeta[tab].title;
    $("#pageSubtitle").textContent = tabMeta[tab].subtitle;

    if (tab === "tasks") Tasks.renderBoard();
    if (tab === "timers") Timers.render();
  }

  // ============================================================
  // Schedule
  // ============================================================
  const Schedule = (() => {
    const viewer = $("#viewer");
    const contentEl = $("#scheduleContent");
    const empty = $("#scheduleEmpty");

    const pdfPager = $("#pdfPager");
    const pdfPrev = $("#pdfPrev");
    const pdfNext = $("#pdfNext");
    const pdfPageEl = $("#pdfPage");
    const pdfPagesEl = $("#pdfPages");

    let view = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
    let baseSize = { w: 0, h: 0 };

    let schedulePayload = null;

    // pdf runtime
    let pdfDoc = null;
    let pdfPage = 1;
    let pdfZoom = 1;
    let pdfBase = { w: 0, h: 0 };
    let pdfRerenderTimer = null;

    function applyView() {
      if (pdfDoc) {
        contentEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(1)`;
        return;
      }
      contentEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    }

    function setBaseSize(w, h) {
      baseSize.w = Math.max(1, w);
      baseSize.h = Math.max(1, h);
    }

    function clearContent() {
      contentEl.innerHTML = "";
      baseSize = { w: 0, h: 0 };
      pdfDoc = null;
      pdfPage = 1;
      pdfZoom = 1;
      pdfBase = { w: 0, h: 0 };
      pdfPager.classList.add("hidden");
      if (pdfRerenderTimer) {
        clearTimeout(pdfRerenderTimer);
        pdfRerenderTimer = null;
      }
    }

    function fitToViewer() {
      const rect = viewer.getBoundingClientRect();
      if (pdfDoc) {
        const w1 = Math.max(1, pdfBase.w || baseSize.w);
        const h1 = Math.max(1, pdfBase.h || baseSize.h);
        const zFit = Math.min(rect.width / w1, rect.height / h1);
        pdfZoom = Math.min(6, Math.max(0.2, zFit));
        view.x = (rect.width - w1 * pdfZoom) / 2;
        view.y = (rect.height - h1 * pdfZoom) / 2;
        schedulePdfRerender();
        applyView();
        return;
      }
      if (!baseSize.w || !baseSize.h) return;
      view.scale = Math.max(0.05, Math.min(rect.width / baseSize.w, rect.height / baseSize.h));
      view.x = (rect.width - baseSize.w * view.scale) / 2;
      view.y = (rect.height - baseSize.h * view.scale) / 2;
      applyView();
    }

    function resetView() {
      view.scale = 1;
      view.x = 0;
      view.y = 0;
      if (pdfDoc) {
        pdfZoom = 1;
        schedulePdfRerender(true);
      }
      applyView();
    }

    function aoaToTable(aoa) {
      const MAX_R = 220,
        MAX_C = 40;
      const safe = (aoa || [])
        .slice(0, MAX_R)
        .map((r) => (Array.isArray(r) ? r.slice(0, MAX_C) : []));
      const cols = Math.max(1, ...safe.map((r) => r.length));

      const table = document.createElement("table");
      table.className = "schedule-table";

      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      for (let c = 0; c < cols; c++) {
        const th = document.createElement("th");
        th.textContent = String.fromCharCode(65 + (c % 26)) + (c >= 26 ? String(Math.floor(c / 26)) : "");
        hr.append(th);
      }
      thead.append(hr);
      table.append(thead);

      const tbody = document.createElement("tbody");
      for (const row of safe) {
        const tr = document.createElement("tr");
        for (let c = 0; c < cols; c++) {
          const td = document.createElement("td");
          const v = row[c];
          td.textContent = v === null || v === undefined ? "" : String(v);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      return table;
    }

    function parseSpreadsheetXml(xmlText) {
      const doc = new DOMParser().parseFromString(xmlText, "text/xml");
      if (doc.getElementsByTagName("parsererror")[0]) throw new Error("XML inválido.");
      const rows = Array.from(doc.getElementsByTagName("Row"));
      if (rows.length) {
        return rows.map((r) =>
          Array.from(r.getElementsByTagName("Cell")).map((c) => c.getElementsByTagName("Data")[0]?.textContent ?? "")
        );
      }
      throw new Error("XML não reconhecido. Use SpreadsheetML (Excel 2003) ou XLSX.");
    }

    async function renderPdfPage(pageNum, zoom) {
      if (!pdfDoc) return;
      pdfPage = Math.max(1, Math.min(pageNum, pdfDoc.numPages));
      pdfZoom = Math.min(6, Math.max(0.2, zoom));

      const page = await pdfDoc.getPage(pdfPage);

      const baseVp = page.getViewport({ scale: 1.0 });
      pdfBase = { w: Math.floor(baseVp.width), h: Math.floor(baseVp.height) };

      const viewport = page.getViewport({ scale: pdfZoom });
      contentEl.innerHTML = "";
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { alpha: false });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      contentEl.append(canvas);

      setBaseSize(canvas.width, canvas.height);
      pdfPageEl.textContent = String(pdfPage);
      pdfPagesEl.textContent = String(pdfDoc.numPages);
      pdfPager.classList.remove("hidden");
      applyView();
    }

    function schedulePdfRerender(immediate) {
      if (!pdfDoc) return;
      if (pdfRerenderTimer) clearTimeout(pdfRerenderTimer);

      const run = () => {
        renderPdfPage(pdfPage, pdfZoom)
          .then(() => {
            if (schedulePayload?.kind === "pdf") {
              schedulePayload.meta = schedulePayload.meta || {};
              schedulePayload.meta.page = pdfPage;
              schedulePayload.meta.zoom = pdfZoom;
              return db.schedule.setItem("payload", schedulePayload);
            }
          })
          .catch((err) => alert("Falha ao renderizar PDF: " + err.message));
      };

      if (immediate) return run();
      pdfRerenderTimer = setTimeout(run, 140);
    }

    function setSchedulePayload(payload) {
      schedulePayload = payload;
      if (payload) return db.schedule.setItem("payload", payload).then(renderSchedule);
      return db.schedule.removeItem("payload").then(renderSchedule);
    }

    function renderSchedule() {
      if (!schedulePayload) {
        viewer.classList.add("hidden");
        empty.classList.remove("hidden");
        clearContent();
        return Promise.resolve();
      }

      empty.classList.add("hidden");
      viewer.classList.remove("hidden");
      clearContent();

      if (schedulePayload.kind === "image") {
        const img = document.createElement("img");
        img.alt = "Cronograma";
        img.draggable = false;
        const url = URL.createObjectURL(schedulePayload.value);
        img.onload = () => {
          setBaseSize(img.naturalWidth, img.naturalHeight);
          fitToViewer();
          URL.revokeObjectURL(url);
        };
        img.src = url;
        contentEl.append(img);
        return Promise.resolve();
      }

      if (schedulePayload.kind === "xlsx" || schedulePayload.kind === "xml") {
        const table = aoaToTable(schedulePayload.meta?.aoa ?? []);
        contentEl.append(table);
        requestAnimationFrame(() => {
          const prev = contentEl.style.transform;
          contentEl.style.transform = "translate(0,0) scale(1)";
          setBaseSize(contentEl.scrollWidth, contentEl.scrollHeight);
          contentEl.style.transform = prev || "";
          fitToViewer();
        });
        return Promise.resolve();
      }

      if (schedulePayload.kind === "pdf") {
        if (!globalThis.pdfjsLib) return Promise.reject(new Error("PDF.js não carregou."));
        const blob = schedulePayload.value;
        return blob
          .arrayBuffer()
          .then((buf) => new Uint8Array(buf))
          .then((bytes) => globalThis.pdfjsLib.getDocument({ data: bytes }).promise)
          .then((doc) => {
            pdfDoc = doc;
            pdfPage = schedulePayload.meta?.page ?? 1;
            pdfZoom = schedulePayload.meta?.zoom ?? 1;
            return renderPdfPage(pdfPage, pdfZoom);
          })
          .then(() => fitToViewer());
      }

      return Promise.resolve();
    }

    function bindEvents() {
      viewer.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const rect = viewer.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;

          if (pdfDoc) {
            const prev = pdfZoom;
            const delta = e.deltaY < 0 ? 1.12 : 1 / 1.12;
            pdfZoom = Math.min(6, Math.max(0.2, pdfZoom * delta));
            const k = pdfZoom / prev;
            view.x = mx - (mx - view.x) * k;
            view.y = my - (my - view.y) * k;
            applyView();
            schedulePdfRerender(false);
            return;
          }

          const prev = view.scale;
          const delta = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          view.scale = Math.min(18, Math.max(0.05, view.scale * delta));
          const k = view.scale / prev;
          view.x = mx - (mx - view.x) * k;
          view.y = my - (my - view.y) * k;
          applyView();
        },
        { passive: false }
      );

      viewer.addEventListener("mousedown", (e) => {
        view.dragging = true;
        view.lastX = e.clientX;
        view.lastY = e.clientY;
      });
      window.addEventListener("mouseup", () => (view.dragging = false));
      window.addEventListener("mousemove", (e) => {
        if (!view.dragging) return;
        const dx = e.clientX - view.lastX;
        const dy = e.clientY - view.lastY;
        view.lastX = e.clientX;
        view.lastY = e.clientY;
        view.x += dx;
        view.y += dy;
        applyView();
      });

      $("#fitBtn").addEventListener("click", fitToViewer);
      $("#resetViewBtn").addEventListener("click", resetView);
      $("#zoomInBtn").addEventListener("click", () => {
        if (pdfDoc) {
          pdfZoom = Math.min(6, pdfZoom * 1.12);
          schedulePdfRerender(true);
          return;
        }
        view.scale = Math.min(18, view.scale * 1.12);
        applyView();
      });
      $("#zoomOutBtn").addEventListener("click", () => {
        if (pdfDoc) {
          pdfZoom = Math.max(0.2, pdfZoom / 1.12);
          schedulePdfRerender(true);
          return;
        }
        view.scale = Math.max(0.05, view.scale / 1.12);
        applyView();
      });

      pdfPrev.addEventListener("click", () => {
        if (!pdfDoc) return;
        pdfPage = Math.max(1, pdfPage - 1);
        renderPdfPage(pdfPage, pdfZoom).then(() => db.schedule.setItem("payload", schedulePayload));
      });
      pdfNext.addEventListener("click", () => {
        if (!pdfDoc) return;
        pdfPage = Math.min(pdfDoc.numPages, pdfPage + 1);
        renderPdfPage(pdfPage, pdfZoom).then(() => db.schedule.setItem("payload", schedulePayload));
      });

      $("#scheduleFile").addEventListener("change", (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const name = (f.name || "").toLowerCase();
        const done = () => (e.target.value = "");

        Promise.resolve()
          .then(() => {
            if (["image/png", "image/jpeg"].includes(f.type)) {
              return setSchedulePayload({ kind: "image", value: f, meta: {} });
            }
            if (name.endsWith(".xlsx") || f.type.includes("spreadsheet") || f.type.includes("excel")) {
              return f.arrayBuffer().then((ab) => {
                const wb = XLSX.read(ab, { type: "array" });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
                return setSchedulePayload({ kind: "xlsx", value: null, meta: { aoa } });
              });
            }
            if (name.endsWith(".xml") || f.type.includes("xml")) {
              return f.text().then((txt) => {
                const aoa = parseSpreadsheetXml(txt);
                return setSchedulePayload({ kind: "xml", value: null, meta: { aoa } });
              });
            }
            if (name.endsWith(".pdf") || f.type === "application/pdf") {
              return setSchedulePayload({ kind: "pdf", value: f, meta: { page: 1, zoom: 1 } });
            }
            throw new Error("Formato não suportado.");
          })
          .catch((err) => alert("Falha ao importar: " + err.message))
          .finally(done);
      });

      $("#removeScheduleBtn").addEventListener("click", () => {
        if (!confirm("Remover cronograma?")) return;
        setSchedulePayload(null);
      });

      window.addEventListener("resize", () => {
        if (!viewer.classList.contains("hidden")) fitToViewer();
      });
    }

    function init() {
      return db.schedule.getItem("payload").then((p) => {
        schedulePayload = p ?? null;
        bindEvents();
        return renderSchedule();
      });
    }

    return { init, renderSchedule };
  })();

  // ============================================================
  // Tasks
  // ============================================================
  const Tasks = (() => {
    const boardEl = $("#board");

    const taskModal = $("#taskModal");
    const taskModalClose = $("#taskModalClose");
    const taskModalX = $("#taskModalX");
    const taskModalTitle = $("#taskModalTitle");
    const taskModalSaveTitle = $("#taskModalSaveTitle");
    const taskModalLabels = $("#taskModalLabels");
    const labelsChecklist = $("#labelsChecklist");
    const labelsList = $("#labelsList");
    const labelName = $("#labelName");
    const labelColor = $("#labelColor");
    const labelSave = $("#labelSave");
    const labelCancelEdit = $("#labelCancelEdit");
    const taskAttachInput = $("#taskAttachInput");
    const taskAttachments = $("#taskAttachments");

    let modalTaskId = null;
    let editingLabelId = null;

    function showModal() { taskModal.classList.remove("hidden"); }
    function hideModal() {
      taskModal.classList.add("hidden");
      modalTaskId = null;
      editingLabelId = null;
      taskAttachInput.value = "";
    }

    taskModalClose.addEventListener("click", hideModal);
    taskModalX.addEventListener("click", hideModal);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !taskModal.classList.contains("hidden")) hideModal();
    });

    function findTask(taskId) {
      for (const l of state.board) {
        const t = l.tasks.find((x) => x.id === taskId);
        if (t) return { list: l, task: t };
      }
      return null;
    }

    function renderTaskLabels(task) {
      taskModalLabels.innerHTML = "";
      const ids = task.labelIds || [];
      if (ids.length === 0) {
        const m = document.createElement("div");
        m.className = "muted small-text";
        m.textContent = "Sem etiquetas.";
        taskModalLabels.append(m);
        return;
      }
      for (const id of ids) {
        const lb = state.labels.find((x) => x.id === id);
        if (!lb) continue;
        const chip = document.createElement("span");
        chip.className = "label-chip";
        chip.innerHTML = `<span class="label-dot" style="background:${lb.color}"></span>${escapeHtml(lb.name)}`;
        taskModalLabels.append(chip);
      }
    }

    function renderLabelsChecklist(task) {
      labelsChecklist.innerHTML = "";
      const set = new Set(task.labelIds || []);
      if (state.labels.length === 0) {
        const m = document.createElement("div");
        m.className = "muted small-text";
        m.textContent = "Nenhuma etiqueta criada ainda.";
        labelsChecklist.append(m);
        return;
      }
      for (const lb of state.labels) {
        const row = document.createElement("div");
        row.className = "labels-check";
        const left = document.createElement("div");
        left.className = "labels-check-left";
        left.innerHTML = `<span class="label-dot" style="background:${lb.color}"></span><b>${escapeHtml(lb.name)}</b>`;
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = set.has(lb.id);
        cb.addEventListener("change", () => {
          task.labelIds = task.labelIds || [];
          const has = task.labelIds.includes(lb.id);
          if (cb.checked && !has) task.labelIds.push(lb.id);
          if (!cb.checked && has) task.labelIds = task.labelIds.filter((x) => x !== lb.id);
          saveState().then(() => {
            renderTaskLabels(task);
            renderBoard();
          });
        });
        row.append(left, cb);
        labelsChecklist.append(row);
      }
    }

    function renderLabelsList() {
      labelsList.innerHTML = "";
      for (const lb of state.labels) {
        const row = document.createElement("div");
        row.className = "label-row";
        const left = document.createElement("div");
        left.className = "label-row-left";
        left.innerHTML = `<span class="label-dot" style="background:${lb.color}"></span><b>${escapeHtml(lb.name)}</b>`;
        const actions = document.createElement("div");
        actions.className = "row";
        const edit = document.createElement("button");
        edit.className = "btn small";
        edit.textContent = "Editar";
        edit.onclick = () => {
          editingLabelId = lb.id;
          labelName.value = lb.name;
          labelColor.value = lb.color;
        };
        const del = document.createElement("button");
        del.className = "btn danger small";
        del.textContent = "Excluir";
        del.onclick = () => {
          if (!confirm("Excluir etiqueta?")) return;
          state.labels = state.labels.filter((x) => x.id !== lb.id);
          for (const l of state.board) {
            for (const t of l.tasks) t.labelIds = (t.labelIds || []).filter((id) => id !== lb.id);
          }
          saveState().then(() => {
            renderLabelsList();
            if (modalTaskId) {
              const res = findTask(modalTaskId);
              if (res) {
                renderTaskLabels(res.task);
                renderLabelsChecklist(res.task);
              }
            }
            renderBoard();
          });
        };
        actions.append(edit, del);
        row.append(left, actions);
        labelsList.append(row);
      }
    }

    labelCancelEdit.onclick = () => {
      editingLabelId = null;
      labelName.value = "";
      labelColor.value = "#5865f2";
    };

    labelSave.onclick = () => {
      const name = (labelName.value || "").trim();
      const color = (labelColor.value || "#5865f2").trim();
      if (!name) return alert("Digite o nome da etiqueta.");
      if (editingLabelId) {
        const lb = state.labels.find((x) => x.id === editingLabelId);
        if (lb) { lb.name = name; lb.color = color; }
      } else {
        state.labels.push({ id: crypto.randomUUID(), name, color });
      }
      editingLabelId = null;
      labelName.value = "";
      labelColor.value = "#5865f2";
      saveState().then(() => {
        renderLabelsList();
        if (modalTaskId) {
          const res = findTask(modalTaskId);
          if (res) { renderTaskLabels(res.task); renderLabelsChecklist(res.task); }
        }
        renderBoard();
      });
    };

    function renderAttachments(taskId) {
      taskAttachments.innerHTML = "";
      const items = state.attachments[taskId] || [];
      if (items.length === 0) {
        const m = document.createElement("div");
        m.className = "muted small-text";
        m.textContent = "Sem anexos.";
        taskAttachments.append(m);
        return;
      }

      for (const a of items) {
        const row = document.createElement("div");
        row.className = "attachment";
        const left = document.createElement("div");
        left.className = "attachment-left";

        let thumb;
        if (a.type && a.type.startsWith("image/")) {
          const img = document.createElement("img");
          img.className = "attachment-thumb";
          img.src = URL.createObjectURL(a.blob);
          img.onload = () => URL.revokeObjectURL(img.src);
          thumb = img;
        } else {
          const d = document.createElement("div");
          d.className = "attachment-thumb";
          d.style.display = "flex";
          d.style.alignItems = "center";
          d.style.justifyContent = "center";
          d.style.color = "rgba(255,255,255,.8)";
          d.textContent = "📎";
          thumb = d;
        }

        const mid = document.createElement("div");
        mid.style.minWidth = "0";
        const nm = document.createElement("div");
        nm.className = "attachment-name";
        nm.textContent = a.name;
        const meta = document.createElement("div");
        meta.className = "attachment-meta";
        meta.textContent = `${a.type || "arquivo"} • ${Math.round((a.size || 0) / 1024)} KB`;
        mid.append(nm, meta);

        left.append(thumb, mid);

        const actions = document.createElement("div");
        actions.className = "row";
        const open = document.createElement("button");
        open.className = "btn small";
        open.textContent = "Abrir";
        open.onclick = () => window.open(URL.createObjectURL(a.blob), "_blank", "noopener,noreferrer");
        const del = document.createElement("button");
        del.className = "btn danger small";
        del.textContent = "Remover";
        del.onclick = () => {
          if (!confirm("Remover anexo?")) return;
          state.attachments[taskId] = (state.attachments[taskId] || []).filter((x) => x.id !== a.id);
          saveState().then(() => {
            renderAttachments(taskId);
            renderBoard();
          });
        };
        actions.append(open, del);
        row.append(left, actions);
        taskAttachments.append(row);
      }
    }

    taskAttachInput.addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (!f || !modalTaskId) return;
      state.attachments[modalTaskId] = state.attachments[modalTaskId] || [];
      state.attachments[modalTaskId].push({ id: crypto.randomUUID(), name: f.name, type: f.type, size: f.size, blob: f });
      saveState().then(() => {
        renderAttachments(modalTaskId);
        renderBoard();
        e.target.value = "";
      });
    });

    taskModalSaveTitle.onclick = () => {
      if (!modalTaskId) return;
      const res = findTask(modalTaskId);
      if (!res) return;
      const t = (taskModalTitle.value || "").trim();
      if (!t) return alert("Nome inválido.");
      res.task.title = t;
      saveState().then(renderBoard);
    };

    function openTaskModal(taskId) {
      const res = findTask(taskId);
      if (!res) return;
      modalTaskId = taskId;
      res.task.labelIds = res.task.labelIds || [];
      taskModalTitle.value = res.task.title || "";
      renderTaskLabels(res.task);
      renderLabelsChecklist(res.task);
      renderLabelsList();
      renderAttachments(taskId);
      showModal();
    }

    function renderBoard() {
      boardEl.innerHTML = "";
      for (const list of state.board) {
        const listEl = document.createElement("div");
        listEl.className = "list";

        const header = document.createElement("div");
        header.className = "list-header";
        const title = document.createElement("div");
        title.className = "list-title";
        title.textContent = list.title;

        const actions = document.createElement("div");
        actions.className = "row";

        const addTask = document.createElement("button");
        addTask.className = "icon-btn";
        addTask.title = "Nova tarefa";
        addTask.textContent = "➕";
        addTask.onclick = () => {
          const t = prompt("Nome da tarefa:");
          if (!t) return;
          list.tasks.push({ id: crypto.randomUUID(), title: t.trim(), labelIds: [] });
          saveState().then(renderBoard);
        };

        const rename = document.createElement("button");
        rename.className = "icon-btn";
        rename.title = "Renomear lista";
        rename.textContent = "✏️";
        rename.onclick = () => {
          const t = prompt("Novo nome da lista:", list.title);
          if (!t) return;
          list.title = t.trim();
          saveState().then(renderBoard);
        };

        const delList = document.createElement("button");
        delList.className = "icon-btn";
        delList.title = "Excluir lista";
        delList.textContent = "🗑️";
        delList.onclick = () => {
          if (!confirm("Excluir lista (e tarefas)?")) return;
          state.board = state.board.filter((l) => l.id !== list.id);
          saveState().then(renderBoard);
        };

        actions.append(addTask, rename, delList);
        header.append(title, actions);

        const body = document.createElement("div");
        body.className = "list-body";
        body.ondragover = (ev) => { ev.preventDefault(); body.classList.add("drop-hint"); };
        body.ondragleave = () => body.classList.remove("drop-hint");
        body.ondrop = (ev) => {
          ev.preventDefault();
          body.classList.remove("drop-hint");
          const taskId = ev.dataTransfer.getData("text/taskId");
          const fromListId = ev.dataTransfer.getData("text/fromListId");
          if (!taskId || !fromListId || fromListId === list.id) return;
          const from = state.board.find((l) => l.id === fromListId);
          const task = from?.tasks.find((t) => t.id === taskId);
          if (!from || !task) return;
          from.tasks = from.tasks.filter((t) => t.id !== taskId);
          list.tasks.push(task);
          saveState().then(renderBoard);
        };

        for (const task of list.tasks) {
          if (!Array.isArray(task.labelIds)) task.labelIds = [];
          const taskEl = document.createElement("div");
          taskEl.className = "task";
          taskEl.draggable = true;
          taskEl.ondragstart = (ev) => {
            ev.dataTransfer.setData("text/taskId", task.id);
            ev.dataTransfer.setData("text/fromListId", list.id);
          };

          const top = document.createElement("div");
          top.className = "task-top";

          const titleWrap = document.createElement("div");
          titleWrap.className = "task-title-wrap";

          const stripe = document.createElement("div");
          stripe.className = "task-stripe";
          const first = task.labelIds.map((id) => state.labels.find((l) => l.id === id)).filter(Boolean)[0];
          if (first) stripe.style.background = first.color;

          const tTitle = document.createElement("div");
          tTitle.className = "task-title";
          tTitle.textContent = task.title;

          const metaIcons = document.createElement("div");
          metaIcons.className = "task-meta-icons";
          const hasAtt = !!(state.attachments[task.id]?.length);
          if (hasAtt) {
            const clip = document.createElement("span");
            clip.className = "task-clip";
            clip.title = "Possui anexos";
            clip.textContent = "📎";
            metaIcons.append(clip);
          }

          titleWrap.append(stripe, tTitle);

          const tActions = document.createElement("div");
          tActions.className = "row";

          const tEdit = document.createElement("button");
          tEdit.className = "icon-btn";
          tEdit.title = "Renomear";
          tEdit.textContent = "✏️";
          tEdit.onclick = (ev) => {
            ev.stopPropagation();
            const n = prompt("Novo nome da tarefa:", task.title);
            if (!n) return;
            task.title = n.trim();
            saveState().then(renderBoard);
          };

          const tDel = document.createElement("button");
          tDel.className = "icon-btn";
          tDel.title = "Excluir";
          tDel.textContent = "🗑️";
          tDel.onclick = (ev) => {
            ev.stopPropagation();
            if (!confirm("Excluir tarefa?")) return;
            list.tasks = list.tasks.filter((x) => x.id !== task.id);
            delete state.attachments[task.id];
            saveState().then(renderBoard);
          };

          tActions.append(tEdit, tDel);
          top.append(titleWrap, metaIcons, tActions);
          taskEl.append(top);

          taskEl.addEventListener("click", (ev) => {
            if (ev.target.closest(".icon-btn")) return;
            openTaskModal(task.id);
          });

          body.append(taskEl);
        }

        listEl.append(header, body);
        boardEl.append(listEl);
      }
    }

    $("#addListBtn").addEventListener("click", () => {
      const t = prompt("Nome da nova lista:");
      if (!t) return;
      state.board.push({ id: crypto.randomUUID(), title: t.trim(), tasks: [] });
      saveState().then(renderBoard);
    });

    return { renderBoard };
  })();

  // ============================================================
  // Timers
  // ============================================================
    // ============================================================
  // Timers (Windows-style) - render estático + tick (sem recriar DOM a cada frame)
  // ============================================================
  
  // ================================
  // Timers (Cronômetros/Temporizadores)
  // - Sub-abas (filtro)
  // - Gráfico por cronômetro (slide) sem empurrar os outros cards
  // ================================
  const Timers = (() => {
    const timerGrid = $("#timerGrid");
    const createTimerBtn = $("#createTimerBtn");
    const filterStopBtn = document.querySelector("#timerFilterStopwatch");
    const filterCdBtn = document.querySelector("#timerFilterCountdown");

    // Create modal
    const timerCreateModal = $("#timerCreateModal");
    const timerCreateClose = $("#timerCreateClose");
    const timerCreateX = $("#timerCreateX");
    const timerNameInput = $("#timerNameInput");
    const timerCreateSave = $("#timerCreateSave");
    const countdownSettings = $("#countdownSettings");
    const cdHours = $("#cdHours");
    const cdMinutes = $("#cdMinutes");
    const cdSeconds = $("#cdSeconds");

    // DOM cache per timerId
    const dom = new Map(); // id -> {card,timeEl,statusEl,progEl,attemptsEl,noteEl,playBtn,chartPanel,chartCanvas,chartEmpty,toggleBtn}

    function ensureUI(){
      state.ui = state.ui || {};
      if(state.ui.timerFilter !== "stopwatch" && state.ui.timerFilter !== "countdown"){
        state.ui.timerFilter = "stopwatch";
      }
    }

    function getVisibleTimers(){
      ensureUI();
      const f = state.ui.timerFilter;
      return (state.timers || []).filter(t => (f === "stopwatch" ? t.kind === "stopwatch" : t.kind === "countdown"));
    }

    function syncFilterUI(){
      ensureUI();
      const f = state.ui.timerFilter;
      filterStopBtn?.classList.toggle("active", f === "stopwatch");
      filterStopBtn?.setAttribute("aria-selected", f === "stopwatch" ? "true" : "false");
      filterCdBtn?.classList.toggle("active", f === "countdown");
      filterCdBtn?.setAttribute("aria-selected", f === "countdown" ? "true" : "false");
    }

    filterStopBtn?.addEventListener("click", () => {
      ensureUI();
      state.ui.timerFilter = "stopwatch";
      saveState();
      syncFilterUI();
      render();
    });
    filterCdBtn?.addEventListener("click", () => {
      ensureUI();
      state.ui.timerFilter = "countdown";
      saveState();
      syncFilterUI();
      render();
    });

    // ---------- Modal ----------
    function openTimerCreate(){
      ensureUI();
      timerCreateModal?.classList.remove("hidden");
      if(timerNameInput) timerNameInput.value = "";
      if(cdHours) cdHours.value = 0;
      if(cdMinutes) cdMinutes.value = 5;
      if(cdSeconds) cdSeconds.value = 0;

      const sw = document.querySelector('input[name="timerKind"][value="stopwatch"]');
      const cd = document.querySelector('input[name="timerKind"][value="countdown"]');
      if(state.ui.timerFilter === "countdown"){
        cd && (cd.checked = true);
        countdownSettings && (countdownSettings.style.display = "block");
      } else {
        sw && (sw.checked = true);
        countdownSettings && (countdownSettings.style.display = "none");
      }
    }
    function closeTimerCreate(){
      timerCreateModal?.classList.add("hidden");
    }

    createTimerBtn?.addEventListener("click", openTimerCreate);
    timerCreateClose?.addEventListener("click", closeTimerCreate);
    timerCreateX?.addEventListener("click", closeTimerCreate);

    document.querySelectorAll('input[name="timerKind"]').forEach(r => {
      r.addEventListener("change", () => {
        const kind = document.querySelector('input[name="timerKind"]:checked')?.value;
        if(countdownSettings) countdownSettings.style.display = (kind === "countdown") ? "block" : "none";
      });
    });

    function fmtMs(ms){
      ms = Math.max(0, Math.floor(ms));
      const h = Math.floor(ms/3600000); ms -= h*3600000;
      const m = Math.floor(ms/60000); ms -= m*60000;
      const s = Math.floor(ms/1000);
      const mm = ms - s*1000;
      return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(mm).padStart(3,"0")}`;
    }

    function createTimer(kind, name, targetMs=0){
      state.timers = state.timers || [];
      state.timers.unshift({
        id: crypto.randomUUID(),
        kind, // stopwatch | countdown
        name: name || (kind === "countdown" ? "Temporizador" : "Cronômetro"),
        targetMs: kind === "countdown" ? targetMs : 0,
        elapsedMs: 0,
        running: false,
        startedAt: null,
        logs: [],
        chartOpen: kind === "stopwatch",
      });
    }

    timerCreateSave?.addEventListener("click", async () => {
      const kind = document.querySelector('input[name="timerKind"]:checked')?.value || "stopwatch";
      const name = (timerNameInput?.value || "").trim();

      if(kind === "countdown"){
        const h = parseInt(cdHours?.value || "0",10) || 0;
        const m = parseInt(cdMinutes?.value || "0",10) || 0;
        const s = parseInt(cdSeconds?.value || "0",10) || 0;
        const total = (h*3600 + m*60 + s) * 1000;
        if(total <= 0){ alert("Defina uma duração maior que zero."); return; }
        createTimer("countdown", name || "Temporizador", total);
      } else {
        createTimer("stopwatch", name || "Cronômetro", 0);
      }

      await saveState();
      closeTimerCreate();
      render();
    });

    // ---------- Time core ----------
    function currentElapsed(t){
      if(!t.running) return t.elapsedMs;
      return t.elapsedMs + Math.max(0, performance.now() - t.startedAt);
    }
    function remainingMs(t){
      return Math.max(0, (t.targetMs || 0) - currentElapsed(t));
    }
    function start(t){
      if(t.running) return;
      t.running = true;
      t.startedAt = performance.now();
    }
    function pause(t){
      if(!t.running) return;
      t.elapsedMs = currentElapsed(t);
      t.running = false;
      t.startedAt = null;
    }
    function reset(t){
      t.running = false;
      t.startedAt = null;
      t.elapsedMs = 0;
    }

    // ---------- Chart ----------
    function drawLineChart(canvas, values){
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(320, Math.floor(rect.width || 0));
      const cssH = Math.max(180, Math.floor(rect.height || 0));
      const pxW = Math.floor(cssW * dpr);
      const pxH = Math.floor(cssH * dpr);
      if(canvas.width !== pxW || canvas.height !== pxH){
        canvas.width = pxW;
        canvas.height = pxH;
      }
      const ctx = canvas.getContext("2d");
      // draw in CSS pixels
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.clearRect(0,0,cssW,cssH);
      const w = cssW, h = cssH;

      const padL=50, padR=18, padT=12, padB=26;
      const iw = w - padL - padR;
      const ih = h - padT - padB;

      ctx.save();
      ctx.translate(padL, padT);
      ctx.strokeStyle = "rgba(255,255,255,.07)";
      ctx.lineWidth = 1;
      const gridY = 4;
      for(let i=0;i<=gridY;i++){
        const y = (ih * i)/gridY;
        ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(iw,y); ctx.stroke();
      }
      ctx.restore();

      const minV = Math.min(...values);
      const maxV = Math.max(...values);
      const range = Math.max(1, maxV - minV);
      const xStep = values.length <= 1 ? iw : iw/(values.length-1);

      ctx.save();
      ctx.translate(padL, padT);
      ctx.strokeStyle = "rgba(88,101,242,.90)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      for(let i=0;i<values.length;i++){
        const x = i*xStep;
        const y = ih - ((values[i]-minV)/range)*ih;
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();

      ctx.fillStyle = "rgba(242,243,245,.95)";
      for(let i=0;i<values.length;i++){
        const x = i*xStep;
        const y = ih - ((values[i]-minV)/range)*ih;
        ctx.beginPath(); ctx.arc(x,y,5,0,Math.PI*2); ctx.fill();
      }
      ctx.restore();

      ctx.fillStyle = "rgba(181,186,193,.95)";
      ctx.font = "24px ui-sans-serif, system-ui";
      ctx.textBaseline="middle";
      ctx.fillText(String(Math.round(maxV))+" ms", 8, 18);
      ctx.fillText(String(Math.round(minV))+" ms", 8, h-18);
      ctx.textBaseline="alphabetic";
      ctx.fillText("Tentativas", w/2-70, h-6);
    }

    function updateChart(id){
      const t = (state.timers || []).find(x=>x.id===id);
      const d = dom.get(id);
      if(!t || !d) return;

      if(t.kind !== "stopwatch"){
        d.chartPanel.classList.remove("open");
        d.chartEmpty.style.display="block";
        d.chartEmpty.textContent = "Temporizadores não possuem gráfico.";
        return;
      }

      d.chartPanel.classList.toggle("open", !!t.chartOpen);
      d.toggleBtn.classList.toggle("on", !!t.chartOpen);

      if(!t.chartOpen) return;

      const vals = (t.logs||[]).map(x=>x.ms);
      if(vals.length < 2){
        d.chartEmpty.style.display="block";
        d.chartEmpty.textContent = "Faça pelo menos 2 tentativas para gerar o gráfico.";
        const ctx=d.chartCanvas.getContext("2d");
        ctx.clearRect(0,0,d.chartCanvas.width,d.chartCanvas.height);
        return;
      }

      d.chartEmpty.style.display="none";
      drawLineChart(d.chartCanvas, vals);
    }

    function renderNotes(list){
      const arr = list || (state.timers || []);
      for(const t of arr){
        const d = dom.get(t.id);
        if(!d) continue;
        if(!t.chartOpen || t.kind!=="stopwatch" || (t.logs||[]).length < 2){
          d.noteEl.textContent = "";
          continue;
        }
        const first=t.logs[0].ms;
        const last=t.logs[t.logs.length-1].ms;
        const diff= last-first;
        const trend = diff < 0 ? "melhora" : (diff>0 ? "piora" : "estável");
        d.noteEl.textContent = `Tendência: ${trend} • Primeira: ${fmtMs(first)} • Última: ${fmtMs(last)}`;
      }
    }

    // ---------- Card DOM ----------
    function buildCard(t){
      const card=document.createElement("div");
      card.className="timer-card";
      card.dataset.timerId=t.id;

      const title=document.createElement("div");
      title.className="timer-name";

      const leftTitle=document.createElement("div");
      leftTitle.style.display="flex";
      leftTitle.style.alignItems="center";
      leftTitle.style.gap="10px";
      leftTitle.style.minWidth="0";
      leftTitle.innerHTML = `<span style="font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.name)}</span>`;

      const rightTitle=document.createElement("div");
      rightTitle.style.display="flex";
      rightTitle.style.alignItems="center";
      rightTitle.style.gap="10px";

      const toggle=document.createElement("button");
      toggle.className="timer-chart-toggle";
      toggle.type="button";
      toggle.innerHTML = `<span class="dot"></span><span>Gráfico</span>`;
      if(t.kind==="countdown"){
        toggle.disabled=true;
        toggle.style.opacity="0.45";
        toggle.style.cursor="not-allowed";
      } else {
        toggle.classList.toggle("on", !!t.chartOpen);
      }

      const kind=document.createElement("span");
      kind.className="timer-kind";
      kind.textContent = (t.kind==="countdown" ? "Temporizador" : "Cronômetro");

      rightTitle.append(toggle, kind);
      title.append(leftTitle, rightTitle);

      const time=document.createElement("div");
      time.className="timer-time";

      const sub=document.createElement("div");
      sub.className="timer-sub";
      const left=document.createElement("div");
      const right=document.createElement("div");
      sub.append(left,right);

      const prog=document.createElement("div");
      prog.className="timer-progress";
      const progInner=document.createElement("div");
      prog.append(progInner);

      const actions=document.createElement("div");
      actions.className="timer-actions";

      const play=document.createElement("button");
      play.className="timer-btn primary";
      play.title = "Iniciar/Pausar";
      play.onclick = () => {
        if(t.running) pause(t); else start(t);
        saveState();
        updateOne(t.id);
      };

      const rst=document.createElement("button");
      rst.className="timer-btn";
      rst.textContent="↺";
      rst.title="Zerar";
      rst.onclick=()=>{ reset(t); saveState(); updateOne(t.id); };

      const saveAttempt=document.createElement("button");
      saveAttempt.className="timer-btn";
      saveAttempt.textContent="💾";
      saveAttempt.title="Salvar tentativa";
      if(t.kind==="countdown") saveAttempt.style.display="none";
      saveAttempt.onclick=()=>{
        t.logs = t.logs || [];
        t.logs.push({ ms: currentElapsed(t), at: Date.now() });
        saveState();
        updateOne(t.id);
        updateChart(t.id);
        renderNotes(getVisibleTimers());
      };

      const del=document.createElement("button");
      del.className="btn danger small";
      del.textContent="🗑 Excluir";
      del.onclick=()=>{
        if(!confirm("Excluir este cronômetro?")) return;
        state.timers = (state.timers || []).filter(x=>x.id!==t.id);
        saveState().then(render);
      };

      actions.append(play, rst, saveAttempt, del);

      const note=document.createElement("div");
      note.className="timer-note";

      const chartPanel=document.createElement("div");
      chartPanel.className = "chart-panel" + (t.chartOpen ? " open" : "");
      const chartHead=document.createElement("div");
      chartHead.className="chart-head";
      chartHead.innerHTML = `<div class="chart-title">Gráfico de tentativas</div><div class="muted small-text">Tempo (ms)</div>`;
      const chartBody=document.createElement("div");
      chartBody.className="chart-body";
      const chartEmpty=document.createElement("div");
      chartEmpty.className="chart-empty";
      chartEmpty.textContent="Faça pelo menos 2 tentativas para gerar o gráfico.";
      const canvas=document.createElement("canvas");
      canvas.className="chart-canvas";

      chartBody.append(chartEmpty, canvas);
      chartPanel.append(chartHead, chartBody);

      // toggle interaction
      toggle.onclick = () => {
        if(t.kind!=="stopwatch") return;
        t.chartOpen = !t.chartOpen;
        saveState();
        updateChart(t.id);
        requestAnimationFrame(() => updateChart(t.id));
        renderNotes(getVisibleTimers());
      };

      card.append(title,time,sub,prog,actions,note,chartPanel);

      dom.set(t.id, { card, timeEl: time, statusEl: right, progEl: progInner, attemptsEl: left, noteEl: note, playBtn: play, chartPanel, chartCanvas: canvas, chartEmpty, toggleBtn: toggle });
      return card;
    }

    function updateOne(id){
      const t = (state.timers || []).find(x=>x.id===id);
      const d = dom.get(id);
      if(!t || !d) return;

      const el = currentElapsed(t);
      const shown = (t.kind==="countdown") ? remainingMs(t) : el;
      d.timeEl.textContent = fmtMs(shown);
      d.statusEl.textContent = t.running ? "Rodando" : "Pausado";
      d.playBtn.textContent = t.running ? "⏸" : "▶";

      d.attemptsEl.textContent = t.kind==="countdown"
        ? `Duração: ${fmtMs(t.targetMs).split('.')[0]}`
        : `Tentativas: ${(t.logs||[]).length}`;

      if(t.kind==="countdown"){
        const p = Math.min(1, Math.max(0, el / Math.max(1, t.targetMs)));
        d.progEl.style.width = `${Math.round(p*100)}%`;
        d.progEl.style.background = "rgba(88,101,242,.55)";
        if(shown<=0 && t.running){
          pause(t);
          saveState();
        }
      }else{
        d.progEl.style.width = "0%";
        d.progEl.style.background = "transparent";
      }
    }

    function render(){
      if(!timerGrid) return;
      ensureUI();
      syncFilterUI();

      const visible = getVisibleTimers();

      timerGrid.innerHTML = "";
      dom.clear();

      if(visible.length === 0){
        const m=document.createElement("div");
        m.className="muted small-text";
        m.textContent="Nenhum item aqui ainda. Clique em + Novo.";
        timerGrid.append(m);
        return;
      }

      for(const t of visible){
        timerGrid.append(buildCard(t));
      }

      for(const t of visible){
        updateOne(t.id);
        updateChart(t.id);
      }
      renderNotes(visible);

      if(!rafRunning){
        rafRunning = true;
        requestAnimationFrame(tick);
      }
    }

    let rafRunning = false;
    function tick(){
      const visibleIds = new Set([...dom.keys()]);
      for(const t of (state.timers || [])){
        if(!visibleIds.has(t.id)) continue;
        if(t.running || t.kind==="countdown"){
          updateOne(t.id);
        }
      }
      requestAnimationFrame(tick);
    }

    return { render };
  })();
// ---------- Export/Import/Reset ----------
  $("#btnExport").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ version: 20, exportedAt: new Date().toISOString(), state }, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ctspsskills-dados.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#importJson").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    f.text()
      .then((txt) => JSON.parse(txt))
      .then((obj) => {
        if (!obj || !obj.state) throw new Error("Arquivo inválido.");
        state = migrateState(obj.state);
        return saveState();
      })
      .then(() => {
        Tasks.renderBoard();
        Timers.render();
        alert("Dados importados com sucesso.");
      })
      .catch((err) => alert("Falha ao importar: " + err.message))
      .finally(() => (e.target.value = ""));
  });

  $("#btnReset").addEventListener("click", () => {
    if (!confirm("Resetar tudo (cronograma, tarefas, timers)?")) return;
    state = structuredCloneSafe(DEFAULT_STATE);
    Promise.all([db.app.clear(), db.schedule.clear()])
      .then(() => Schedule.renderSchedule())
      .then(() => {
        Tasks.renderBoard();
        Timers.render();
        alert("Reset concluído.");
      });
  });

  // ---------- Boot ----------
  function boot() {
    // tab events
    $$(".nav-item").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

    // load state
    db.app
      .getItem("state")
      .then((s) => {
        state = migrateState(s ?? structuredCloneSafe(DEFAULT_STATE));
      })
      .then(() => Schedule.init())
      .then(() => {
        Tasks.renderBoard();
        Timers.render();
        setTab("schedule");
      })
      .catch((err) => {
        console.error(err);
        alert("Falha ao inicializar: " + err.message);
      });
  }

  boot();
})();
