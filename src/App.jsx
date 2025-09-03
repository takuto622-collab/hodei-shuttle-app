import React, { useEffect, useMemo, useRef, useState } from "react";

/* =========================
   放デイ送迎アプリ v6
   - iPad/Safari対策: structuredClone代替, OCRは動的読み込み
   - 行き/帰り、8車固定、非スクロールページ
   - 所属カラー固定(設定でロックON/OFF)
   - 日付：今日±10日＋<input type="date">
   - CSV入出力（降車なし: 日付,便,車両,氏名,所属,ピックアップ）
   - OCR(β)：前処理(拡大＋二値化)＋ゆるい車名/氏名パース
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

const STORAGE_KEY = "dispatch-mvp-v6";

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
async function preprocessImage(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });

  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth * scale;
  canvas.height = img.naturalHeight * scale;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

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

  // 選択日の存在保証
  useEffect(() => {
    setByDate(prev => {
      if (prev[selectedDate]) return prev;
      return { ...prev, [selectedDate]: { go: emptyVehicleMap(), back: emptyVehicleMap() } };
    });
  }, [selectedDate]);

  // 保存
  useEffect(() => {
    LS.save({ students, byDate, vehicleNames, selectedDate, mode, groups, groupLock });
  }, [students, byDate, vehicleNames, selectedDate, mode, groups, groupLock]);

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
    for (const vid of VEHICLE_IDS) {
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

  // ---- OCR（β）：前処理 → Tesseract(動的) → ゆるいパース
  async function importFromImage(file) {
    setOcrBusy(true);
    setOcrLog("画像の前処理…");
    try {
      const processed = await preprocessImage(file);

      setOcrLog("OCRエンジン読込中…");
      const { default: Tesseract } = await import("tesseract.js");

      setOcrLog("解析中…");
      const { data } = await Tesseract.recognize(processed, "jpn", {
        // 文字のホワイトリスト（必要に応じて増やす）
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789一二三四五六七八九十〇零号車行帰名・、,-:： 　"
      });

      const text = data?.text ?? "";
      setOcrLog("取り込み中…");

      // 行ごとに「車X: 名前 名前...」などを抽出
      const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

      const nameToId = new Map(students.map(s => [s.name, s.id]));
      const nextStudents = [...students];

      updateVehicles(prev => {
        const copy = clone(prev);
        // 車ごとの上書きを想定：該当行があった車は一度空にする
        const touched = new Set();

        for (const line of lines) {
          // 車の識別: 「車2」「2号車」「車 3」など
          const m = line.match(/(?:車\s*(\d+)|(\d+)号車)/);
          let carIdx = null;
          if (m) { carIdx = parseInt(m[1] || m[2], 10); }

          // 「:」以降や “車X” の右側を「名前候補」とみなす
          let namesPart = line;
          if (/:|：/.test(line)) namesPart = line.split(/:|：/).slice(1).join(" ");
          namesPart = namesPart.replace(/(?:車\s*\d+|\d+号車)/g, "");
          const names = namesPart.split(/[,\s、・]+/).map(s => s.trim()).filter(Boolean);

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
              // 他車から同名を除去して、この車に入れる
              for (const k of Object.keys(copy)) copy[k] = copy[k].filter(a => a.studentId !== id);
              copy[vid].push({ studentId: id, pickup: "" });
            }
          }
        }
        setStudents(nextStudents);
        return copy;
      });

      setOcrLog("完了しました。");
    } catch (e) {
      console.error(e);
      setOcrLog("OCRに失敗しました。照明・解像度・傾き等を調整してください。");
    } finally {
      setTimeout(() => setOcrBusy(false), 600);
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
  }
  function printView() { window.print(); }

  // ============== UI ==============
  return (
    <div className="h-screen w-screen overflow-hidden bg-gray-50 text-gray-900 touch-manipulation select-none">
      {/* ヘッダ */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-white">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">送迎割当（所属色固定 / 日別 / OCRβ）</h1>
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
          <label className="px-3 py-1.5 rounded-lg bg-gray-200 hover:bg-gray-300 cursor-pointer">画像から（β）
            <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files && importFromImage(e.target.files[0])} />
          </label>
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

      {/* レイアウト */}
      <div className="grid grid-cols-[360px_1fr] h-[calc(100vh-96px)]">
        {/* 名簿 */}
        <div className="border-r bg-white h-full flex flex-col">
          <div className="p-3 border-b">
            <div className="text-sm font-medium mb-2">名簿に追加</div>
            <div className="flex gap-2">
              <input className="flex-1 px-3 py-2 rounded-xl border text-base" placeholder="氏名"
                value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addStudent()} />
              {/* 所属：ロック中はセレクト限定、解除で自由入力 */}
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
                    for (const vid of VEHICLE_IDS) {
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

        {/* 右：8車グリッド */}
        <div className="p-3 h-full">
          <div className="grid grid-cols-4 grid-rows-2 gap-3 h-full">
            {VEHICLE_IDS.map((vid, idx) => (
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
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setOpenSettings(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-[720px] max-w-[90vw] p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">設定（所属カラーの固定）</h2>
              <button className="px-3 py-1.5 rounded border" onClick={() => setOpenSettings(false)}>閉じる</button>
            </div>

            <div className="mb-3 flex items-center gap-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={groupLock} onChange={e => setGroupLock(e.target.checked)} />
                所属リストを固定（自由入力を禁止）
              </label>
              <span className="text-xs text-gray-500">※ONだと児童の所属は下のリストに限定されます</span>
            </div>

            <div className="text-sm text-gray-600 mb-2">所属名と色を施設仕様に合わせて固定できます（名簿・配車表示に反映）。</div>
            <div className="space-y-2 max-h-[50vh] overflow-auto pr-1">
              {groups.map((g, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input className="border rounded px-2 py-1 w-40" value={g.name}
                    onChange={(e) => setGroups(prev => prev.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))} />
                  <input type="color" className="w-10 h-8 p-0 border rounded" value={g.color}
                    onChange={(e) => setGroups(prev => prev.map((x, idx) => idx === i ? { ...x, color: e.target.value } : x))} />
                  <div className="text-xs text-gray-500">例: 赤 / 放課後A / 低学年 など</div>
                  <button className="ml-auto text-xs text-red-600" onClick={() => {
                    setGroups(prev => prev.filter((_, idx) => idx !== i));
                  }}>削除</button>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button className="px-3 py-1.5 rounded bg-gray-200" onClick={() => setGroups(prev => [...prev, { name: "新規所属", color: "#9ca3af" }])}>所属を追加</button>
              <button className="px-3 py-1.5 rounded bg-blue-600 text-white" onClick={() => setOpenSettings(false)}>保存して閉じる</button>
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
