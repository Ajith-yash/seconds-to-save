/**
 * Smart Ambulance Alert and Traffic Clearance System
 * Public Runtime Configuration
 *
 * IMPORTANT SECURITY RULE:
 * Never place your private Ably API key in this file or any frontend script.
 * The private ABLY_API_KEY must be stored ONLY in your serverless environment variables.
 */
window.APP_CONFIG = {
  // Application & Key Metadata (Public identifiers only)
  ABLY_APP_NAME: "Smart-Ambulance-Alert",
  ABLY_KEY_NICKNAME: "Ambulance-Realtime",

  // Managed Serverless Endpoint Base URL
  // Automatically uses relative /.netlify/functions/api (Netlify) or /api (Vercel/Custom)
  // If hosting frontend on GitHub Pages, set SERVERLESS_API_URL to your deployed Netlify/Vercel function URL.
  SERVERLESS_API_URL: window.SERVERLESS_API_URL || "",

  // Map & Routing Providers (Preserved from Working Website)
  MAP_STYLE: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  OSRM_URL: "https://router.project-osrm.org",
  OVERPASS_URL: "https://overpass-api.de/api/interpreter",
  PHOTON_URL: "https://photon.komoot.io/api/",

  // Default map center before GPS lock (Chennai, Tamil Nadu)
  DEFAULT_CENTER: [80.1462, 13.0382], // Iyyappanthangal / Chennai region
  DEFAULT_ZOOM: 12,

  // Default Route-Based Proximity Parameters
  DEFAULT_CORRIDOR_METERS: 300,
  FORWARD_LOOKAHEAD_METERS: 5000,
  OFF_ROUTE_REROUTE_METERS: 80,
  PUBLISH_INTERVAL_MS: 4000
};
