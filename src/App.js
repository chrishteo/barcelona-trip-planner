import React, { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// ---- Persistence key ----
const STORAGE_KEY = "barcelona-trip-planner:v1";

// Basic Leaflet marker fix for CRA + Webpack
const DefaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  shadowSize: [41, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

// --- Types ---
/** @typedef {{ id:string, name:string, lat:number, lon:number, address?:string }} Place */
/** @typedef {{ place: Place, start: string, end: string, notes?: string }} Stop */
/** @typedef {{ [isoDate: string]: Stop[] }} Plan */

// --- Helpers ---
function formatDate(d){ return d.toISOString().slice(0,10); }
function parseDate(s){ return new Date(s + "T00:00:00"); }
function daterange(start, end){
  const out=[]; let d = parseDate(start); const e = parseDate(end);
  while(d<=e){ out.push(formatDate(d)); d = new Date(d.getTime()+86400000); }
  return out;
}
function haversine(lat1, lon1, lat2, lon2){
  const R = 6371e3, toRad = x=>x*Math.PI/180;
  const dphi = toRad(lat2-lat1), dl = toRad(lon2-lon1);
  const a = Math.sin(dphi/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function estimateWalkTimeMeters(m){
  const speed = 1.25; // m/s (~4.5 km/h)
  const sec = m / speed; const h = Math.floor(sec/3600); const min = Math.round((sec%3600)/60);
  return (h?`${h}h `:"") + `${min}m`;
}
function download(filename, text){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type:"text/plain"}));
  a.download = filename; a.click(); URL.revokeObjectURL(a.href);
}
function toICS(plan, tripName){
  const nl = "\r\n";
  const esc = s => String(s||"").replace(/[,;\\]/g, m => ({",":"\\,", ";":"\\;", "\\":"\\\\"}[m]));
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  let ics = `BEGIN:VCALENDAR${nl}VERSION:2.0${nl}PRODID:-//TripPlanner//EN${nl}`;
  Object.entries(plan).forEach(([date, stops])=>{
    stops.forEach((s, idx)=>{
      const dt = date.replace(/-/g, "");
      const start = `${dt}T${s.start.replace(":","")}00`;
      const end = `${dt}T${s.end.replace(":","")}00`;
      const uid = `${date}-${idx}-${Math.random().toString(36).slice(2)}@tripplanner`;
      const summary = `${esc(tripName)}: ${esc(s.place.name)}`;
      const loc = `${s.place.lat},${s.place.lon} ${esc(s.place.address || "")}`;
      const desc = esc(s.notes || "");
      ics += `BEGIN:VEVENT${nl}DTSTAMP:${now}${nl}UID:${uid}${nl}DTSTART:${start}${nl}DTEND:${end}${nl}SUMMARY:${summary}${nl}LOCATION:${loc}${nl}DESCRIPTION:${desc}${nl}END:VEVENT${nl}`;
    });
  });
  ics += `END:VCALENDAR${nl}`;
  return ics;
}

function FitToDayBounds({points}){
  const map = useMap();
  useEffect(()=>{
    if(!points || points.length===0) return;
    const latlngs = points.map(p=>L.latLng(p[0], p[1]));
    const b = L.latLngBounds(latlngs);
    map.fitBounds(b.pad(0.2));
  },[points, map]);
  return null;
}

export default function BarcelonaTripPlanner(){
  // ---- Load initial state from localStorage (with sensible fallbacks) ----
  const initial = (() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  })();

  const [tripName, setTripName] = useState(initial?.tripName ?? "Barcelona, September 2025");
  const [startDate, setStartDate] = useState(initial?.startDate ?? "2025-09-01");
  const [endDate, setEndDate] = useState(initial?.endDate ?? "2025-09-07");
  const days = useMemo(()=>daterange(startDate, endDate), [startDate, endDate]);
  const [selectedDay, setSelectedDay] = useState(
    () => (initial?.selectedDay && days.includes(initial.selectedDay)) ? initial.selectedDay : (days[0] ?? "2025-09-01")
  );
  const [plan, setPlan] = useState(/** @type {Plan} */(initial?.plan ?? {}));
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(/** @type {Place[]} */([]));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Keep selectedDay valid when date range changes
  useEffect(()=>{
    if(!days.includes(selectedDay)) setSelectedDay(days[0]);
  }, [days, selectedDay]);

  // ---- Persist to localStorage whenever key bits change ----
  useEffect(()=>{
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tripName, startDate, endDate, selectedDay, plan
      }));
    }catch{}
  }, [tripName, startDate, endDate, selectedDay, plan]);

  // Search places via Nominatim
  useEffect(()=>{
    let active = true;
    async function run(){
      setError("");
      if(query.trim().length < 3){ setResults([]); return; }
      setLoading(true);
      try{
        const url = new URL("https://nominatim.openstreetmap.org/search");
        url.searchParams.set("q", `${query} Barcelona`);
        url.searchParams.set("format","jsonv2");
        url.searchParams.set("limit","8");
        const res = await fetch(url.toString(), { headers: { "Accept": "application/json", "User-Agent": "TripPlanner/1.0 (chatgpt)" }});
        const data = await res.json();
        if(!active) return;
        const places = data.map(d=>({
          id: String(d.place_id),
          name: d.display_name.split(",")[0],
          lat: parseFloat(d.lat),
          lon: parseFloat(d.lon),
          address: d.display_name
        }));
        setResults(places);
      }catch{
        setError("Search failed. Try again or check your network.");
      }finally{ setLoading(false); }
    }
    run();
    return ()=>{ active=false };
  }, [query]);

  const dayStops = plan[selectedDay] || [];
  const coords = dayStops.map(s=>[s.place.lat, s.place.lon]);
  const totalMeters = coords.reduce((acc, cur, i)=>{
    if(i===0) return 0; const prev = coords[i-1];
    return acc + haversine(prev[0], prev[1], cur[0], cur[1]);
  },0);

  function addToDay(place){
    const defStart = "10:00"; const defEnd = "11:00";
    const next = {...plan};
    next[selectedDay] = [...(next[selectedDay]||[]), { place, start: defStart, end: defEnd, notes: "" }];
    setPlan(next);
  }
  function removeStop(idx){
    const next = {...plan};
    next[selectedDay] = (next[selectedDay]||[]).filter((_,i)=>i!==idx);
    setPlan(next);
  }
  function move(idx, dir){
    const next = {...plan};
    const arr = [...(next[selectedDay]||[])];
    const j = idx+dir; if(j<0 || j>=arr.length) return;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    next[selectedDay] = arr; setPlan(next);
  }
  function updateStop(idx, patch){
    const next = {...plan};
    next[selectedDay] = (next[selectedDay]||[]).map((s,i)=> i===idx ? {...s, ...patch} : s);
    setPlan(next);
  }
  function exportICS(){
    const ics = toICS(plan, tripName);
    download(`${tripName.replace(/\s+/g,"_")}.ics`, ics);
  }
  function exportJSON(){
    download(`${tripName.replace(/\s+/g,"_")}.json`, JSON.stringify({tripName, startDate, endDate, selectedDay, plan}, null, 2));
  }
  function importJSON(evt){
    const file = evt.target.files?.[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      try{
        const data = JSON.parse(String(reader.result));
        setTripName(data.tripName ?? tripName);
        setStartDate(data.startDate ?? startDate);
        setEndDate(data.endDate ?? endDate);
        setPlan(data.plan ?? {});
        if(data.selectedDay){ setSelectedDay(data.selectedDay); }
      }catch{ alert("Invalid JSON"); }
    };
    reader.readAsText(file);
  }

  return (
    <div className="min-h-screen w-full grid grid-cols-1 lg:grid-cols-12 gap-4 p-4 bg-slate-50">
      {/* Left: Controls */}
      <div className="lg:col-span-3 space-y-4">
        <div className="bg-white rounded-2xl shadow p-4 space-y-3">
          <h1 className="text-2xl font-semibold">Barcelona Trip Planner</h1>
          <input className="w-full border rounded-xl p-2" value={tripName} onChange={(e)=>setTripName(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">Start
              <input type="date" className="w-full border rounded-xl p-2" value={startDate} onChange={(e)=>setStartDate(e.target.value)} />
            </label>
            <label className="text-sm">End
              <input type="date" className="w-full border rounded-xl p-2" value={endDate} onChange={(e)=>setEndDate(e.target.value)} />
            </label>
          </div>
          <div>
            <label className="text-sm font-medium">Select day</label>
            <select value={selectedDay} onChange={(e)=>setSelectedDay(e.target.value)} className="w-full border rounded-xl p-2 mt-1">
              {days.map(d=>(<option key={d} value={d}>{d}</option>))}
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={exportICS} className="px-3 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700">Export .ics</button>
            <button onClick={exportJSON} className="px-3 py-2 rounded-xl bg-slate-700 text-white hover:bg-slate-800">Export JSON</button>
            <label className="px-3 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 cursor-pointer">Import JSON
              <input type="file" accept="application/json" onChange={importJSON} className="hidden" />
            </label>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow p-4 space-y-3">
          <h2 className="text-lg font-semibold">Add places</h2>
          <input
            value={query}
            onChange={(e)=>setQuery(e.target.value)}
            placeholder="Search e.g. Sagrada Família"
            className="w-full border rounded-xl p-2"
          />
          {loading && <div className="text-sm text-slate-500">Searching…</div>}
          {error && <div className="text-sm text-rose-600">{error}</div>}
          <div className="max-h-48 overflow-auto divide-y">
            {results.map(r=> (
              <div key={r.id} className="py-2 flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="text-xs text-slate-500 truncate max-w-[200px]">{r.address}</div>
                </div>
                <button onClick={()=>addToDay(r)} className="px-2 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">Add</button>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">Search powered by OpenStreetMap Nominatim. Times/distances are estimates.</p>
        </div>
      </div>

      {/* Center: Map */}
      <div className="lg:col-span-6 overflow-hidden rounded-2xl shadow relative min-h-[400px]">
        <MapContainer center={[41.387, 2.17]} zoom={13} style={{height:"100%", minHeight: 500}}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {coords.map((c,i)=>(
            <Marker key={i} position={c}></Marker>
          ))}
          {coords.length>1 && <Polyline positions={coords} />}
          <FitToDayBounds points={coords} />
        </MapContainer>
        <div className="absolute top-2 left-2 bg-white/90 backdrop-blur rounded-xl px-3 py-1 text-sm shadow">
          {coords.length>1
            ? <div>Distance (straight-line): {(totalMeters/1000).toFixed(2)} km · Est. walk: {estimateWalkTimeMeters(totalMeters)}</div>
            : <div>Add at least two places to see a route</div>}
        </div>
      </div>

      {/* Right: Day timetable */}
      <div className="lg:col-span-3 bg-white rounded-2xl shadow p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{selectedDay} timetable</h2>
          <div className="text-sm text-slate-500">{dayStops.length} stops</div>
        </div>
        <div className="space-y-3">
          {dayStops.length===0 && <div className="text-sm text-slate-500">No stops yet. Add places from the left panel.</div>}
          {dayStops.map((s, idx)=> (
            <div key={idx} className="border rounded-xl p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{s.place.name}</div>
                  <div className="text-xs text-slate-500 truncate max-w-[220px]">{s.place.address}</div>
                </div>
                <div className="flex gap-1">
                  <button className="px-2 py-1 bg-slate-200 rounded-lg" onClick={()=>move(idx,-1)}>↑</button>
                  <button className="px-2 py-1 bg-slate-200 rounded-lg" onClick={()=>move(idx,1)}>↓</button>
                  <button className="px-2 py-1 bg-rose-100 text-rose-700 rounded-lg" onClick={()=>removeStop(idx)}>Remove</button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 items-center">
                <label className="text-xs">Start
                  <input type="time" value={s.start} onChange={(e)=>updateStop(idx,{start:e.target.value})} className="w-full border rounded-lg p-1" />
                </label>
                <label className="text-xs">End
                  <input type="time" value={s.end} onChange={(e)=>updateStop(idx,{end:e.target.value})} className="w-full border rounded-lg p-1" />
                </label>
              </div>
              <textarea value={s.notes||""} onChange={(e)=>updateStop(idx,{notes:e.target.value})} placeholder="Notes (tickets, lunch, etc.)" className="w-full border rounded-lg p-2 text-sm"/>
            </div>
          ))}
        </div>
        <div className="text-xs text-slate-500">Tip: set times to match opening hours; export as .ics and drop into your calendar.</div>
      </div>

      {/* Footer help */}
      <div className="lg:col-span-12 text-center text-xs text-slate-500">
        Built with React, Leaflet, and OpenStreetMap tiles. Routes are straight-lines for simplicity. For turn-by-turn routing, replace Polyline with an OSRM/Mapbox route fetch.
      </div>
    </div>
  );
}
