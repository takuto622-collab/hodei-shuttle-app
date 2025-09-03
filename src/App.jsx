import React, { useMemo, useRef, useState, useEffect } from "react";

// ============================
// 放デイ送迎MVP v3（iPad対応）
// - iPad/Safari向け: Pointer Eventsでドラッグ
// - 顔写真なし
// - 行き/帰りタブ、8車を4x2で常時表示
// - CSV入出力（テンプレ生成）、印刷、ローカル保存
// ============================

/** @typedef {{ id: string; name: string }} Student */
/** @typedef {{ studentId: string; pickup: string; drop: string }} Assignment */
/** @typedef {{ [vehicleId: string]: Assignment[] }} VehicleMap */

const VEHICLE_COUNT = 8;
const VEHICLE_IDS = Array.from({ length: VEHICLE_COUNT }, (_, i) => `v${i + 1}`);
const STORAGE_KEY = "dispatch-mvp-v3";

function uid() { return Math.random().toString(36).slice(2, 9); }
function loadState() {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
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
  const [mode, setMode] = useState(persisted?.mode ?? "go");

  const vehicles = mode === "go" ? vehiclesGo : vehiclesBack;
  const setVehicles = mode === "go" ? setVehiclesGo : setVehiclesBack;

  const [vehicleNames, setVehicleNames] = useState(
    persisted?.vehicleNames ?? Object.fromEntries(VEHICLE_IDS.map((id, i) => [id, `車${i + 1}`]))
  );

  const [newName, setNewName] = useState("");

  // iPad向けポインタードラッグ
  const [draggingId, setDraggingId] = useState(null);
  const [dragPos, setDragPos] = useState({ x: 0, y: 0 });
  const [hoverVehicle, setHoverVehicle] = useState(null);
  const vehicleRefs = useRef(Object.fromEntries(VEHICLE_IDS.map((id) => [id, React.createRef()])));

  useEffect(() => { saveState({ students, vehiclesGo, vehiclesBack, vehicleNames, mode }); }, [students, vehiclesGo, vehiclesBack, vehicleNames, mode]);

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
    setVehiclesGo((prev) => { const copy = structuredClone(prev); for (const vid of Object.keys(copy)) copy[vid] = copy[vid].filter((a) => a.studentId !== id); return copy; });
    setVehiclesBack((prev) => { const copy = structuredClone(prev); for (const vid of Object.keys(copy)) copy[vid] = copy[vid].filter((a) => a.studentId !== id); return copy; });
  }
  function unassign(studentId) {
    const setter = mode === "go" ? setVehiclesGo : setVehiclesBack;
    setter((prev) => { const copy = structuredClone(prev); for (const vid of Object.keys(copy)) copy[vid] = copy[vid].filter((a) => a.studentId !== studentId); return copy; });
  }

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
    const csv = rows.map((r) => r.map((x) => `"${(x ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `送迎割当_${mode}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadTemplate() {
    const rows = [["便", "車両", "氏名", "ピックアップ", "降車"], [mode === "go" ? "行き" : "帰り", "車1", "例：山田太郎", "15:30", "16:10"]];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "テンプレート.csv"; a.click(); URL.revokeObjectURL(url);
  }

  function importCSV(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (!lines.length) return;
      const header = lines[0].split(',');
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
        const hasDirection = hasBin;
        const bin = hasDirection ? binMaybe : (mode === "go" ? "行き" : "帰り");
        const car = hasDirection ? carMaybe : binMaybe;
        const name = hasDirection ? nameMaybe : carMaybe;
        const pickup = hasDirection ? pickupMaybe : nameMaybe;
        const drop = hasDirection ? dropMaybe : pickupMaybe;

        if (!name) continue;
        if (!nameToId.has(name)) {
          const id = uid();
          nameToId.set(name, id);
          newStudents.push({ id, name });
        }
        const id = nameToId.get(name);

        let vid = Object.keys(newVehicleNames).find((k) => newVehicleNames[k] === car);
        if (!vid) {
          vid = VEHICLE_IDS.find((x) => newVehicleNames[x].startsWith("車")) ?? VEHICLE_IDS[0];
          newVehicleNames[vid] = car || newVehicleNames[vid];
        }
        const target = bin === "行き" ? newVehiclesGo : newVehiclesBack;
        for (const k of Object
