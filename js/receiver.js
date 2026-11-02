/**
 * Smart Ambulance Alert and Traffic Clearance System
 * Receiver Dashboard — Ably Subscription, Real GPS Proximity Calculation & Notification Centre
 */

(function () {
  const $ = id => document.getElementById(id);
  const SA = window.SmartAmbulance;

  let receiverUser = null;
  let map = null;
  let receiverMarker = null;
  let ambulanceMarkers = new Map();
  let activeAmbulances = new Map();

  let receiverGps = null;
  let gpsWatchId = null;
  let gpsPermissionDenied = false;

  // Preferences & Notification History (stored per receiverId in localStorage)
  let preferences = {
    corridorMeters: 300,
    soundEnabled: true,
    browserNotifyEnabled: true
  };
  let notificationHistory = [];
  let deduplicationMap = new Map(); // key: `${journeyId}:${bucket}` -> timestamp

  function loadReceiverStorage() {
    if (!receiverUser) return;
    try {
      const rawPrefs = localStorage.getItem(`saa_prefs_${receiverUser.receiverId}`);
      if (rawPrefs) preferences = { ...preferences, ...JSON.parse(rawPrefs) };
      const rawHist = localStorage.getItem(`saa_hist_${receiverUser.receiverId}`);
      if (rawHist) notificationHistory = JSON.parse(rawHist);
    } catch (e) {}

    if ($("prefCorridorSelect")) $("prefCorridorSelect").value = String(preferences.corridorMeters);
    if ($("prefSoundToggle")) $("prefSoundToggle").checked = Boolean(preferences.soundEnabled);
    if ($("prefBrowserToggle")) $("prefBrowserToggle").checked = Boolean(preferences.browserNotifyEnabled);
    renderNotificationHistory();
  }

  function savePreferences() {
    if (!receiverUser) return;
    try {
      localStorage.setItem(`saa_prefs_${receiverUser.receiverId}`, JSON.stringify(preferences));
    } catch (e) {}
  }

  function saveNotificationHistory() {
    if (!receiverUser) return;
    try {
      localStorage.setItem(`saa_hist_${receiverUser.receiverId}`, JSON.stringify(notificationHistory.slice(0, 100)));
    } catch (e) {}
  }

  // Initialize MapLibre GL Map
  function initMap() {
    const center = (window.APP_CONFIG && window.APP_CONFIG.DEFAULT_CENTER) || [80.1462, 13.0382];
    map = new maplibregl.Map({
      container: "receiverMap",
      style: (window.APP_CONFIG && window.APP_CONFIG.MAP_STYLE) || "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center,
      zoom: 12
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      map.addSource("active-route", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });
      map.addLayer({
        id: "active-route-line",
        type: "line",
        source: "active-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ec0016",
          "line-width": 6,
          "line-opacity": 0.9
        }
      });
    });
  }

  function createDotElement(color, label) {
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
      font-size: 11px;
      font-family: Inter, sans-serif;
    `;
    el.textContent = label;
    return el;
  }

  // Request & Watch Real Receiver GPS
  function startReceiverGps() {
    const gpsWarningBox = $("gpsPermissionExplanation");
    if (!navigator.geolocation) {
      if ($("rcvGpsStatus")) $("rcvGpsStatus").textContent = "Unsupported";
      if (gpsWarningBox) {
        gpsWarningBox.style.display = "block";
        gpsWarningBox.innerHTML = `<strong>Geolocation Unsupported:</strong> Your browser does not support GPS positioning, so personalised route-proximity alerts cannot be calculated.`;
      }
      return;
    }

    if ($("rcvGpsStatus")) $("rcvGpsStatus").textContent = "Acquiring GPS…";

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        gpsPermissionDenied = false;
        if (gpsWarningBox) gpsWarningBox.style.display = "none";
        onReceiverGpsUpdate(pos);
        if (map && receiverGps) {
          map.flyTo({ center: [receiverGps.lng, receiverGps.lat], zoom: 14 });
        }
      },
      (err) => {
        gpsPermissionDenied = true;
        if ($("rcvGpsStatus")) {
          $("rcvGpsStatus").textContent = "Permission Denied";
          $("rcvGpsStatus").style.color = "var(--token-red-primary)";
        }
        if (gpsWarningBox) {
          gpsWarningBox.style.display = "block";
          gpsWarningBox.innerHTML = `
            <strong>Location Permission Required for Personalised Proximity Alerts:</strong>
            You have denied or blocked GPS location access (${err.message}). Because the Smart Ambulance Alert System calculates real-time distance between your exact coordinates and the ambulance's active route corridor, personalised approaching alerts are unavailable until location permission is granted.
          `;
        }
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );

    if (gpsWatchId === null) {
      gpsWatchId = navigator.geolocation.watchPosition(
        onReceiverGpsUpdate,
        () => {},
        { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 }
      );
    }
  }

  function onReceiverGpsUpdate(pos) {
    receiverGps = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: Math.round(pos.coords.accuracy || 0),
      timestamp: Date.now()
    };

    if ($("rcvGpsStatus")) {
      $("rcvGpsStatus").textContent = `Active (${receiverGps.lat.toFixed(4)}, ${receiverGps.lng.toFixed(4)})`;
      $("rcvGpsStatus").style.color = "var(--token-green-online)";
    }

    if (map) {
      if (!receiverMarker) {
        receiverMarker = new maplibregl.Marker({ element: createDotElement("#0077ff", "YOU") })
          .setLngLat([receiverGps.lng, receiverGps.lat])
          .addTo(map);
      } else {
        receiverMarker.setLngLat([receiverGps.lng, receiverGps.lat]);
      }
    }

    // Re-evaluate proximity against all active ambulances
    for (const ambData of activeAmbulances.values()) {
      evaluateIncomingTelemetry(ambData, false);
    }
  }

  // Subscribe to Ably Channels ('ambulance') using short-lived Receiver Token
  async function connectAblyReceiver() {
    const connBadge = $("rcvAblyStatus");
    const headerDot = $("headerStatusDot");
    const headerText = $("headerStatusText");

    try {
      if (connBadge) connBadge.textContent = "Authenticating…";
      const client = await SA.connectAbly((state, reason) => {
        if (state === "connected") {
          if (connBadge) {
            connBadge.textContent = "Connected (Subscribed)";
            connBadge.style.color = "var(--token-green-online)";
          }
          if (headerDot) headerDot.className = "template-status-dot";
          if (headerText) headerText.textContent = `Ably Live · ${receiverUser.receiverId}`;
        } else if (state === "disconnected" || state === "suspended") {
          if (connBadge) {
            connBadge.textContent = "Reconnecting…";
            connBadge.style.color = "var(--token-amber-warn)";
          }
          if (headerDot) headerDot.className = "template-status-dot offline";
        } else if (state === "failed") {
          const msg = (reason && reason.message) || "Ably connection failed";
          if (connBadge) {
            connBadge.textContent = msg.includes("ABLY_KEY_MISSING")
              ? "Configure ABLY_API_KEY"
              : "Connection Failed";
            connBadge.style.color = "var(--token-red-primary)";
          }
        }
      });

      const channel = client.channels.get("ambulance");
      channel.subscribe("ambulance-telemetry", (message) => {
        if (message && message.data) {
          handleAmbulanceTelemetry(message.data);
        }
      });
    } catch (err) {
      if (connBadge) {
        connBadge.textContent = "Token Auth Error";
        connBadge.style.color = "var(--token-red-primary)";
      }
    }
  }

  // Handle Live Telemetry Message from Ably
  function handleAmbulanceTelemetry(data) {
    if (!data || !data.ambulanceId) return;

    if (data.eventType === "journey-ended" || !data.activeJourney) {
      activeAmbulances.delete(data.ambulanceId);
      const m = ambulanceMarkers.get(data.ambulanceId);
      if (m) {
        m.remove();
        ambulanceMarkers.delete(data.ambulanceId);
      }
      refreshActiveJourneyDisplay();
      return;
    }

    activeAmbulances.set(data.ambulanceId, data);
    evaluateIncomingTelemetry(data, true);
  }

  function evaluateIncomingTelemetry(data, isNewPacket) {
    if (!data.latitude || !data.longitude) return;
    const ambPos = { lat: Number(data.latitude), lng: Number(data.longitude) };

    // Update ambulance marker on map
    if (map) {
      let marker = ambulanceMarkers.get(data.ambulanceId);
      if (!marker) {
        marker = new maplibregl.Marker({ element: createDotElement("#ec0016", "AMB") })
          .setLngLat([ambPos.lng, ambPos.lat])
          .addTo(map);
        ambulanceMarkers.set(data.ambulanceId, marker);
      } else {
        marker.setLngLat([ambPos.lng, ambPos.lat]);
      }

      // Draw active route polyline
      if (Array.isArray(data.route) && data.route.length >= 2 && map.getSource("active-route")) {
        map.getSource("active-route").setData({
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: data.route.map(pt => [pt.lng, pt.lat])
          },
          properties: {}
        });
      }
    }

    if ($("rcvActiveAmbCount")) {
      $("rcvActiveAmbCount").textContent = `${activeAmbulances.size} Active (${data.ambulanceId})`;
    }
    if ($("rcvAmbEta")) {
      $("rcvAmbEta").textContent = data.durationSeconds ? SA.formatDuration(data.durationSeconds) : "Live";
    }

    // Calculate Route-Based Proximity if Receiver GPS is available
    if (!receiverGps) return;

    const prox = SA.evaluateRouteProximity(
      receiverGps,
      ambPos,
      data.route || [],
      Number(preferences.corridorMeters || 300)
    );

    if ($("rcvProximityDist")) {
      $("rcvProximityDist").textContent = `${SA.formatDistance(prox.distanceToRouteMeters)} to route`;
    }

    const alertBanner = $("approachingAlertBanner");
    if (prox.eligible) {
      if (alertBanner) {
        alertBanner.classList.add("visible");
        const metaEl = $("approachingAlertMeta");
        if (metaEl) {
          metaEl.textContent = `Ambulance ${data.ambulanceId} (${data.ambulanceReg || "Emergency"}) · ${prox.distanceToRouteMeters}m from your route corridor · Destination: ${(data.destination && data.destination.name) || "Hospital"}`;
        }
      }

      // Duplicate Alert Prevention per Journey + 250m Progress Bucket
      const dedupeKey = `${data.journeyId || data.ambulanceId}:${prox.bucket}`;
      const lastTriggered = deduplicationMap.get(dedupeKey) || 0;
      if (isNewPacket && Date.now() - lastTriggered > 45000) {
        deduplicationMap.set(dedupeKey, Date.now());
        triggerApproachingAlert(data, prox);
      }
    } else {
      if (alertBanner && activeAmbulances.size <= 1) {
        alertBanner.classList.remove("visible");
      }
    }
  }

  function refreshActiveJourneyDisplay() {
    if (activeAmbulances.size === 0) {
      if ($("rcvActiveAmbCount")) $("rcvActiveAmbCount").textContent = "None Active";
      if ($("rcvAmbEta")) $("rcvAmbEta").textContent = "—";
      if ($("rcvProximityDist")) $("rcvProximityDist").textContent = "Standby";
      if ($("approachingAlertBanner")) $("approachingAlertBanner").classList.remove("visible");
      if (map && map.getSource("active-route")) {
        map.getSource("active-route").setData({ type: "FeatureCollection", features: [] });
      }
    }
  }

  // Trigger In-Website Alert, Notification History Item, Siren, and Browser Notification
  function triggerApproachingAlert(data, prox) {
    const title = "AMBULANCE APPROACHING";
    const body = "An emergency ambulance is approaching your area. Please remain alert and give way safely when appropriate.";

    const newEntry = {
      id: "NTF-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      title,
      body,
      ambulanceId: data.ambulanceId,
      journeyId: data.journeyId || "ACTIVE",
      distanceMeters: prox.distanceToRouteMeters,
      timestamp: new Date().toISOString(),
      read: false
    };

    notificationHistory.unshift(newEntry);
    saveNotificationHistory();
    renderNotificationHistory();

    if (preferences.soundEnabled) {
      SA.playAlertSiren();
    }
    if (preferences.browserNotifyEnabled) {
      SA.triggerBrowserNotification(title, body, `amb-${data.journeyId || data.ambulanceId}`);
    }
    SA.showToast(`${title}: ${body}`, 8000);
  }

  // Render Notification Centre History (Read/Unread, Timestamps, Clear)
  function renderNotificationHistory() {
    const container = $("notificationHistoryList");
    const unreadBadge = $("unreadCountBadge");
    if (!container) return;

    const unreadCount = notificationHistory.filter(n => !n.read).length;
    if (unreadBadge) {
      unreadBadge.textContent = `${unreadCount} Unread`;
      unreadBadge.style.color = unreadCount > 0 ? "var(--token-red-primary)" : "var(--token-text-muted)";
    }

    if (!notificationHistory.length) {
      container.innerHTML = `<p style="font-size:13px;color:var(--token-text-muted);margin:0;">No proximity alerts recorded yet. Keep location sharing enabled while connected.</p>`;
      return;
    }

    container.innerHTML = "";
    notificationHistory.forEach((item) => {
      const card = document.createElement("div");
      card.className = `notification-card-item ${item.read ? "" : "unread"}`;
      const timeStr = new Date(item.timestamp).toLocaleString();
      card.innerHTML = `
        <div style="flex:1;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <b style="font-size:13.5px;color:var(--token-red-primary);">${item.title}</b>
            <span style="font-size:11px;color:var(--token-text-muted);">${timeStr}</span>
          </div>
          <p style="font-size:13px;color:var(--token-navy-heading);margin:0 0 4px 0;">${item.body}</p>
          <small style="font-size:11.5px;color:var(--token-text-muted);">Ambulance: ${item.ambulanceId} · Corridor Distance: ${item.distanceMeters}m</small>
        </div>
      `;
      const toggleBtn = document.createElement("button");
      toggleBtn.className = "btn-template-outline";
      toggleBtn.style.height = "32px";
      toggleBtn.style.padding = "0 10px";
      toggleBtn.style.fontSize = "11.5px";
      toggleBtn.textContent = item.read ? "Mark Unread" : "Mark Read";
      toggleBtn.addEventListener("click", () => {
        item.read = !item.read;
        saveNotificationHistory();
        renderNotificationHistory();
      });
      card.appendChild(toggleBtn);
      container.appendChild(card);
    });
  }

  // Initialize Receiver Dashboard
  document.addEventListener("DOMContentLoaded", async () => {
    const verified = await SA.verifyAuthenticatedRole("receiver");
    if (!verified) {
      window.location.href = "index.html";
      return;
    }
    receiverUser = verified;

    // Populate UI with Receiver Profile
    if ($("sidebarReceiverName")) $("sidebarReceiverName").textContent = receiverUser.fullName;
    if ($("sidebarReceiverEmail")) $("sidebarReceiverEmail").textContent = receiverUser.email;
    if ($("profileFullNameInput")) $("profileFullNameInput").value = receiverUser.fullName;
    if ($("profileEmailInput")) $("profileEmailInput").value = receiverUser.email;
    if ($("profilePhoneInput")) $("profilePhoneInput").value = receiverUser.phone || "";

    loadReceiverStorage();
    initMap();
    startReceiverGps();
    await connectAblyReceiver();

    // GPS & Browser Notification Permission Button
    $("enableReceiverAlertsBtn")?.addEventListener("click", async () => {
      startReceiverGps();
      if ("Notification" in window) {
        try {
          const perm = await Notification.requestPermission();
          if (perm === "granted") {
            SA.showToast("Browser notifications permitted and active.");
          } else {
            SA.showToast("Browser notifications blocked; in-website alerts remain active.");
          }
        } catch (e) {}
      }
    });

    // Preferences Listeners
    $("prefCorridorSelect")?.addEventListener("change", (e) => {
      preferences.corridorMeters = Number(e.target.value) || 300;
      savePreferences();
      SA.showToast(`Proximity alert distance updated to ${preferences.corridorMeters} metres.`);
    });

    $("prefSoundToggle")?.addEventListener("change", (e) => {
      preferences.soundEnabled = e.target.checked;
      savePreferences();
    });

    $("prefBrowserToggle")?.addEventListener("change", (e) => {
      preferences.browserNotifyEnabled = e.target.checked;
      savePreferences();
    });

    // Notification Centre Actions
    $("markAllReadBtn")?.addEventListener("click", () => {
      notificationHistory.forEach(n => (n.read = true));
      saveNotificationHistory();
      renderNotificationHistory();
    });

    $("clearNotificationsBtn")?.addEventListener("click", () => {
      notificationHistory = [];
      saveNotificationHistory();
      renderNotificationHistory();
      SA.showToast("Notification history cleared.");
    });

    // Profile Editing Submit
    $("receiverProfileForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fullName = $("profileFullNameInput")?.value.trim();
      const phone = $("profilePhoneInput")?.value.trim();
      const verifiedAccountToken = SA.getVerifiedAccountCert(receiverUser.email);

      try {
        const res = await SA.callApi("update-receiver-profile", {
          fullName,
          phone,
          verifiedAccountToken
        }, "POST");

        SA.saveVerifiedAccountCert(res.user.email, res.verifiedAccountToken);
        SA.setSession(res.sessionToken, res.user);
        receiverUser = res.user;
        if ($("sidebarReceiverName")) $("sidebarReceiverName").textContent = receiverUser.fullName;
        SA.showToast("Receiver profile updated.");
      } catch (err) {
        SA.showToast(err.message || "Could not update profile.");
      }
    });

    // Logout
    $("receiverLogoutBtn")?.addEventListener("click", () => {
      if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
      SA.clearSession();
      window.location.href = "index.html";
    });
  });
})();
