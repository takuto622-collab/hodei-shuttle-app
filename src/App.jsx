import React, { useMemo, useRef, useState, useEffect } from "react";

/** @typedef {{ id: string; name: string }} Student */
/** @typedef {{ studentId: string; pickup: string; drop: string }} Assignment */
/** @typedef {{ [vehicleId: string]: Assignment[] }} VehicleMap */

const VEHICLE_COUNT = 8;
const VEHICLE_IDS = Array.from({ length: VEHICLE_COUNT }, (_, i) => `v${i + 1}`);
const STORAGE_KEY = "dispatch-mvp-v3";

function uid() { return Math.random().toString(36).slice(2, 9); }
function loadState() { try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; } }
function saveState(state) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

export default function App() {
  const persisted = useMemo(() => loadState(), []);

  const [students, setStudents] = useState(
    persisted?.students ?? [
      { id: uid(), name: "山田 太郎" },
      { id: uid(), name: "佐藤 花子" },
      { id: uid(), name: "鈴木 次郎" },
      { id: uid(), name: "田中 三郎" },
    ]
  );

  const [vehiclesGo, setVehiclesGo] = useState(
    persisted?.vehiclesGo ?? Object.fromEntries(VEHICLE_IDS.map((id) => [id, []]))
  );
  const [vehiclesBack, setVehiclesBack] = useState(
    persisted?.vehiclesBack ?? Object.fromEntries(VEHICLE_IDS.map((id) => [id, []]))
  );
  const [mode, setMode] = useState(persisted?.mode ?? "go"); // 'go' | 'back'

  const vehicles = mode === "go" ? vehiclesGo : vehiclesBack;
  const setVehicles = mode === "go" ? setVehiclesGo : setVehiclesBack;

  const [vehicleNames, setVehicleNames] = useState(
    persisted?.vehicleNames ?? Object.fromEntries(VEHICLE_IDS.map((id, i) => [id, `車${i + 1}`]))
  );

  const [newName, setNewName] = useState("");

  // iPad向けドラッグ（Pointer Events）
  const [draggingId, setDraggingId] = useState(null);
  const [dragPos, setDragPos] = useState({ x: 0, y: 0 });
  const [hoverVehicle, setHoverVehicle] = useState(null);
  const vehicleRefs = useRef(Object.fromEntries(VEHICLE_IDS.map((id) => [id, React.createRef()])));

  useEffect(() => {
    saveState({ students, vehiclesGo, vehiclesBack, vehicleNames, mode });
  }, [students, vehiclesGo, vehiclesBack, vehicleNames, mode]);

  const unassignedIds = useMemo(() => {
    const assigned = new Set(Object.values(vehicles).flatMap((arr) => arr.map((a) => a.studentId)));
    return students.filter((s) => !assigned.has(s.id)).map((s) => s.id);
  }, [students, vehicles]);

  const byId = useMemo(() => Object.fromEntries(students.map((s) => [s.id, s])), [students]);

  function updateTime(vehicleId, studentId, field, value) {
    setVehicles((prev) => {
      const copy = structuredClone(prev);
      const arr = copy[vehicleId];
      const idx = arr.findIndex((a) => a.studentId === studentId);
      if (idx >= 0) arr[idx][field] = value;
      return copy;
    });
  }

  function addStudent() {
    const name = newName.trim();
    if (!name) return;
    setStudents((s) => [...s, { id: uid(), name }]);
    setNewName("");
  }

  function removeStudent(id) {
    setStudents((s) => s.filter((x) => x.id !== id));
    setVehiclesGo((prev) => {
      const copy = structuredClone(prev);
      for (const vid of Object.keys(copy)) copy[vid] = copy[vid].filter((a) => a.studentId !== id);
      return copy;
    });
    setVehiclesBack((prev) => {
      const copy = structuredClone(prev);
      for (const vid of Object.keys(copy)) copy[vid] = copy[vid].filter((a) => a.studentId !== id);
      return copy;
    });
  }

  function unassign(studentId) {
    const setter = mode === "go" ? setVehiclesGo : setVehiclesBack;
    setter((prev) => {
      const copy = structuredClone(prev);
      for (const vid of Object.keys(copy)) copy[vid] = copy[vid].filter((a) => a.studentId !== studentId);
      return copy;
    });
  }

  // ---- CSV出力
  function exportCSV() {
    const rows = [["便", "車両", "氏名", "ピックアップ", "降車"]];
    const currentVehicles = mode === "go" ? vehiclesGo : vehiclesBack;
    for (const vid of VEHICLE_IDS) {
      for (const a of currentVehicles[vid]) {
        rows.push([
          mode === "go" ? "行き" : "帰り",
          vehicleNames[vid],
          byId[a.studentId]?.name ?? "",
          a.pickup,
          a.drop,
        ]);
      }
    }
    const csv = rows
      .map((r) => r.map((x) => `"${(x ?? "").replaceAll('"', '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `送迎割当_${mode}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- CSVテンプレDL
  function downloadTemplate() {
    const rows = [
      ["便", "車両", "氏名", "ピックアップ", "降車"],
      [mode === "go" ? "行き" : "帰り", "車1", "例：山田太郎", "15:30", "16:10"],
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "テンプレート.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- CSV取り込み
  function importCSV(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (!lines.length) return;

      const header = lines[0].split(",");
      const hasBin = /便/.test(header[0]);
      const data = hasBin ? lines.slice(1) : lines;

      const nameToId = new Map(students.map((s) => [s.name, s.id]));
      const newVehiclesGo = structuredClone(vehiclesGo);
      const newVehiclesBack = structuredClone(vehiclesBack);
      const newVehicleNames = { ...vehicleNames };
      const newStudents = [...students];

      for (const line of data) {
        const cols = parseCsvLine(line);
        if (!cols) continue;

        const [binMaybe, carMaybe, nameMaybe, pickupMaybe, dropMaybe] = cols;
        const bin = hasBin ? binMaybe : (mode === "go" ? "行き" : "帰り");
        const car = hasBin ? carMaybe : binMaybe;         // ヘッダ無しCSVのとき先頭を車名とみなす
        const name = hasBin ? nameMaybe : carMaybe;
        const pickup = hasBin ? pickupMaybe : nameMaybe;
        const drop = hasBin ? dropMaybe : pickupMaybe;

        if (!name) continue;

        if (!nameToId.has(name)) {
          const id = uid();
          nameToId.set(name, id);
          newStudents.push({ id, name });
        }
        const id = nameToId.get(name);

        // 車名 → 内部ID
        let vid = Object.keys(newVehicleNames).find((k) => newVehicleNames[k] === car);
        if (!vid) {
          vid = VEHICLE_IDS.find((x) => newVehicleNames[x].startsWith("車")) ?? VEHICLE_IDS[0];
          newVehicleNames[vid] = car || newVehicleNames[vid];
        }

        const target = bin === "行き" ? newVehiclesGo : newVehiclesBack;
        // 同じ児童の既存割当を一旦除去
        for (const k of Object.keys(target)) {
          target[k] = target[k].filter((a) => a.studentId !== id);
        }
        // 追加
        target[vid].push({ studentId: id, pickup: pickup ?? "", drop: drop ?? "" });
      }

      setStudents(newStudents);
      setVehicleNames(newVehicleNames);
      setVehiclesGo(newVehiclesGo);
      setVehiclesBack(newVehiclesBack);
    };
    reader.readAsText(file, "utf-8");
  }

  // 簡易CSVパーサ（ダブルクオート対応）
  function parseCsvLine(line) {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else { inQ = false; }
        } else {
          cur += ch;
        }
      } else {
        if (ch === ",") { out.push(cur); cur = ""; }
        else if (ch === '"') { inQ = true; }
        else { cur += ch; }
      }
    }
    out.push(cur);
    return out;
  }

  function resetAll() {
    if (!confirm("すべて初期化しますか？")) return;
    setVehiclesGo(Object.fromEntries(VEHICLE_IDS.map((id) => [id, []])));
    setVehiclesBack(Object.fromEntries(VEHICLE_IDS.map((id) => [id, []])));
    setStudents([]);
    setVehicleNames(Object.fromEntries(VEHICLE_IDS.map((id, i) => [id, `車${i + 1}`])));
    setMode("go");
  }

  function printView() { window.print(); }

  return (
    <div className="h-screen w-screen overflow-hidden bg-gray-50 text-gray-900 touch-manipulation select-none">
      {/* ヘッダ */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-white">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">送迎割当（8車）</h1>
          <div className="flex rounded-xl border overflow-hidden">
            <button
              className={`px-3 py-1.5 text-sm ${mode === "go" ? "bg-blue-600 text-white" : "bg-white"}`}
              onClick={() => setMode("go")}
              title="行き便"
            >行き</button>
            <button
              className={`px-3 py-1.5 text-sm ${mode === "back" ? "bg-blue-600 text-white" : "bg-white"}`}
              onClick={() => setMode("back")}
              title="帰り便"
            >帰り</button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 rounded-lg bg-gray-200 hover:bg-gray-300" onClick={exportCSV}>CSV出力</button>
          <label className="px-3 py-1.5 rounded-lg bg-gray-200 hover:bg-gray-300 cursor-pointer">
            CSV入力
            <input type="file" accept=".csv" className="hidden" onChange={(e)=> e.target.files && importCSV(e.target.files[0])} />
          </label>
          <button className="px-3 py-1.5 rounded-lg bg-gray-200 hover:bg-gray-300" onClick={downloadTemplate}>テンプレCSV</button>
          <button className="px-3 py-1.5 rounded-lg bg-gray-200 hover:bg-gray-300" onClick={printView}>印刷</button>
          <button className="px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600" onClick={resetAll}>初期化</button>
        </div>
      </div>

      {/* 左：名簿 / 右：8車グリッド（ページは固定、高さ内で各車スクロール） */}
      <div className="grid grid-cols-[320px_1fr] h-[calc(100vh-48px)]">
        {/* 名簿 */}
        <div className="border-r bg-white h-full flex flex-col">
          <div className="p-3 border-b">
            <div className="text-sm font-medium mb-2">名簿に追加</div>
            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-2 rounded-xl border text-base"
                placeholder="氏名を入力"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addStudent()}
              />
              <button className="px-3 py-2 rounded-xl bg-blue-600 text-white active:scale-95" onClick={addStudent}>追加</button>
            </div>
          </div>

          <div className="p-3 flex-1 overflow-auto">
            <div className="text-sm text-gray-600 mb-2">未割当（長押し→ドラッグで車へ）</div>
            <div className="grid grid-cols-1 gap-2">
              {students
                .filter((s) => unassignedIds.includes(s.id))
                .map((s) => (
                  <div
                    key={s.id}
                    className={`px-3 py-3 rounded-2xl border bg-gray-50 ${draggingId===s.id? 'ring-2 ring-blue-400': ''}`}
                    onPointerDown={(e)=>{ e.currentTarget.setPointerCapture?.(e.pointerId); setDraggingId(s.id); setDragPos({x:e.clientX,y:e.clientY}); }}
                    onPointerMove={(e)=>{ if(!draggingId) return;
                      const x=e.clientX,y=e.clientY; setDragPos({x,y});
                      let over=null;
                      for(const vid of VEHICLE_IDS){
                        const el=vehicleRefs.current[vid]?.current; if(!el) continue;
                        const r=el.getBoundingClientRect();
                        if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom){ over=vid; break; }
                      }
                      setHoverVehicle(over);
                    }}
                    onPointerUp={()=>{ if(draggingId && hoverVehicle){
                      const id=draggingId;
                      setVehicles(prev=>{
                        const copy=structuredClone(prev);
                        for(const vid of Object.keys(copy)) copy[vid]=copy[vid].filter(a=>a.studentId!==id);
                        copy[hoverVehicle].push({studentId:id,pickup:"",drop:""});
                        return copy;
                      });
                    }
                    setDraggingId(null); setHoverVehicle(null); }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-base">{s.name}</span>
                      <button className="text-xs text-red-600 hover:underline" onClick={() => removeStudent(s.id)}>削除</button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>

        {/* 右：車グリッド */}
        <div className="p-3 h-full">
          <div className="grid grid-cols-4 grid-rows-2 gap-3 h-full">
            {VEHICLE_IDS.map((vid, idx) => (
              <div
                key={vid}
                ref={vehicleRefs.current[vid]}
                className={`rounded-2xl bg-white border flex flex-col overflow-hidden ${hoverVehicle===vid? 'ring-2 ring-blue-500':''}`}
              >
                {/* 車ヘッダ（名称編集可能） */}
                <div className="px-3 py-2 border-b flex items-center gap-2 bg-gray-50">
                  <input
                    className="flex-1 bg-transparent font-medium text-sm px-2 py-1 rounded border"
                    value={vehicleNames[vid]}
                    onChange={(e) => setVehicleNames((v) => ({ ...v, [vid]: e.target.value }))}
                  />
                  <span className="text-[10px] text-gray-500">{idx + 1}/8</span>
                </div>

                {/* 児童カード領域 */}
                <div className="flex-1 overflow-auto p-2">
                  {vehicles[vid].length === 0 && (
                    <div className="h-full w-full flex items-center justify-center text-xs text-gray-400 border border-dashed rounded-xl p-4">
                      未割当：ここにドロップ
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-2">
                    {vehicles[vid].map((a) => (
                      <div key={a.studentId} className="rounded-xl border px-3 py-2 bg-white">
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-sm font-medium">{byId[a.studentId]?.name ?? "(不明)"}</div>
                          <div className="flex items-center gap-2">
                            <button className="text-xs text-gray-500 hover:underline" onClick={() => unassign(a.studentId)}>外す</button>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-xs flex flex-col gap-1">
                            <span className="text-gray-500">ピックアップ</span>
                            <input
                              type="time"
                              className="px-2 py-1 rounded border"
                              value={a.pickup}
                              onChange={(e) => updateTime(vid, a.studentId, "pickup", e.target.value)}
                            />
                          </label>
                          <label className="text-xs flex flex-col gap-1">
                            <span className="text-gray-500">降車</span>
                            <input
                              type="time"
                              className="px-2 py-1 rounded border"
                              value={a.drop}
                              onChange={(e) => updateTime(vid, a.studentId, "drop", e.target.value)}
                            />
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ドラッグ中のゴースト */}
      {draggingId && (
        <div style={{ position: "fixed", left: dragPos.x + 12, top: dragPos.y + 12, pointerEvents: "none", zIndex: 50 }}>
          <div className="px-3 py-2 rounded-2xl border shadow bg-white text-sm">{byId[draggingId]?.name}</div>
        </div>
      )}

      {/* 印刷スタイル */}
      <style>{`@media print { .no-print { display:none!important } body,html,#root { height:auto } .grid { gap:8px!important } input,button { border:none!important } }`}</style>
    </div>
  );
}
