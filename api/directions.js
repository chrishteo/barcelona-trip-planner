// api/directions.js  (Vercel Serverless Function)
export default async function handler(req, res) {
  try {
    const { origin, destination, departure } = req.query;
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return res.status(500).json({ error: "Missing GOOGLE_MAPS_API_KEY" });
    }
    if (!origin || !destination) {
      return res.status(400).json({ error: "origin and destination are required" });
    }

    // Google Directions API (TRANSIT)
    const params = new URLSearchParams({
      origin,                       // "lat,lng"
      destination,                  // "lat,lng"
      mode: "transit",
      alternatives: "false",
      transit_routing_preference: "fewer_transfers",
      departure_time: departure || Math.floor(Date.now() / 1000), // now, seconds
      key,
    });

    const url = `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`;
    const r = await fetch(url);
    const data = await r.json();

    if (data.status !== "OK" || !data.routes?.[0]?.legs?.[0]) {
      return res.status(502).json({ error: "No transit route", providerStatus: data.status, data });
    }

    // Return only what we need: overview polyline + meters + seconds
    const route = data.routes[0];
    const leg = route.legs[0];
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=86400");
    return res.status(200).json({
      overview_polyline: route.overview_polyline?.points || null,
      meters: leg.distance?.value ?? null,
      seconds: leg.duration?.value ?? null,
      // Optional: expose transit details if you want them later
      // steps: leg.steps?.map(s => ({ travel_mode: s.travel_mode, html_instructions: s.html_instructions }))
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", message: String(e) });
  }
}
