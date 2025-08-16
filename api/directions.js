// api/directions.js  (Vercel Serverless Function)
export default async function handler(req, res) {
  try {
    const { origin, destination, departure, details } = req.query;
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return res.status(500).json({ error: "Missing GOOGLE_MAPS_API_KEY" });
    }
    if (!origin || !destination) {
      return res.status(400).json({ error: "origin and destination are required" });
    }

    const params = new URLSearchParams({
      origin,
      destination,
      mode: "transit",
      alternatives: "false",
      transit_routing_preference: "fewer_transfers",
      departure_time: departure || Math.floor(Date.now() / 1000),
      key,
    });

    const url = `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`;
    const r = await fetch(url);
    const data = await r.json();

    if (data.status !== "OK" || !data.routes?.[0]?.legs?.[0]) {
      return res
        .status(502)
        .json({ error: "No transit route", providerStatus: data.status, data });
    }

    const route = data.routes[0];
    const leg = route.legs[0];

    // Build optional step info if requested
    let steps = undefined;
    if (details) {
      steps = leg.steps?.map((s) => ({
        travel_mode: s.travel_mode,
        html_instructions: s.html_instructions,
        transit_details: s.transit_details || null,
      }));
    }

    res.setHeader(
      "Cache-Control",
      "s-maxage=300, stale-while-revalidate=86400"
    );
    return res.status(200).json({
      overview_polyline: route.overview_polyline?.points || null,
      meters: leg.distance?.value ?? null,
      seconds: leg.duration?.value ?? null,
      steps,
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", message: String(e) });
  }
}
