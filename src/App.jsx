import React, { useEffect, useMemo, useRef, useState } from "react";

// --- OCR: 共有オプション（Safari対策: 外部辞書URLを明示）
const TESS_OPTS = { langPath: "https://tessdata.projectnaptha.com/4.0.0" };
  // 日本語辞書のCDN（軽量で安定）
  langPath: "https://tessdata.projectnaptha.com/4.0.0",
  // 解析モード: 6=単一ブロック内のテキスト（ホワイトボードの枠向き）
  // 必要なら 4（段落）/ 11（スパース）に変更して試せます
  // 注意：tesseract.js v5では "psm" は config で渡す
  // 例: { tessedit_pageseg_mode: 6 }
};

/* =========================
   放デイ送迎アプリ v7
   追加:
   - 名簿パネルの幅をドラッグで調整（スプリッター）
   - ホワイトボード取り込み（領域指定β：4x2=8車グリッドを画像上に重ねてOCR）
   既存:
   - iPad/Safari対策: structuredClone代替, OCRは動的読み込み
   - 行き/帰り、8車固定、非スクロールページ
   - 所属カラー固定(設定でロックON/OFF)
   - 日付：今日±10日＋<input type="date">
   - CSV入出力（降車なし: 日付,便,車両,氏名,所属,ピックアップ）
   ========================= */

// ---- Safari/iPad対策: structuredClone 代替
const clone = (obj) =>
  typeof structuredClone === "function"
    ? structuredClone(obj)
    : JSON.parse(JSON.stringify(obj));

/** @typedef {{ id: string; name: string; group?: string }} Student */
/** @typedef {{ studentId: string; pickup: string }} Assignment */
const VEHICLE_COUNT = 8;
const VEHICLE_IDS = Array.from({ length: VEHICLE_COUNT }, (_, i) => `v${i + 1}`);

const STORAGE_KEY = "dispatch-mvp-v7";

// ---- 日付 utils
function fmt(d) { return d.toISOString().slice(0, 10); }
function todayStr() { return fmt(new Date()); }
function clampDateStr(s) {
  const base = new Date(); base.setHours(0, 0, 0, 0);
  const min = new Date(base); min.setDate(base.getDate() - 10);
  const max = new Date(base); max.setDate(base.getDate() + 10);
  const d = new Date(s);
  return fmt(new Date(Math.min(Math.max(d.getTime(), min.getTime()), max.getTime())));
}
function shiftDateStr(s, delta) {
  const d = new Date(s); d.setDate(d.getDate() + delta);
  return clampDateStr(fmt(d));
}

// ---- LocalStorage
const LS = {
  load() { try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; } },
  save(v) { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); }
};

// ---- 施設デフォ所属（設定で編集可能）
const DEFAULT_GROUPS = [
  { name: "赤", color: "#ef4444" },
  { name: "青", color: "#3b82f6" },
  { name: "緑", color: "#22c55e" },
  { name: "橙", color: "#f59e0b" },
  { name: "紫", color: "#8b5cf6" },
  { name: "灰", color: "#6b7280" },
];

function colorForGroup(groups, groupName) {
  if (!groupName) return "#9ca3af";
  const f = groups.find(g => g.name === groupName);
  return f ? f.color : "#9ca3af";
}

function enforceGroup(groups, groupLock, inputName) {
  if (!groupLock) return inputName || "";
  const list = groups.map(g => g.name);
  return list.includes(inputName) ? inputName : (list[0] || "");
}

function emptyVehicleMap() {
  return Object.fromEntries(VEHICLE_IDS.map(id => [id, /** @type {Assignment[]} */([])]));
}
function uid() { return Math.random().toString(36).slice(2, 9); }

// ---- 画像前処理（拡大＋グレースケール＋二値化）
// 画像前処理：拡大 → グレースケール → 自動二値化（Otsu） → 濃さ調整
async function preprocessImageBlob(blob, { scale = 2, invert = false } = {}) {
  const img = new Image();
  const url = URL.createObjectURL(blob);
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth * scale;
  canvas.height = img.naturalHeight * scale;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = id.data;

  // 1) グレースケール + ヒストグラム
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const gi = Math.max(0, Math.min(255, g | 0));
    d[i] = d[i + 1] = d[i + 2] = gi;
    hist[gi]++;
  }

  // 2) Otsu で二値化のしきい値を自動決定
  let total = canvas.width * canvas.height;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, wF = 0, max = 0, threshold = 180;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue;
    wF = total - wB; if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; threshold = t; }
  }

  // 3) 二値化 + 反転オプション
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] > threshold ? 255 : 0;
    const bin = invert ? (255 - v) : v;
    d[i] = d[i + 1] = d[i + 2] = bin;
  }
  ctx.putImageData(id, 0, 0);

  URL.revokeObjectURL(url);
  return await new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
}

  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = g > 180 ? 255 : 0; // しきい値は 160-200 で調整可能
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(id, 0, 0);

  return await new Promise(res => canvas.toBlob(b => { URL.revokeObjectURL(url); res(b); }, "image/png"));
}

// 画像の一部を切り出してBlobにする
async function cropBlob(originalBlob, crop) {
  const img = new Image();
  const url = URL.createObjectURL(originalBlob);
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });

  const canvas = document.createElement("canvas");
  canvas.width = crop.w;
  canvas.height = crop.h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  URL.revokeObjectURL(url);
  return await new Promise(res => canvas.toBlob(b => res(b), "image/png"));
}

export default function App() {
  const persisted = LS.load();

  // 設定：所属リスト＆ロック
  const [groups, setGroups] = useState(persisted?.groups ?? DEFAULT_GROUPS);
  const [groupLock, setGroupLock] = useState(persisted?.groupLock ?? true); // 初期ON: 固定

  // 名簿（全日共通）
  const [students, setStudents] = useState/** @type {Student[]} */(
    persisted?.students ?? [
      { id: uid(), name: "山田 太郎", group: "赤" },
      { id: uid(), name: "佐藤 花子", group: "青" },
      { id: uid(), name: "鈴木 次郎", group: "緑" },
      { id: uid(), name: "田中 三郎", group: "灰" },
    ]
  );
　// 追加：車の有効/無効（デフォルトは全ON）
　const [enabledVehicles, setEnabledVehicles] = useState(
  persisted?.enabledVehicles ?? Object.fromEntries(VEHICLE_IDS.map(id => [id, true]))
);

  // 日付→便→配車
  const [byDate, setByDate] = useState/** @type {Record<string,{go:any,back:any}>} */(
    persisted?.byDate ?? { [todayStr()]: { go: emptyVehicleMap(), back: emptyVehicleMap() } }
  );
  const [selectedDate, setSelectedDate] = useState(
    persisted?.selectedDate ? clampDateStr(persisted.selectedDate) : todayStr()
  );
  const [mode, setMode] = useState/** @type {"go"|"back"} */(persisted?.mode ?? "go");

  // 車名
  const [vehicleNames, setVehicleNames] = useState(
    persisted?.vehicleNames ?? Object.fromEntries(VEHICLE_IDS.map((id, i) => [id, `車${i + 1}`]))
  );

  // 名簿追加UI
  const [newName, setNewName] = useState("");
  const [newGroup, setNewGroup] = useState(groups[0]?.name ?? "");

  // 設定モーダル
  const [openSettings, setOpenSettings] = useState(false);

  // OCR 状態
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrLog, setOcrLog] = useState("");

  // iPad Pointer DnD
  const [draggingId, setDraggingId] = useState/** @type {string|null} */(null);
  const [dragPos, setDragPos] = useState({ x: 0, y: 0 });
  const [hoverVehicle, setHoverVehicle] = useState/** @type {string|null} */(null);
  const vehicleRefs = useRef(Object.fromEntries(VEHICLE_IDS.map(id => [id, React.createRef()])));

　// 表示対象の車（ONのみ）
　const VISIBLE_VEHICLES = VEHICLE_IDS.filter(id => enabledVehicles[id]);

  // 名簿パネル幅（ドラッグ調整）
  const [rosterWidth, setRosterWidth] = useState(persisted?.rosterWidth ?? 360);
  const [resizing, setResizing] = useState(false);

  // ホワイトボード取り込みモーダル
  const [wbOpen, setWbOpen] = useState(false);
  const [wbImage, setWbImage] = useState/** @type {Blob|null} */(null);
  // グリッド配置（%単位）
  const [wbMargins, setWbMargins] = useState(persisted?.wbMargins ?? { top: 5, left: 5, right: 5, bottom: 5 });
  const [wbGaps, setWbGaps] = useState(persisted?.wbGaps ?? { col: 2, row: 2 });

  // 選択日の存在保証
  useEffect(() => {
    setByDate(prev => {
      if (prev[selectedDate]) return prev;
      return { ...prev, [selectedDate]: { go: emptyVehicleMap(), back: emptyVehicleMap() } };
    });
  }, [selectedDate]);

  // 保存
  useEffect(() => {
    LS.save({ students, byDate, vehicleNames, selectedDate, mode, groups, groupLock, rosterWidth, wbMargins, wbGaps,
    enabledVehicles,  });
  }, [students, byDate, vehicleNames, selectedDate, mode, groups, groupLock, rosterWidth, wbMargins, wbGaps, enabledVehicles]);

  const dayData = byDate[selectedDate] ?? { go: emptyVehicleMap(), back: emptyVehicleMap() };
  const vehicles = mode === "go" ? dayData.go : dayData.back;

  const byId = useMemo(() => Object.fromEntries(students.map(s => [s.id, s])), [students]);

  const unassignedIds = useMemo(() => {
    const assigned = new Set(Object.values(vehicles).flatMap(arr => arr.map(a => a.studentId)));
    return students.filter(s => !assigned.has(s.id)).map(s => s.id);
  }, [students, vehicles]);

  // vehicles 書き換えラッパ
  function updateVehicles(mutator) {
    setByDate(prev => {
      const copy = clone(prev);
      if (!copy[selectedDate]) copy[selectedDate] = { go: emptyVehicleMap(), back: emptyVehicleMap() };
      const target = mode === "go" ? copy[selectedDate].go : copy[selectedDate].back;
      const next = mutator(target);
      if (mode === "go") copy[selectedDate].go = next; else copy[selectedDate].back = next;
      return copy;
    });
  }

  function updateTime(vehicleId, studentId, value) {
    updateVehicles(prev => {
      const copy = clone(prev);
      const arr = copy[vehicleId];
      const idx = arr.findIndex(a => a.studentId === studentId);
      if (idx >= 0) arr[idx].pickup = value;
      return copy;
    });
  }

  function addStudent() {
    const name = newName.trim(); if (!name) return;
    const safeGroup = enforceGroup(groups, groupLock, newGroup);
    setStudents(s => [...s, { id: uid(), name, group: safeGroup }]);
    setNewName("");
  }

  function setStudentGroup(id, group) {
    const safe = enforceGroup(groups, groupLock, group);
    setStudents(prev => prev.map(s => s.id === id ? { ...s, group: safe } : s));
  }

  function removeStudent(id) {
    setStudents(s => s.filter(x => x.id !== id));
    setByDate(prev => {
      const cp = clone(prev);
      for (const d of Object.keys(cp)) {
        for (const bin of ["go", "back"]) {
          for (const vid of Object.keys(cp[d][bin])) {
            cp[d][bin][vid] = cp[d][bin][vid].filter(a => a.studentId !== id);
          }
        }
      }
      return cp;
    });
  }

  function unassignCurrentDay(id) {
    updateVehicles(prev => {
      const copy = clone(prev);
      for (const vid of Object.keys(copy)) copy[vid] = copy[vid].filter(a => a.studentId !== id);
      return copy;
    });
  }

  // CSV 出力（列：日付,便,車両,氏名,所属,ピックアップ）
  function exportCSV() {
    const rows = [["日付", "便", "車両", "氏名", "所属", "ピックアップ"]];
    const current = mode === "go" ? dayData.go : dayData.back;
     for (const vid of VISIBLE_VEHICLES) {
      for (const a of current[vid]) {
        rows.push([
          selectedDate,
          mode === "go" ? "行き" : "帰り",
          vehicleNames[vid],
          byId[a.studentId]?.name ?? "",
          byId[a.studentId]?.group ?? "",
          a.pickup ?? "",
        ]);
      }
    }
    const csv = rows.map(r => r.map(x => `"${String(x ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `送迎_${selectedDate}_${mode}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  // CSV 入力（A: 日付,便,車両,氏名,所属,ピック / B: 車両,氏名,所属,ピック）
  function importCSV(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (!lines.length) return;
      const header = lines[0].split(",");
      const hasDate = /日付/.test(header[0]);
      const data = (hasDate || /車両/.test(header[0])) ? lines.slice(1) : lines;

      const nameToId = new Map(students.map(s => [s.name, s.id]));
      const nextByDate = clone(byDate);
      const nextVehicleNames = { ...vehicleNames };
      const nextStudents = [...students];

      for (const line of data) {
        const cols = parseCsvLine(line); if (!cols) continue;
        let dStr, binLabel, car, name, group, pickup;
        if (hasDate) { [dStr, binLabel, car, name, group, pickup] = cols; }
        else { [car, name, group, pickup] = cols; dStr = selectedDate; binLabel = mode === "go" ? "行き" : "帰り"; }
        if (!dStr) dStr = selectedDate;
        dStr = clampDateStr(dStr);
        if (!nextByDate[dStr]) nextByDate[dStr] = { go: emptyVehicleMap(), back: emptyVehicleMap() };

        if (!name) continue;
        if (!nameToId.has(name)) { const id = uid(); nameToId.set(name, id); nextStudents.push({ id, name, group: group || "" }); }
        const id = nameToId.get(name);

        if (group) {
          const idx = nextStudents.findIndex(s => s.id === id);
          if (idx >= 0) nextStudents[idx].group = enforceGroup(groups, groupLock, group);
        }

        let vid = Object.keys(nextVehicleNames).find(k => nextVehicleNames[k] === car);
        if (!vid) { vid = VEHICLE_IDS.find(x => nextVehicleNames[x].startsWith("車")) ?? VEHICLE_IDS[0]; nextVehicleNames[vid] = car || nextVehicleNames[vid]; }

        const binKey = (binLabel === "行き") ? "go" : "back";
        for (const k of Object.keys(nextByDate[dStr][binKey])) {
          nextByDate[dStr][binKey][k] = nextByDate[dStr][binKey][k].filter(a => a.studentId !== id);
        }
        nextByDate[dStr][binKey][vid].push({ studentId: id, pickup: pickup ?? "" });
      }

      setStudents(nextStudents);
      setVehicleNames(nextVehicleNames);
      setByDate(nextByDate);
    };
    reader.readAsText(file, "utf-8");
  }

  function parseCsvLine(line) {
    const out = []; let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; } }
        else { cur += ch; }
      } else {
        if (ch === ",") { out.push(cur); cur = ""; }
        else if (ch === '"') { inQ = true; }
        else { cur += ch; }
      }
    }
    out.push(cur);
    return out;
  }

  // ---- OCR（β）：行解析（従来の簡易取込）
 // 1枚の画像からOCR（行解析・安定版）
async function importFromImage(file) {
  setOcrBusy(true);
  setOcrLog("前処理…");

  try {
    // 濃淡に強い前処理（Otsu二値化）。薄い時は invert: true も試せる
    const processed = await preprocessImageBlob(file, { scale: 2, invert: false });

    setOcrLog("OCR読込…");
    const { default: Tesseract } = await import("tesseract.js");

    setOcrLog("解析中…");
    const { data } = await Tesseract.recognize(processed, "jpn", {
      ...TESS_OPTS,                    // ← 日本語辞書の場所を指定（Safari安定）
      tessedit_pageseg_mode: 6,        // ← 1枠=1テキストブロックとして扱う
      tessedit_char_whitelist:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789一二三四五六七八九十〇零号車行帰名・、,-:： 　"
    });

    const text = data?.text ?? "";
    setOcrLog("取込中…");

    // 例）「3号車：山田,佐藤」などを行ごとに処理
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    const nameToId = new Map(students.map(s => [s.name, s.id]));
    const nextStudents = [...students];

    updateVehicles(prev => {
      const copy = clone(prev);
      const touched = new Set();

      for (const line of lines) {
        const m = line.match(/(?:車\s*(\d+)|(\d+)号車)/);
        let carIdx = null;
        if (m) carIdx = parseInt(m[1] || m[2], 10);

        let namesPart = line;
        if (/:|：/.test(line)) namesPart = line.split(/:|：/).slice(1).join(" ");
        namesPart = namesPart.replace(/(?:車\s*\d+|\d+号車)/g, "");

        const names = namesPart
          .split(/[,\s、・]+/)
          .map(s => s.trim())
          .filter(Boolean);

        if (carIdx && carIdx >= 1 && carIdx <= 8 && names.length) {
          const vid = `v${carIdx}`;
          if (!touched.has(vid)) { copy[vid] = []; touched.add(vid); }
          for (const nm of names) {
            if (!nameToId.has(nm)) {
              const id = uid();
              nameToId.set(nm, id);
              nextStudents.push({ id, name: nm });
            }
            const id = nameToId.get(nm);
            for (const k of Object.keys(copy)) {
              copy[k] = copy[k].filter(a => a.studentId !== id);
            }
            copy[vid].push({ studentId: id, pickup: "" });
          }
        }
      }

      setStudents(nextStudents);
      return copy;
    });

    setOcrLog("完了");
  } catch (e) {
    console.error(e);
    setOcrLog("OCR失敗（照明・ピント・傾き／辞書ロードを確認）");
  } finally {
    setTimeout(() => setOcrBusy(false), 600);
  }
}


  // ---- ホワイトボード領域指定 OCR（8車グリッド）
  async function wbRunImport() {
    if (!wbImage) return;
    setOcrBusy(true);
    setOcrLog("ホワイトボード画像解析…");

    try {
      // 元画像サイズ取得
      const img = new Image();
      const url = URL.createObjectURL(wbImage);
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const W = img.naturalWidth, H = img.naturalHeight;
      URL.revokeObjectURL(url);

      // マージン・ギャップ（%）から8セル（4x2）座標を算出
      const leftPx = (wbMargins.left / 100) * W;
      const rightPx = (wbMargins.right / 100) * W;
      const topPx = (wbMargins.top / 100) * H;
      const bottomPx = (wbMargins.bottom / 100) * H;
      const gridW = W - leftPx - rightPx;
      const gridH = H - topPx - bottomPx;
      const colGapPx = (wbGaps.col / 100) * gridW;
      const rowGapPx = (wbGaps.row / 100) * gridH;

      const cellW = (gridW - colGapPx * 3) / 4;
      const cellH = (gridH - rowGapPx * 1) / 2;

      const cells = [];
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 4; c++) {
          const x = Math.round(leftPx + c * (cellW + colGapPx));
          const y = Math.round(topPx + r * (cellH + rowGapPx));
          cells.push({ x, y, w: Math.round(cellW), h: Math.round(cellH) });
        }
      }

      // 各セルを切り出し → 前処理 → OCR → v1..v8に順に割当
      const { default: Tesseract } = await import("tesseract.js");
      const nameToId = new Map(students.map(s => [s.name, s.id]));
      const nextStudents = [...students];

      updateVehicles(prev => {
        const copy = clone(prev);
        // 一旦全車クリア（上書き想定）
        for (const vid of Object.keys(copy)) copy[vid] = [];

        return copy;
      });

      for (let i = 0; i < cells.length; i++) {
        const crop = await cropBlob(wbImage, cells[i]);
        const pre = await preprocessImageBlob(crop);
        const { data } = await Tesseract.recognize(pre, "jpn", {
          tessedit_char_whitelist:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789一二三四五六七八九十〇零号車行帰名・、,-:： 　"
        });
        const text = (data?.text ?? "").replace(/\s+/g, " ");
        // セル内の名前候補（区切り：空白/読点/中黒など）
        const names = text.split(/[,\s、・]+/).map(s => s.trim()).filter(Boolean);

        updateVehicles(prev => {
          const copy = clone(prev);
          const vid = `v${i + 1}`; // 左上→右、次の行の左→右
          for (const nm of names) {
            if (!nm) continue;
            if (!nameToId.has(nm)) { const id = uid(); nameToId.set(nm, id); nextStudents.push({ id, name: nm }); }
            const id = nameToId.get(nm);
            for (const k of Object.keys(copy)) copy[k] = copy[k].filter(a => a.studentId !== id);
            copy[vid].push({ studentId: id, pickup: "" });
          }
          return copy;
        });
      }
      setStudents(nextStudents);
      setOcrLog("ホワイトボード取り込み完了");
      setWbOpen(false);
    } catch (e) {
      console.error(e);
      setOcrLog("取り込み失敗。マージン/ギャップを調整して再試行してください。");
    } finally {
      setTimeout(() => setOcrBusy(false), 800);
    }
  }

  function resetAll() {
    if (!confirm("すべて初期化しますか？")) return;
    setStudents([]);
    setByDate({ [todayStr()]: { go: emptyVehicleMap(), back: emptyVehicleMap() } });
    setVehicleNames(Object.fromEntries(VEHICLE_IDS.map((id, i) => [id, `車${i + 1}`])));
    setSelectedDate(todayStr());
    setMode("go");
    setGroups(DEFAULT_GROUPS);
    setGroupLock(true);
    setRosterWidth(360);
  }
  function printView() { window.print(); }

  // ============== UI ==============
  return (
    <div className="h-screen w-screen overflow-hidden bg-gray-50 text-gray-900 touch-manipulation select-none">
      {/* ヘッダ */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-white">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">送迎割当（名簿幅調整 / ホワイトボード取込β）</h1>
          <div className="flex rounded-xl border overflow-hidden">
            <button className={`px-3 py-1.5 text-sm ${mode === "go" ? "bg-blue-600 text-white" : "bg-white"}`} onClick={() => setMode("go")}>行き</button>
            <button className={`px-3 py-1.5 text-sm ${mode === "back" ? "bg-blue-600 text-white" : "bg-white"}`} onClick={() => setMode("back")}>帰り</button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 rounded-lg bg-gray-200 hover:bg-gray-300" onClick={exportCSV}>CSV出力</button>
          <label className="px-3 py-1.5 rounded-lg bg-gray-200 hover:bg-gray-300 cursor-pointer">CSV入力
            <input type="file" accept=".csv" className="hidden" onChange={(e) => e.target.files && importCSV(e.target.files[0])} />
          </label>
          <label className="px-3 py-1.5 rounded-lg bg-gray-200 hover:bg-gray-300 cursor-pointer">画像（行解析β）
            <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files && importFromImage(e.target.files[0])} />
          </label>
          <button className="px-3 py-1.5 rounded-lg bg-gray-200 hover:bg-gray-300" onClick={() => setWbOpen(true)}>ホワイトボードから</button>
          <button className="px-3 py-1.5 rounded-lg bg-gray-200 hover:bg-gray-300" onClick={() => setOpenSettings(true)}>設定</button>
          <button className="px-3 py-1.5 rounded-lg bg-gray-200 hover:bg-gray-300" onClick={printView}>印刷</button>
          <button className="px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600" onClick={resetAll}>初期化</button>
        </div>
      </div>

      {/* 日付バー + カレンダー */}
      <div className="px-3 py-2 border-b bg-white flex items-center gap-2">
        <button className="px-2 py-1 rounded border" onClick={() => setSelectedDate(d => shiftDateStr(d, -1))}>←</button>
        <div className="flex-1 overflow-x-auto">
          <div className="flex gap-1">
            {Array.from({ length: 21 }, (_, i) => {
              const base = new Date(); base.setHours(0, 0, 0, 0); base.setDate(base.getDate() - 10 + i);
              const s = fmt(base);
              const isToday = s === todayStr();
              const isSel = s === selectedDate;
              return (
                <button key={s}
                  onClick={() => setSelectedDate(s)}
                  className={`px-2 py-1 rounded-lg border whitespace-nowrap ${isSel ? "bg-blue-600 text-white" : "bg-white"} ${isToday && !isSel ? "border-blue-400" : ""}`}>
                  {s.slice(5)}{isToday ? "(今日)" : ""}
                </button>
              );
            })}
          </div>
        </div>
        <input type="date" className="border rounded px-2 py-1"
          value={selectedDate}
          onChange={(e) => setSelectedDate(clampDateStr(e.target.value || todayStr()))} />
        <button className="px-2 py-1 rounded border" onClick={() => setSelectedDate(d => shiftDateStr(d, 1))}>→</button>
      </div>

      {/* レイアウト：名簿幅を state で制御＋スプリッター */}
      <div className="h-[calc(100vh-96px)] w-full relative flex overflow-hidden">
        {/* 名簿パネル */}
        <div className="bg-white border-r h-full flex flex-col" style={{ width: Math.max(240, Math.min(560, rosterWidth)) }}>
          <div className="p-3 border-b">
            <div className="text-sm font-medium mb-2">名簿に追加</div>
            <div className="flex gap-2">
              <input className="flex-1 px-3 py-2 rounded-xl border text-base" placeholder="氏名"
                value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addStudent()} />
              {groupLock ? (
                <select className="px-2 py-2 rounded-xl border w-28" value={newGroup} onChange={(e) => setNewGroup(e.target.value)}>
                  {groups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
                </select>
              ) : (
                <>
                  <input list="grouplist" className="px-2 py-2 rounded-xl border w-28" placeholder="所属"
                    value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
                  <datalist id="grouplist">{groups.map(g => <option key={g.name} value={g.name} />)}</datalist>
                </>
              )}
              <button className="px-3 py-2 rounded-xl bg-blue-600 text-white active:scale-95" onClick={addStudent}>追加</button>
            </div>
          </div>

          <div className="p-3 flex-1 overflow-auto">
            <div className="text-sm text-gray-600 mb-2">未割当（長押し→ドラッグで車へ）</div>
            {ocrBusy && <div className="mb-2 text-xs text-gray-600">OCR: {ocrLog}</div>}
            <div className="grid grid-cols-1 gap-2">
              {students.filter(s => unassignedIds.includes(s.id)).map(s => (
                <div
                  key={s.id}
                  className={`px-3 py-2 rounded-xl border bg-gray-50 ${draggingId === s.id ? 'ring-2 ring-blue-400' : ''}`}
                  style={{ borderLeft: `6px solid ${colorForGroup(groups, s.group)}` }}
                  onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); setDraggingId(s.id); setDragPos({ x: e.clientX, y: e.clientY }); }}
                  onPointerMove={(e) => {
                    if (!draggingId) return;
                    const x = e.clientX, y = e.clientY; setDragPos({ x, y });
                    let over = null;
                    for (const vid of VISIBLE_VEHICLES) {
                      const el = vehicleRefs.current[vid]?.current; if (!el) continue;
                      const r = el.getBoundingClientRect();
                      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { over = vid; break; }
                    }
                    setHoverVehicle(over);
                  }}
                  onPointerUp={() => {
                    if (draggingId && hoverVehicle) {
                      const id = draggingId;
                      updateVehicles(prev => {
                        const copy = clone(prev);
                        for (const vid of Object.keys(copy)) copy[vid] = copy[vid].filter(a => a.studentId !== id);
                        copy[hoverVehicle].push({ studentId: id, pickup: "" });
                        return copy;
                      });
                    }
                    setDraggingId(null); setHoverVehicle(null);
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: colorForGroup(groups, s.group) }} />
                      <span className="text-sm">{s.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {groupLock ? (
                        <select className="text-xs border rounded px-1 py-0.5 w-20"
                          value={s.group ?? ""} onChange={(e) => setStudentGroup(s.id, e.target.value)}>
                          {groups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
                        </select>
                      ) : (
                        <>
                          <input list="grouplist" className="text-xs border rounded px-1 py-0.5 w-20"
                            value={s.group ?? ""} onChange={(e) => setStudentGroup(s.id, e.target.value)} />
                          <datalist id="grouplist">{groups.map(g => <option key={g.name} value={g.name} />)}</datalist>
                        </>
                      )}
                      <button className="text-xs text-red-600 hover:underline" onClick={() => removeStudent(s.id)}>削除</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* スプリッター */}
        <div
          role="separator"
          aria-orientation="vertical"
          className={`w-1 cursor-col-resize bg-gray-200 ${resizing ? "bg-blue-300" : ""}`}
          onPointerDown={(e) => { setResizing(true); (e.target).setPointerCapture?.(e.pointerId); }}
          onPointerMove={(e) => {
            if (!resizing) return;
            setRosterWidth(w => {
              const next = Math.round(e.clientX); // 左端からのpx
              return Math.max(240, Math.min(560, next));
            });
          }}
          onPointerUp={() => setResizing(false)}
        />

        {/* 右：8車グリッド */}
        <div className="p-3 h-full flex-1 min-w-0">
          <div className="grid grid-cols-4 grid-rows-2 gap-3 h-full">
            {VISIBLE_VEHICLES.map((vid, idx) => (
              <div
                key={vid}
                ref={vehicleRefs.current[vid]}
                className={`rounded-2xl bg-white border flex flex-col overflow-hidden ${hoverVehicle === vid ? 'ring-2 ring-blue-500' : ''}`}
              >
                {/* 車ヘッダ */}
                <div className="px-3 py-2 border-b flex items-center gap-2 bg-gray-50">
                  <input
                    className="flex-1 bg-transparent font-medium text-sm px-2 py-1 rounded border"
                    value={vehicleNames[vid]}
                    onChange={(e) => setVehicleNames(v => ({ ...v, [vid]: e.target.value }))}
                  />
                  <span className="text-[10px] text-gray-500">{idx + 1}/8</span>
                </div>

                {/* 児童カード */}
                <div className="flex-1 overflow-auto p-2">
                  {vehicles[vid].length === 0 && (
                    <div className="h-full w-full flex items-center justify-center text-xs text-gray-400 border border-dashed rounded-xl p-4">
                      未割当：ここにドロップ
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-2">
                    {vehicles[vid].map(a => {
                      const s = byId[a.studentId];
                      return (
                        <div key={a.studentId} className="rounded-xl border px-3 py-2 bg-white"
                          style={{ borderLeft: `6px solid ${colorForGroup(groups, s?.group)}` }}>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: colorForGroup(groups, s?.group) }} />
                              <div className="text-sm font-medium">{s?.name ?? "(不明)"}</div>
                            </div>
                            <button className="text-xs text-gray-500 hover:underline" onClick={() => unassignCurrentDay(a.studentId)}>外す</button>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <label className="text-xs flex flex-col gap-1">
                              <span className="text-gray-500">ピックアップ</span>
                              <input type="time" className="px-2 py-1 rounded border" value={a.pickup} onChange={(e) => updateTime(vid, a.studentId, e.target.value)} />
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 設定モーダル */}
{openSettings && (
  <div
    className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
    onClick={() => setOpenSettings(false)}
  >
    <div
      className="bg-white rounded-2xl shadow-xl w-[720px] max-w-[90vw] p-4"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">設定（所属カラーの固定）</h2>
        <button className="px-3 py-1.5 rounded border" onClick={() => setOpenSettings(false)}>閉じる</button>
      </div>

      {/* 所属ロック */}
      <div className="mb-3 flex items-center gap-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={groupLock}
            onChange={(e) => setGroupLock(e.target.checked)}
          />
          所属リストを固定（自由入力を禁止）
        </label>
        <span className="text-xs text-gray-500">※ONだと児童の所属は下のリストに限定されます</span>
      </div>

      {/* 所属カラー編集リスト */}
      <div className="text-sm text-gray-600 mb-2">
        所属名と色を施設仕様に合わせて固定できます（名簿・配車表示に反映）。
      </div>
      <div className="space-y-2 max-h-[50vh] overflow-auto pr-1">
        {groups.map((g, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className="border rounded px-2 py-1 w-40"
              value={g.name}
              onChange={(e) =>
                setGroups((prev) =>
                  prev.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x))
                )
              }
            />
            <input
              type="color"
              className="w-10 h-8 p-0 border rounded"
              value={g.color}
              onChange={(e) =>
                setGroups((prev) =>
                  prev.map((x, idx) => (idx === i ? { ...x, color: e.target.value } : x))
                )
              }
            />
            <div className="text-xs text-gray-500">例: 赤 / 放課後A / 低学年 など</div>
            <button
              className="ml-auto text-xs text-red-600"
              onClick={() => {
                setGroups((prev) => prev.filter((_, idx) => idx !== i));
              }}
            >
              削除
            </button>
          </div>
        ))}
      </div>

      {/* ←←← ここで所属リストのブロックがしっかり閉じているのがポイント（上の </div> で終了） */}

      {/* ここから：車の有効/無効 */}
      <div className="mt-6">
        <h3 className="font-medium mb-2">車の有効/無効（表示する台数を調整）</h3>
        <div className="grid grid-cols-4 gap-2">
          {VEHICLE_IDS.map((vid, i) => (
            <label key={vid} className="flex items-center gap-2 border rounded px-2 py-1">
              <input
                type="checkbox"
                checked={!!enabledVehicles[vid]}
                onChange={(e) => {
                  const on = e.target.checked;
                  setEnabledVehicles((prev) => ({ ...prev, [vid]: on }));
                }}
              />
              <span className="text-sm">
                {vehicleNames[vid] || `車${i + 1}`}（{vid}）
              </span>
            </label>
          ))}
        </div>
        <div className="text-xs text-gray-500 mt-1">
          チェックを外すと、その車の枠は非表示（＝使わない場所）。<br />
          表示中の車だけがドラッグ&ドロップやCSV出力の対象になります。
        </div>
      </div>
      {/* ここまで：車の有効/無効 */}

      <div className="mt-3 flex items-center gap-2">
        <button
          className="px-3 py-1.5 rounded bg-gray-200"
          onClick={() => setGroups((prev) => [...prev, { name: "新規所属", color: "#9ca3af" }])}
        >
          所属を追加
        </button>
        <button
          className="px-3 py-1.5 rounded bg-blue-600 text-white"
          onClick={() => setOpenSettings(false)}
        >
          保存して閉じる
        </button>
      </div>
    </div>
  </div>
)}


      {/* ドラッグ中のゴースト */}
      {draggingId && (
        <div style={{ position: "fixed", left: dragPos.x + 12, top: dragPos.y + 12, pointerEvents: "none", zIndex: 50 }}>
          <div className="px-3 py-2 rounded-2xl border shadow bg-white text-sm">
            {byId[draggingId]?.name}
          </div>
        </div>
      )}

      {/* 印刷スタイル */}
      <style>{`@media print { body,html,#root{height:auto} .grid{gap:8px!important} input,button,select{border:none!important} }`}</style>
    </div>
  );
}

/* 画像プレビュー＋4x2グリッドオーバーレイ */
function WhiteboardPreview({ blob, margins, gaps }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);

  return (
    <div className="relative w-full h-[60vh] min-h-[360px] border rounded-xl overflow-hidden bg-black/5">
      {url && (
        <>
          <img src={url} alt="whiteboard" className="w-full h-full object-contain select-none pointer-events-none" />
          {/* オーバーレイ */}
          <div className="absolute inset-0 pointer-events-none">
            <GridOverlay margins={margins} gaps={gaps} />
          </div>
        </>
      )}
    </div>
  );
}

function GridOverlay({ margins, gaps }) {
  return (
    <div className="absolute inset-0">
      <div
        className="absolute border-2 border-blue-400/60 rounded"
        style={{
          top: `${margins.top}%`,
          left: `${margins.left}%`,
          right: `${margins.right}%`,
          bottom: `${margins.bottom}%`,
        }}
      >
        {/* 4x2 セル */}
        <div className="w-full h-full grid" style={{
          gridTemplateColumns: "1fr 1fr 1fr 1fr",
          gridTemplateRows: "1fr 1fr",
          columnGap: `${gaps.col}%`,
          rowGap: `${gaps.row}%`,
          padding: 2
        }}>
          {Array.from({length:8},(_,i)=>(
            <div key={i} className="border-2 border-yellow-400/70 rounded-md"></div>
          ))}
        </div>
      </div>
    </div>
  );
}
