import React, { useEffect, useMemo, useRef, useState } from "react";

// Safari/iPad対策: structuredClone 代替
const clone = (obj) =>
  typeof structuredClone === "function"
    ? structuredClone(obj)
    : JSON.parse(JSON.stringify(obj));

/** @typedef {{ id: string; name: string; group?: string }} Student */
/** @typedef {{ studentId: string; pickup: string }} Assignment */
const VEHICLE_COUNT = 8;
const VEHICLE_IDS = Array.from({ length: VEHICLE_COUNT }, (_, i) => `v${i + 1}`);
const STORAGE_KEY = "dispatch-mvp-v5-safari";

// ---- 日付
function fmt(d){ return d.toISOString().slice(0,10); }
function todayStr(){ return fmt(new Date()); }
function clampDateStr(s){
  const base = new Date(); base.setHours(0,0,0,0);
  const min = new Date(base); min.setDate(base.getDate()-10);
  const max = new Date(base); max.setDate(base.getDate()+10);
  const d = new Date(s);
  return fmt(new Date(Math.min(Math.max(d.getTime(), min.getTime()), max.getTime())));
}
function shiftDateStr(s, delta){ const d=new Date(s); d.setDate(d.getDate()+delta); return clampDateStr(fmt(d)); }

// ---- 永続化
const LS = {
  load(){ try{ const raw=localStorage.getItem(STORAGE_KEY); return raw? JSON.parse(raw): null } catch{ return null } },
  save(state){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
};

// ---- デフォ所属色
const DEFAULT_GROUPS = [
  { name: "赤", color: "#ef4444" },
  { name: "青", color: "#3b82f6" },
  { name: "緑", color: "#22c55e" },
  { name: "橙", color: "#f59e0b" },
  { name: "紫", color: "#8b5cf6" },
  { name: "灰", color: "#6b7280" },
];

function colorForGroup(groups, groupName){
  if (!groupName) return "#9ca3af";
  const f = groups.find(g => g.name === groupName);
  if (f) return f.color;
  return "#9ca3af";
}

function emptyVehicleMap(){ return Object.fromEntries(VEHICLE_IDS.map(id=>[id,/** @type {Assignment[]} */([])])); }
function uid(){ return Math.random().toString(36).slice(2,9); }

export default function App(){
  const persisted = LS.load();

  const [groups, setGroups] = useState(persisted?.groups ?? DEFAULT_GROUPS);
  const [students, setStudents] = useState/** @type {Student[]} */(
    persisted?.students ?? [
      { id: uid(), name: "山田 太郎", group: "赤" },
      { id: uid(), name: "佐藤 花子", group: "青" },
    ]
  );

  const [byDate, setByDate] = useState(
    persisted?.byDate ?? { [todayStr()]: { go: emptyVehicleMap(), back: emptyVehicleMap() } }
  );
  const [selectedDate, setSelectedDate] = useState(persisted?.selectedDate ? clampDateStr(persisted.selectedDate) : todayStr());
  const [mode, setMode] = useState(persisted?.mode ?? "go");
  const [vehicleNames, setVehicleNames] = useState(
    persisted?.vehicleNames ?? Object.fromEntries(VEHICLE_IDS.map((id,i)=>[id,`車${i+1}`]))
  );

  const [newName, setNewName] = useState("");
  const [newGroup, setNewGroup] = useState(groups[0]?.name ?? "");

  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrLog, setOcrLog] = useState("");

  useEffect(()=>{ LS.save({ students, byDate, vehicleNames, selectedDate, mode, groups }); },
    [students, byDate, vehicleNames, selectedDate, mode, groups]);

  const dayData = byDate[selectedDate] ?? { go: emptyVehicleMap(), back: emptyVehicleMap() };
  const vehicles = mode==="go" ? dayData.go : dayData.back;
  const byId = useMemo(()=>Object.fromEntries(students.map(s=>[s.id,s])),[students]);

  const unassignedIds = useMemo(()=>{
    const assigned = new Set(Object.values(vehicles).flatMap(arr=>arr.map(a=>a.studentId)));
    return students.filter(s=>!assigned.has(s.id)).map(s=>s.id);
  },[students, vehicles]);

  function updateVehicles(mutator){
    setByDate(prev=>{
      const copy = clone(prev);
      if (!copy[selectedDate]) copy[selectedDate] = { go: emptyVehicleMap(), back: emptyVehicleMap() };
      const target = mode==="go" ? copy[selectedDate].go : copy[selectedDate].back;
      const next = mutator(target);
      if (mode==="go") copy[selectedDate].go = next; else copy[selectedDate].back = next;
      return copy;
    });
  }

  function addStudent(){
    const name = newName.trim(); if(!name) return;
    setStudents(s=>[...s, { id: uid(), name, group: newGroup || "" }]);
    setNewName("");
  }

  // OCR（動的ロード）
  async function importFromImage(file){
    setOcrBusy(true);
    setOcrLog("画像解析を開始...");
    try {
      const { default: Tesseract } = await import("tesseract.js"); // ← Safari対応
      const { data } = await Tesseract.recognize(file, "jpn");
      alert("OCR結果:\n" + (data?.text ?? ""));
    } catch(e){
      setOcrLog("OCRに失敗しました");
      console.error(e);
    } finally {
      setTimeout(()=>setOcrBusy(false), 600);
    }
  }

  return (
    <div className="h-screen w-screen bg-gray-50">
      <div className="p-2 border-b bg-white flex justify-between">
        <div className="flex gap-2">
          <button onClick={()=>setMode("go")} className={mode==="go"?"bg-blue-600 text-white px-3":"px-3"}>行き</button>
          <button onClick={()=>setMode("back")} className={mode==="back"?"bg-blue-600 text-white px-3":"px-3"}>帰り</button>
        </div>
        <label className="cursor-pointer">
          画像から（β）
          <input type="file" accept="image/*" className="hidden" onChange={(e)=> e.target.files && importFromImage(e.target.files[0])}/>
        </label>
      </div>
      <div className="p-3">
        <div>選択日: {selectedDate}</div>
        <input type="date" value={selectedDate} onChange={(e)=> setSelectedDate(clampDateStr(e.target.value))}/>
      </div>
      <div className="p-3">
        <h2 className="font-bold">名簿</h2>
        <div className="flex gap-2">
          <input value={newName} onChange={(e)=>setNewName(e.target.value)} placeholder="氏名"/>
          <input value={newGroup} onChange={(e)=>setNewGroup(e.target.value)} placeholder="所属"/>
          <button onClick={addStudent}>追加</button>
        </div>
        <ul>
          {students.map(s=>(
            <li key={s.id} style={{borderLeft:`4px solid ${colorForGroup(groups, s.group)}`}}>{s.name} ({s.group})</li>
          ))}
        </ul>
      </div>
      {ocrBusy && <div className="p-2 text-sm">{ocrLog}</div>}
    </div>
  );
}
