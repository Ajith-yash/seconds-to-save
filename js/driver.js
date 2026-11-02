/**
 * Smart Ambulance Alert and Traffic Clearance System
 * Ambulance Driver Console — Real GPS, OSRM Routing, Ably Publishing & Rerouting
 */

(function () {
  const $ = id => document.getElementById(id);
  const SA = window.SmartAmbulance;

  let driverUser = null;
  let map = null;
  let ambulanceMarker = null;
  let hospitalMarker = null;
  let currentGps = null;
  let selectedHospital = null;
  let activeRoute = null;
  let routeChoices = [];
  let gpsWatchId = null;
  let publishIntervalId = null;

  let emergencyMode = false;
  let journeyActive = false;
  let currentJourneyId = null;
  let lastRerouteTime = 0;

  let ablyClient = null;
  let broadcastChannel = null;
  let vehicleChannel = null;

  // Initialize MapLibre GL Map (Preserved from Working Website)
  function initMap() {
    const center = (window.APP_CONFIG && window.APP_CONFIG.DEFAULT_CENTER) || [80.1462, 13.0382];
    map = new maplibregl.Map({
      container: "driverMap",
      style: (window.APP_CONFIG && window.APP_CONFIG.MAP_STYLE) || "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center,
      zoom: 12
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      map.addSource("route", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ec0016",
          "line-width": 6,
          "line-opacity": 0.92
        }
      });

      map.addSource("hospitals", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });
      map.addLayer({
        id: "hospital-points",
        type: "circle",
        source: "hospitals",
        paint: {
          "circle-radius": 7,
          "circle-color": "#00b86b",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff"
        }
      });
    });
  }

  function createBadgeMarker(color, text) {
    const el = document.createElement("div");
    el.style.cssText = `
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: ${color};
      border: 3px solid #ffffff;
      box-shadow: 0 3px 12px rgba(0,0,0,0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ffffff;
      font-weight: 800;
      font-size: 12px;
      font-family: Inter, sans-serif;
    `;
    el.textContent = text;
    return el;
  }

  function updateMarker(existing, pos, color, text) {
    if (!pos || !map) return existing;
    if (!existing) {
      return new maplibregl.Marker({ element: createBadgeMarker(color, text) })
        .setLngLat([pos.lng, pos.lat])
        .addTo(map);
    }
    existing.setLngLat([pos.lng, pos.lat]);
    return existing;
  }

  // Connect to Ably using short-lived driver token from serverless endpoint
  async function connectAblyDriver() {
    const connText = $("ablyConnStatus");
    const headerDot = $("headerStatusDot");
    const headerText = $("headerStatusText");

    try {
      if (connText) connText.textContent = "Authenticating Token…";
      ablyClient = await SA.connectAbly((state, reason) => {
        if (state === "connected") {
          if (connText) {
            connText.textContent = "Connected (Ably Realtime)";
            connText.style.color = "var(--token-green-online)";
          }
          if (headerDot) headerDot.className = emergencyMode ? "template-status-dot emergency" : "template-status-dot";
          if (headerText) headerText.textContent = `Ably Connected · ${driverUser.ambulanceId}`;
          // Re-publish state on reconnect if journey is active
          if (journeyActive && currentGps) {
            publishTelemetry("location-update");
          }
        } else if (state === "disconnected" || state === "suspended") {
          if (connText) {
            connText.textContent = "Reconnecting to Ably…";
            connText.style.color = "var(--token-amber-warn)";
          }
          if (headerDot) headerDot.className = "template-status-dot offline";
        } else if (state === "failed") {
          const msg = (reason && reason.message) || "Ably connection failed";
          if (connText) {
            connText.textContent = msg.includes("ABLY_KEY_MISSING")
              ? "Configure ABLY_API_KEY in Serverless Env"
              : "Connection Failed";
            connText.style.color = "var(--token-red-primary)";
          }
          SA.showToast(msg);
        }
      });

      // Attach to authorised channels: 'ambulance' and 'ambulance:{ambulanceId}'
      broadcastChannel = ablyClient.channels.get("ambulance");
      vehicleChannel = ablyClient.channels.get(`ambulance:${driverUser.ambulanceId}`);
      await broadcastChannel.presence.enter({
        ambulanceId: driverUser.ambulanceId,
        ambulanceReg: driverUser.ambulanceReg,
        driverName: driverUser.driverName,
        emergencyMode
      });
    } catch (err) {
      if (connText) {
        connText.textContent = "Token Error — Check ABLY_API_KEY";
        connText.style.color = "var(--token-red-primary)";
      }
      SA.showToast(err.message || "Could not initialize Ably Realtime.");
    }
  }

  // Publish real GPS & active journey payload to Ably channels
  async function publishTelemetry(eventType = "location-update") {
    if (!ablyClient || ablyClient.connection.state !== "connected") return;
    if (!currentGps && eventType !== "journey-ended") return;

    // Sample down route coordinates to stay well within Ably message payload limits
    let compactRoute = [];
    if (activeRoute && Array.isArray(activeRoute.coordinates)) {
      const coords = activeRoute.coordinates;
      const step = Math.max(1, Math.ceil(coords.length / 120));
      for (let i = 0; i < coords.length; i += step) {
        compactRoute.push({ lng: Number(coords[i][0].toFixed(5)), lat: Number(coords[i][1].toFixed(5)) });
      }
      const last = coords[coords.length - 1];
      if (last) compactRoute.push({ lng: Number(last[0].toFixed(5)), lat: Number(last[1].toFixed(5)) });
    }

    // Calculate remaining distance and ETA based on real progress along route
    let remainingDistance = activeRoute ? activeRoute.distance : null;
    let remainingDuration = activeRoute ? activeRoute.duration : null;

    if (currentGps && compactRoute.length >= 2 && activeRoute) {
      const prog = SA.progressAlongRoute(currentGps, compactRoute);
      const ratio = prog.total > 0 ? Math.max(0, Math.min(1, prog.along / prog.total)) : 0;
      remainingDistance = Math.max(0, Math.round(activeRoute.distance * (1 - ratio)));
      remainingDuration = Math.max(0, Math.round(activeRoute.duration * (1 - ratio)));
      if ($("drvDistance")) $("drvDistance").textContent = SA.formatDistance(remainingDistance);
      if ($("drvEta")) $("drvEta").textContent = SA.formatDuration(remainingDuration);
    }

    const payload = {
      eventType,
      ambulanceId: driverUser.ambulanceId,
      ambulanceReg: driverUser.ambulanceReg,
      driverName: driverUser.driverName,
      journeyId: currentJourneyId,
      latitude: currentGps ? currentGps.lat : null,
      longitude: currentGps ? currentGps.lng : null,
      accuracyMeters: currentGps ? currentGps.accuracy : null,
      timestamp: new Date().toISOString(),
      emergencyStatus: emergencyMode && journeyActive ? "EMERGENCY_ACTIVE" : (emergencyMode ? "EMERGENCY_STANDBY" : "OFF"),
      activeJourney: journeyActive,
      destination: selectedHospital
        ? { name: selectedHospital.name, lat: selectedHospital.lat, lng: selectedHospital.lng }
        : null,
      distanceMeters: remainingDistance,
      durationSeconds: remainingDuration,
      route: compactRoute
    };

    try {
      await Promise.all([
        broadcastChannel.publish("ambulance-telemetry", payload),
        vehicleChannel.publish("ambulance-telemetry", payload)
      ]);
      const lastPub = $("lastPublishedTime");
      if (lastPub) lastPub.textContent = new Date().toLocaleTimeString();
    } catch (err) {
      console.warn("Ably publish warning:", err.message);
    }
  }

  // Handle Real Geolocation Updates
  function onGpsPosition(pos) {
    const p = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: Math.round(pos.coords.accuracy || 0)
    };
    currentGps = p;
    ambulanceMarker = updateMarker(ambulanceMarker, p, "#ec0016", "AMB");

    if ($("drvGpsStatus")) {
      $("drvGpsStatus").textContent = `Live (${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} · ±${p.accuracy}m)`;
      $("drvGpsStatus").style.color = "var(--token-green-online)";
    }

    // Check off-route automatic rerouting (>80m threshold, 20s cooldown)
    if (journeyActive && selectedHospital && activeRoute && Date.now() - lastRerouteTime > 20000) {
      const routePts = activeRoute.coordinates.map(c => ({ lng: c[0], lat: c[1] }));
      const prog = SA.progressAlongRoute(p, routePts);
      const offThreshold = (window.APP_CONFIG && window.APP_CONFIG.OFF_ROUTE_REROUTE_METERS) || 80;
      if (prog.minDistance > offThreshold) {
        lastRerouteTime = Date.now();
        SA.showToast("Off-route detected (>80m). Automatically recalculating OSRM route…");
        calculateOsrmRoute(selectedHospital).then(() => {
          publishTelemetry("route-recalculated");
        }).catch(() => {});
      }
    }

    if (emergencyMode || journeyActive) {
      publishTelemetry("location-update");
    }

    updateButtonStates();
  }

  function requestAndWatchGps() {
    if (!navigator.geolocation) {
      if ($("drvGpsStatus")) $("drvGpsStatus").textContent = "Geolocation API unsupported";
      SA.showToast("This browser does not support HTML5 Geolocation.");
      return;
    }

    if ($("drvGpsStatus")) $("drvGpsStatus").textContent = "Requesting GPS permission…";

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onGpsPosition(pos);
        if (map && currentGps) {
          map.flyTo({ center: [currentGps.lng, currentGps.lat], zoom: 14 });
        }
        SA.showToast("Live GPS coordinates locked.");
      },
      (err) => {
        if ($("drvGpsStatus")) {
          $("drvGpsStatus").textContent = `Permission Denied / Error (${err.message})`;
          $("drvGpsStatus").style.color = "var(--token-red-primary)";
        }
        SA.showToast(`GPS Error: ${err.message}. Please allow location access.`);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );

    if (gpsWatchId === null) {
      gpsWatchId = navigator.geolocation.watchPosition(
        onGpsPosition,
        (err) => console.warn("GPS watch error:", err.message),
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
      );
    }
  }

  // OSRM Route Calculation & Alternatives (Preserved from Working Website)
  async function calculateOsrmRoute(dest) {
    if (!currentGps) {
      throw new Error("Acquire live GPS position first before calculating a route.");
    }
    const base = ((window.APP_CONFIG && window.APP_CONFIG.OSRM_URL) || "https://router.project-osrm.org").replace(/\/$/, "");
    const url = `${base}/route/v1/driving/${currentGps.lng},${currentGps.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson&steps=true&alternatives=true`;

    const res = await fetch(url);
    if (!res.ok) throw new Error("OSRM routing server unavailable. Try again shortly.");
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes || !data.routes.length) {
      throw new Error("No driving route found between your GPS location and this hospital.");
    }

    routeChoices = data.routes.slice(0, 3).map((r, idx) => ({
      index: idx,
      coordinates: r.geometry.coordinates,
      distance: r.distance,
      duration: r.duration,
      geometry: r.geometry
    }));

    activeRoute = routeChoices[0];
    renderActiveRouteOnMap();

    const selectEl = $("drvRouteSelect");
    if (selectEl) {
      selectEl.innerHTML = "";
      routeChoices.forEach((c, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = `Route ${i + 1}: ${SA.formatDistance(c.distance)} · ETA ${SA.formatDuration(c.duration)}`;
        selectEl.appendChild(opt);
      });
      selectEl.disabled = routeChoices.length < 2;
    }

    updateButtonStates();
    return activeRoute;
  }

  function renderActiveRouteOnMap() {
    if (!map || !activeRoute) return;
    const src = map.getSource("route");
    if (src) {
      src.setData({
        type: "Feature",
        geometry: activeRoute.geometry,
        properties: {}
      });
    }
    if ($("drvDistance")) $("drvDistance").textContent = SA.formatDistance(activeRoute.distance);
    if ($("drvEta")) $("drvEta").textContent = SA.formatDuration(activeRoute.duration);
    if ($("drvActiveRouteName") && selectedHospital) {
      $("drvActiveRouteName").textContent = `${selectedHospital.name} (${SA.formatDistance(activeRoute.distance)})`;
    }

    const coords = activeRoute.coordinates;
    if (coords && coords.length >= 2) {
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0])
      );
      map.fitBounds(bounds, { padding: 55, maxZoom: 15 });
    }
  }

  // Overpass API & Photon Hospital Discovery (Preserved from Working Website)
  async function searchMappedHospitals(queryText) {
    if (!currentGps) {
      throw new Error("Click 'Enable / Refresh GPS' first so hospitals near your actual location can be found.");
    }
    const radius = 15000;
    const pt = `${currentGps.lat},${currentGps.lng}`;
    const safeQuery = (queryText || "").replace(/[\\"]/g, " ").slice(0, 80);

    const overpassQuery = safeQuery
      ? `[out:json][timeout:20];(nwr["amenity"="hospital"]["name"~"${safeQuery}",i](around:${radius},${pt}););out center tags;`
      : `[out:json][timeout:20];(nwr["amenity"="hospital"](around:${radius},${pt}););out center tags;`;

    const overpassUrl = (window.APP_CONFIG && window.APP_CONFIG.OVERPASS_URL) || "https://overpass-api.de/api/interpreter";
    let items = [];

    try {
      const res = await fetch(overpassUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(overpassQuery),
        signal: AbortSignal.timeout(16000)
      });
      if (res.ok) {
        const data = await res.json();
        items = (data.elements || []).map((e) => {
          const lat = e.lat ?? (e.center && e.center.lat);
          const lng = e.lon ?? (e.center && e.center.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          return {
            name: (e.tags && e.tags.name) || "Mapped Hospital Facility",
            lat,
            lng,
            distance: SA.haversineMeters(currentGps, { lat, lng })
          };
        }).filter(Boolean);
      }
    } catch (e) {}

    // Photon Geocoder Fallback
    if (!items.length) {
      const photonUrl = (window.APP_CONFIG && window.APP_CONFIG.PHOTON_URL) || "https://photon.komoot.io/api/";
      const params = new URLSearchParams({
        q: safeQuery || "hospital",
        lat: String(currentGps.lat),
        lon: String(currentGps.lng),
        limit: "25",
        lang: "en"
      });
      const res = await fetch(`${photonUrl}?${params.toString()}`, { signal: AbortSignal.timeout(14000) });
      if (res.ok) {
        const data = await res.json();
        items = (data.features || []).map((f) => {
          const p = f.properties || {};
          const c = (f.geometry && f.geometry.coordinates) || [];
          const lat = Number(c[1]);
          const lng = Number(c[0]);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          const label = [p.name, p.street, p.city].filter(Boolean).join(", ");
          return {
            name: label || "Mapped Medical Facility",
            lat,
            lng,
            distance: SA.haversineMeters(currentGps, { lat, lng })
          };
        }).filter(Boolean);
      }
    }

    items.sort((a, b) => a.distance - b.distance);

    if (map && map.getSource("hospitals")) {
      map.getSource("hospitals").setData({
        type: "FeatureCollection",
        features: items.map(h => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [h.lng, h.lat] },
          properties: { name: h.name }
        }))
      });
    }

    return items;
  }

  function renderHospitalList(items) {
    const container = $("hospitalResultsList");
    if (!container) return;
    container.innerHTML = "";

    if (!items.length) {
      container.innerHTML = `<p style="font-size:13px;color:var(--token-text-muted);margin:0;">No mapped hospitals found matching that query. Try another search term.</p>`;
      return;
    }

    items.slice(0, 20).forEach((h) => {
      const row = document.createElement("div");
      row.className = "hospital-card-item";
      row.innerHTML = `
        <div>
          <b style="display:block;font-size:13.5px;color:var(--token-navy-heading);">${h.name}</b>
          <small style="color:var(--token-text-muted);font-size:12px;">${SA.formatDistance(h.distance)} straight-line · ${h.lat.toFixed(4)}, ${h.lng.toFixed(4)}</small>
        </div>
      `;
      const btn = document.createElement("button");
      btn.className = "btn-template-outline";
      btn.style.height = "36px";
      btn.style.padding = "0 14px";
      btn.textContent = "Select Route";
      btn.addEventListener("click", async () => {
        selectedHospital = h;
        hospitalMarker = updateMarker(hospitalMarker, h, "#00b86b", "H");
        if ($("drvActiveRouteName")) $("drvActiveRouteName").textContent = `Calculating route to ${h.name}…`;
        try {
          await calculateOsrmRoute(h);
          SA.showToast(`Route locked to ${h.name}.`);
          if (journeyActive) {
            publishTelemetry("route-updated");
          }
        } catch (err) {
          SA.showToast(err.message);
        }
      });
      row.appendChild(btn);
      container.appendChild(row);
    });
  }

  function updateButtonStates() {
    const startBtn = $("startJourneyBtn");
    const endBtn = $("endJourneyBtn");
    const emCard = $("emergencyModeBanner");
    const emBadge = $("drvEmergencyStatus");
    const emToggleBtn = $("toggleEmergencyModeBtn");

    if (emCard) emCard.classList.toggle("active", emergencyMode);
    if (emBadge) {
      emBadge.textContent = emergencyMode
        ? (journeyActive ? "EMERGENCY JOURNEY LIVE" : "EMERGENCY MODE ON")
        : "STANDBY (OFF)";
      emBadge.style.color = emergencyMode ? "var(--token-red-primary)" : "var(--token-text-muted)";
    }
    if (emToggleBtn) {
      emToggleBtn.textContent = emergencyMode ? "Turn Emergency Mode OFF" : "Activate Emergency Mode ON";
      emToggleBtn.className = emergencyMode ? "btn-template-navy" : "btn-template-red";
    }

    if (startBtn) {
      startBtn.disabled = journeyActive || !emergencyMode || !currentGps || !selectedHospital || !activeRoute;
    }
    if (endBtn) {
      endBtn.disabled = !journeyActive;
    }
  }

  // Lifecycle & Event Bindings
  document.addEventListener("DOMContentLoaded", async () => {
    // 1. Verify Server-Signed Driver Role (Prevents localStorage tampering)
    const verified = await SA.verifyAuthenticatedRole("driver");
    if (!verified) {
      window.location.href = "index.html?role=driver";
      return;
    }
    driverUser = verified;

    // Populate Driver Profile Details
    if ($("sidebarDriverName")) $("sidebarDriverName").textContent = driverUser.driverName;
    if ($("sidebarAmbulanceMeta")) $("sidebarDriverMeta").textContent = `${driverUser.ambulanceId} · ${driverUser.ambulanceReg}`;
    if ($("drvHeaderTitle")) $("drvHeaderTitle").textContent = `Ambulance Console — ${driverUser.ambulanceId}`;
    if ($("drvProfileSummary")) {
      $("drvProfileSummary").textContent = `Operator: ${driverUser.driverName} · Reg: ${driverUser.ambulanceReg} · ID: ${driverUser.ambulanceId}`;
    }

    initMap();
    await connectAblyDriver();

    // Emergency Mode ON/OFF Toggle
    $("toggleEmergencyModeBtn")?.addEventListener("click", () => {
      emergencyMode = !emergencyMode;
      if (emergencyMode) {
        requestAndWatchGps();
        SA.playAlertSiren();
        SA.showToast("Emergency Mode ON. Acquiring live GPS & preparing Ably channel.");
      } else {
        if (journeyActive) {
          stopActiveJourney();
        }
        SA.showToast("Emergency Mode turned OFF.");
      }
      updateButtonStates();
    });

    // GPS Button
    $("enableGpsBtn")?.addEventListener("click", () => {
      requestAndWatchGps();
    });

    // Hospital Search Buttons
    $("findNearbyHospitalsBtn")?.addEventListener("click", async () => {
      const list = $("hospitalResultsList");
      if (list) list.innerHTML = `<p style="font-size:13px;color:var(--token-text-muted);">Searching OpenStreetMap hospitals within 15 km…</p>`;
      try {
        const items = await searchMappedHospitals("");
        renderHospitalList(items);
      } catch (err) {
        if (list) list.innerHTML = `<p style="font-size:13px;color:var(--token-red-primary);">${err.message}</p>`;
      }
    });

    $("searchHospitalByNameBtn")?.addEventListener("click", async () => {
      const q = $("hospitalNameInput")?.value.trim();
      if (!q) {
        SA.showToast("Enter a hospital name to search.");
        return;
      }
      const list = $("hospitalResultsList");
      if (list) list.innerHTML = `<p style="font-size:13px;color:var(--token-text-muted);">Searching for "${q}"…</p>`;
      try {
        const items = await searchMappedHospitals(q);
        renderHospitalList(items);
      } catch (err) {
        if (list) list.innerHTML = `<p style="font-size:13px;color:var(--token-red-primary);">${err.message}</p>`;
      }
    });

    // Route Alternative Selector
    $("drvRouteSelect")?.addEventListener("change", (e) => {
      const idx = Number(e.target.value);
      if (routeChoices[idx]) {
        activeRoute = routeChoices[idx];
        renderActiveRouteOnMap();
        if (journeyActive) {
          publishTelemetry("route-updated");
        }
      }
    });

    // Start Emergency Journey
    $("startJourneyBtn")?.addEventListener("click", async () => {
      if (!emergencyMode || !currentGps || !selectedHospital || !activeRoute) {
        SA.showToast("Ensure Emergency Mode is ON, GPS is locked, and a hospital route is selected.");
        return;
      }
      journeyActive = true;
      currentJourneyId = `JRN-${driverUser.ambulanceId}-${Date.now()}`;
      updateButtonStates();

      await publishTelemetry("journey-started");
      const intervalMs = (window.APP_CONFIG && window.APP_CONFIG.PUBLISH_INTERVAL_MS) || 4000;
      clearInterval(publishIntervalId);
      publishIntervalId = setInterval(() => {
        if (journeyActive && currentGps) {
          publishTelemetry("location-update");
        }
      }, intervalMs);

      SA.playAlertSiren();
      SA.showToast(`Journey ${currentJourneyId} started! Publishing live telemetry via Ably.`);
    });

    // End Emergency Journey
    async function stopActiveJourney() {
      journeyActive = false;
      clearInterval(publishIntervalId);
      publishIntervalId = null;
      await publishTelemetry("journey-ended");
      currentJourneyId = null;
      updateButtonStates();
      SA.showToast("Emergency journey ended. Stopped Ably location publishing.");
    }

    $("endJourneyBtn")?.addEventListener("click", () => {
      stopActiveJourney();
    });

    // Logout
    $("driverLogoutBtn")?.addEventListener("click", () => {
      if (journeyActive) stopActiveJourney();
      SA.clearSession();
      window.location.href = "index.html";
    });

    updateButtonStates();
  });
})();
