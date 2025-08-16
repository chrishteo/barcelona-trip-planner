import React, { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { QRCodeCanvas } from "qrcode.react";

// ---- Persistence key ----
const STORAGE_KEY = "barcelona-trip-planner:v2";

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
  return R * 2 * Math.atan2(Math.sqrt(1-a), Math.sqrt(a));
}
function estimateHM(seconds){
  if (seconds == null) return "-";
  const h = Math.floor(seconds/3600);
  const m = Math.round((seconds%3600)/60);
  return (h?`${h}h `:"") + `${m}m`;
}
function formatDistance(m){
  if (m == null) return "-";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m/1000).toFixed(m < 10000 ? 1 : 2)} km`;
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

// --- Share-link helpers (URL-safe) ---
function encodeForUrl(obj) {
  const json = JSON.stringify(obj);
  const base64 = btoa(unescape(encodeURIComponent(json)));
  return encodeURIComponent(base64);
}
function decodeFromUrlParam(s) {
  try {
    const base64 = decodeURIComponent(s);
    const json = decodeURIComponent(escape(atob(base64)));
    return JSON.parse(json);
  } catch { return null; }
}
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      alert("Share link copied! You can also scan the QR code.");
    } else {
      window.prompt("Copy this link:", text);
    }
  } catch {
    window.prompt("Copy this link:", text);
  }
}

// Google Encoded Polyline decoder -> [lat,lng][]
function decodePolyline(str) {
  let index = 0, lat = 0, lng = 0, coords = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1)); lat += dlat;
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1)); lng += dlng;
    coords.push([lat * 1e-5, lng * 1e-5]);
  }
  return coords;
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
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); }
    catch { return null; }
  })();

  const [tripName, setTripName] = useState(initial?.tripName ?? "Barcelona, September 2025");
  const [startDate, setStartDate] = useState(initial?.startDate ?? "2025-09-01");
  const [endDate, setEndDate] = useState(initial?.endDate ?? "2025-09-07");
  const days = useMemo(()=>daterange(startDate, endDate), [startDate, endDate]);
  const [selectedDay, setSelectedDay] = useState(
    () => (initial?.selectedDay && days.includes(initial.selectedDay)) ? initial.selectedDay : (days[0] ?? "2025-09-01")
  );
  const [plan, setPlan] = useState(/** @type {Plan} */(initial?.plan ?? {}));

  // Routing / hotel
  const [routeMode, setRouteMode] = useState(initial?.routeMode ?? "foot"); // "foot" | "driving" | "bike" | "transit"
  const [hotel, setHotel] = useState(initial?.hotel ?? null);               // Place | null
  const [useHotelStart, setUseHotelStart] = useState(initial?.useHotelStart ?? true);
  const [useHotelEnd, setUseHotelEnd] = useState(initial?.useHotelEnd ?? true);

  // Search UI
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(/** @type {Place[]} */([]));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // QR modal
  const [showQR, setShowQR] = useState(false);
  const [shareUrl, setShareUrl] = useState("");

  // Routing results
  const [segments, setSegments] = useState([]); // [{ line:[lat,lng][], meters, seconds }]
  const [routingError, setRoutingError] = useState("");

  // Keep selectedDay valid when date range changes
  useEffect(()=>{
    if(!days.includes(selectedDay)) setSelectedDay(days[0]);
  }, [days, selectedDay]);

  // Persist
  useEffect(()=>{
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tripName, startDate, endDate, selectedDay, plan,
        routeMode, hotel, useHotelStart, useHotelEnd
      }));
    }catch{}
  }, [tripName, startDate, endDate, selectedDay, plan, routeMode, hotel, useHotelStart, useHotelEnd]);

  // Import from ?data= once
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const encoded = params.get("data");
    if (!encoded) return;
    const incoming = decodeFromUrlParam(encoded);
    if (!incoming) return;

    setTripName(incoming.tripName ?? tripName);
    setStartDate(incoming.startDate ?? startDate);
    setEndDate(incoming.endDate ?? endDate);
    setPlan(incoming.plan ?? {});
    if (incoming.selectedDay) setSelectedDay(incoming.selectedDay);
    if (incoming.routeMode) setRouteMode(incoming.routeMode);
    if (typeof incoming.useHotelStart === "boolean") setUseHotelStart(incoming.useHotelStart);
    if (typeof incoming.useHotelEnd === "boolean") setUseHotelEnd(incoming.useHotelEnd);
    if (incoming.hotel) setHotel(incoming.hotel);

    params.delete("data");
    const newUrl = window.location.pathname + (params.toString() ? "?" + params.toString() : "");
    window.history.replaceState({}, "", newUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Build effective list of stops (optionally start/end at hotel)
  const dayStops = plan[selectedDay] || [];
  const effectiveStops = useMemo(() => {
    let arr = [...dayStops];
    if (hotel && useHotelStart) arr = [{ place: hotel, start: "08:00", end: "08:00" }, ...arr];
    if (hotel && useHotelEnd)   arr = [...arr, { place: hotel, start: "22:00", end: "22:00" }];
    return arr;
  }, [dayStops, hotel, useHotelStart, useHotelEnd]);

  const coords = effectiveStops.map(s => [s.place.lat, s.place.lon]);

  // Fetch a route segment
  async function fetchRoute(mode, from, to){
    if (mode === "transit") {
      const origin = `${from[0]},${from[1]}`;
      const destination = `${to[0]},${to[1]}`;
      const r = await fetch(`/api/directions?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`);
      if (!r.ok) throw new Error("transit route");
      const data = await r.json();
      if (!data?.overview_polyline) throw new Error("no polyline");
      const line = decodePolyline(data.overview_polyline); // [lat,lng][]
      return { line, meters: data.meters ?? null, seconds: data.seconds ?? null };
    }
    // OSRM for foot/driving/bike
    const profile = mode === "driving" ? "driving" : (mode === "bike" ? "bike" : "foot");
    const url = `https://router.project-osrm.org/route/v1/${profile}/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if(!res.ok) throw new Error("route");
    const data = await res.json();
    const r0 = data.routes?.[0];
    if(!r0) throw new Error("no route");
    const line = r0.geometry.coordinates.map(([lng,lat])=>[lat,lng]);
    return { line, meters: r0.distance, seconds: r0.duration };
  }

  // Build segments when coords/mode change
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setRoutingError("");
      if (coords.length < 2) { setSegments([]); return; }
      const segs = [];
      for (let i=0; i<coords.length-1; i++){
        try{
          const seg = await fetchRoute(routeMode, coords[i], coords[i+1]);
          if (cancelled) return;
          segs.push(seg);
        }catch{
          // fallback straight line
          const m = haversine(coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1]);
          segs.push({ line:[coords[i], coords[i+1]], meters:m, seconds: m/1.25 });
          setRoutingError("Routing unavailable for some legs; showing straight lines.");
        }
      }
      if (!cancelled) setSegments(segs);
    })();
    return ()=>{ cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDay, JSON.stringify(coords), routeMode]);

  const totalMeters = segments.reduce((a,s)=>a + (s?.meters||0), 0);
  const totalSeconds = segments.reduce((a,s)=>a + (s?.seconds||0), 0);

  // Mutators
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
    const payload = { tripName, startDate, endDate, selectedDay, plan, routeMode, hotel, useHotelStart, useHotelEnd };
    download(`${tripName.replace(/\s+/g,"_")}.json`, JSON.stringify(payload, null, 2));
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
        if(data.routeMode) setRouteMode(data.routeMode);
        if(typeof data.useHotelStart === "boolean") setUseHotelStart(data.useHotelStart);
        if(typeof data.useHotelEnd === "boolean") setUseHotelEnd(data.useHotelEnd);
        if(data.hotel) setHotel(data.hotel);
      }catch{ alert("Invalid JSON"); }
    };
    reader.readAsText(file);
  }
  function openShare() {
    const payload = { tripName, startDate, endDate, selectedDay, plan, routeMode, hotel, useHotelStart, useHotelEnd };
    const url = `${window.location.origin}${window.location.pathname}?data=${encodeForUrl(payload)}`;
    setShareUrl(url);
    copyToClipboard(url);
    setShowQR(true);
  }

  // Lock scroll when modal open
  useEffect(() => {
    if (showQR) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = prev; };
    }
  }, [showQR]);

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
            <button onClick={openShare} className="px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700">
              Share trip (link + QR)
            </button>
          </div>
        </div>

        {/* Hotel / Base + Travel Mode */}
        <div className="bg-white rounded-2xl shadow p-4 space-y-2">
          <h3 className="font-semibold">Hotel / Base</h3>
          {hotel ? (
            <>
              <div className="text-sm">
                <div className="font-medium">{hotel.name}</div>
                <div className="text-xs text-slate-500 truncate">{hotel.address}</div>
              </div>
              <div className="flex flex-wrap gap-3 items-center">
                <label className="text-sm flex items-center gap-2">
                  <input type="checkbox" checked={useHotelStart} onChange={(e)=>setUseHotelStart(e.target.checked)} />
                  Start here
                </label>
                <label className="text-sm flex items-center gap-2">
                  <input type="checkbox" checked={useHotelEnd} onChange={(e)=>setUseHotelEnd(e.target.checked)} />
                  End here
                </label>
                <button className="px-2 py-1 rounded-lg bg-rose-100 text-rose-700" onClick={()=>setHotel(null)}>Clear</button>
              </div>
            </>
          ) : (
            <div className="text-sm text-slate-500">Pick any search result below and click “Set as hotel”.</div>
          )}
          <div className="pt-2">
            <label className="text-sm font-medium">Travel mode</label>
            <select
              value={routeMode}
              onChange={(e)=>setRouteMode(e.target.value)}
              className="w-full border rounded-xl p-2 mt-1"
            >
              <option value="foot">Walking</option>
              <option value="driving">Driving</option>
              <option value="bike">Cycling</option>
              <option value="transit">Public transit</option>
            </select>
            {routeMode === "transit" && <div className="text-xs text-slate-500 mt-1">Transit uses Google Directions via your secure Vercel API.</div>}
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
                <div className="flex gap-2">
                  <button onClick={()=>addToDay(r)} className="px-2 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">Add</button>
                  <button onClick={()=>setHotel(r)} className="px-2 py-1 rounded-lg bg-amber-500 text-white hover:bg-amber-600">Set as hotel</button>
                </div>
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
          {coords.map((c,i)=>( <Marker key={i} position={c}></Marker> ))}
          {/* Routed polylines (transit or OSRM) */}
          {segments.map((s, i) => (<Polyline key={i} positions={s.line} />))}
          <FitToDayBounds points={coords} />
        </MapContainer>
        <div className="absolute top-2 left-2 bg-white/90 backdrop-blur rounded-xl px-3 py-1 text-sm shadow">
          {coords.length>1
            ? <div>Total: {formatDistance(totalMeters)} · ETA ~ {estimateHM(totalSeconds)}</div>
            : <div>Add at least two places to see a route</div>}
          {routingError && <div className="text-rose-600">{routingError}</div>}
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

        {/* Per-leg breakdown */}
        {segments.length > 0 && (
          <div className="mt-2 text-xs text-slate-500 space-y-1">
            {segments.map((s,i)=>(
              <div key={i}>Leg {i+1}: {formatDistance(s.meters)} · ~{Math.round((s.seconds||0)/60)} min</div>
            ))}
          </div>
        )}

        <div className="text-xs text-slate-500">Tip: set times to match opening hours; export as .ics and drop into your calendar.</div>
      </div>

      {/* Footer */}
      <div className="lg:col-span-12 text-center text-xs text-slate-500">
        Walking/Driving/Cycling routes via OSRM; Public transit via Google Directions (proxied). Distances shown in meters/kilometers.
      </div>

      {/* QR Modal */}
      {showQR && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[9999]">
          <div className="bg-white rounded-2xl shadow-xl p-5 w-full max-w-sm text-center space-y-3">
            <h3 className="text-lg font-semibold">Scan this to open your trip</h3>
            <div className="mx-auto w-fit bg-white p-3 rounded-xl">
              <QRCodeCanvas value={shareUrl || window.location.href} size={256} includeMargin />
            </div>
            <div className="text-xs break-all text-slate-600 max-h-24 overflow-auto">{shareUrl}</div>
            <div className="flex gap-2 justify-center">
              <a href={shareUrl} target="_blank" rel="noreferrer" className="px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700">
                Open link
              </a>
              <button onClick={()=>setShowQR(false)} className="px-3 py-2 rounded-xl bg-slate-200 hover:bg-slate-300">
                Close
              </button>
            </div>
            <div className="text-[10px] text-slate-500">If a chat app breaks long links, scan the QR instead.</div>
          </div>
        </div>
      )}
    </div>
  );
}
