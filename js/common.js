/**
 * Smart Ambulance Alert and Traffic Clearance System
 * Shared Authentication, Ably Token Client, Notification Centre & Geodesy Utilities
 */

window.SmartAmbulance = {
  ablyClient: null,
  audioCtx: null,
  swRegistration: null,

  // Resolve Serverless API Endpoint automatically across Netlify, Vercel, or Custom URL
  async callApi(action, payload = {}, method = "POST") {
    const sessionToken = this.getSessionToken();
    const headers = { "Content-Type": "application/json" };
    if (sessionToken) {
      headers["Authorization"] = `Bearer ${sessionToken}`;
    }

    const configuredBase = (window.APP_CONFIG && window.APP_CONFIG.SERVERLESS_API_URL) || "";
    const candidates = configuredBase
      ? [`${configuredBase.replace(/\/$/, "")}?action=${encodeURIComponent(action)}`]
      : [
          `/.netlify/functions/api?action=${encodeURIComponent(action)}`,
          `/api?action=${encodeURIComponent(action)}`
        ];

    let lastError = null;
    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: method === "POST" ? JSON.stringify({ action, ...payload }) : undefined
        });
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          continue;
        }
        const data = await res.json();
        if (!res.ok) {
          const err = new Error(data.error || `Request failed (${res.status})`);
          err.status = res.status;
          err.code = data.code;
          throw err;
        }
        // Cache working endpoint prefix
        this._workingEndpoint = url.split("?")[0];
        return data;
      } catch (err) {
        lastError = err;
        if (err.status && err.status !== 404) {
          throw err;
        }
      }
    }
    throw lastError || new Error("Unable to reach the managed serverless authentication endpoint.");
  },

  // Session Management (Cryptographically signed token stored in sessionStorage; never plain passwords)
  setSession(sessionToken, userObj) {
    try {
      sessionStorage.setItem("saa_session_token", sessionToken);
      sessionStorage.setItem("saa_session_user", JSON.stringify(userObj));
    } catch (e) {}
  },

  getSessionToken() {
    try {
      return sessionStorage.getItem("saa_session_token") || "";
    } catch (e) {
      return "";
    }
  },

  getCurrentUser() {
    try {
      const raw = sessionStorage.getItem("saa_session_user");
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  clearSession() {
    try {
      sessionStorage.removeItem("saa_session_token");
      sessionStorage.removeItem("saa_session_user");
    } catch (e) {}
    if (this.ablyClient) {
      try {
        this.ablyClient.close();
      } catch (e) {}
      this.ablyClient = null;
    }
  },

  // Verify session with serverless endpoint to prevent any localStorage/sessionStorage tampering
  async verifyAuthenticatedRole(expectedRole) {
    const token = this.getSessionToken();
    if (!token) return null;
    try {
      const res = await this.callApi("verify-session", {}, "POST");
      if (!res || !res.ok || !res.user || res.user.role !== expectedRole) {
        return null;
      }
      this.setSession(token, res.user);
      return res.user;
    } catch (e) {
      return null;
    }
  },

  // Store server-signed encrypted Receiver Account Certificate (contains HMAC hash, never password)
  saveVerifiedAccountCert(email, certToken) {
    try {
      const key = "saa_acct_cert_" + String(email).trim().toLowerCase();
      localStorage.setItem(key, certToken);
    } catch (e) {}
  },

  getVerifiedAccountCert(email) {
    try {
      const key = "saa_acct_cert_" + String(email).trim().toLowerCase();
      return localStorage.getItem(key) || "";
    } catch (e) {
      return "";
    }
  },

  // Remember non-sensitive email preference locally
  setRememberedEmail(role, email) {
    try {
      if (email) {
        localStorage.setItem(`saa_remember_email_${role}`, String(email).trim());
      } else {
        localStorage.removeItem(`saa_remember_email_${role}`);
      }
    } catch (e) {}
  },

  getRememberedEmail(role) {
    try {
      return localStorage.getItem(`saa_remember_email_${role}`) || "";
    } catch (e) {
      return "";
    }
  },

  // Connect to Ably Realtime using authCallback to fetch short-lived role-scoped tokens
  async connectAbly(onStateChange) {
    if (typeof Ably === "undefined") {
      throw new Error("Ably Realtime SDK not loaded.");
    }
    if (this.ablyClient) {
      return this.ablyClient;
    }

    const self = this;
    const client = new Ably.Realtime({
      authCallback: async (tokenParams, callback) => {
        try {
          const tokenData = await self.callApi("ably-token", { tokenParams }, "POST");
          callback(null, tokenData);
        } catch (err) {
          callback(err, null);
        }
      },
      echoMessages: false,
      autoConnect: true
    });

    client.connection.on((stateChange) => {
      if (typeof onStateChange === "function") {
        onStateChange(stateChange.current, stateChange.reason);
      }
    });

    this.ablyClient = client;
    return client;
  },

  // Register Service Worker for Browser Notifications
  async registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      try {
        this.swRegistration = await navigator.serviceWorker.register("sw.js");
      } catch (e) {
        console.warn("Service worker registration skipped:", e.message);
      }
    }
  },

  // Trigger Browser & Service Worker Notification
  async triggerBrowserNotification(title, body, tag = "ambulance-approaching") {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return false;
    }
    try {
      if (this.swRegistration && this.swRegistration.active) {
        this.swRegistration.active.postMessage({
          type: "SHOW_NOTIFICATION",
          title,
          body,
          tag,
          url: "receiver.html"
        });
        return true;
      }
      new Notification(title, { body, tag });
      return true;
    } catch (e) {
      return false;
    }
  },

  // Synthesize Emergency Two-Tone Alert Siren via Web Audio API
  playAlertSiren() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!this.audioCtx) this.audioCtx = new AudioCtx();
      if (this.audioCtx.state === "suspended") this.audioCtx.resume();

      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(660, now + 0.25);
      osc.frequency.setValueAtTime(880, now + 0.5);
      osc.frequency.setValueAtTime(660, now + 0.75);

      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.15);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start(now);
      osc.stop(now + 1.15);
    } catch (e) {}
  },

  // Toast UI Helper
  showToast(message, durationMs = 5500) {
    let toast = document.getElementById("templateToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "templateToast";
      toast.className = "template-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove("show");
    }, durationMs);
  },

  // Geodesy & Route Corridor Proximity Math (Preserved from Working Website)
  haversineMeters(a, b) {
    const R = 6371000;
    const rad = x => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
  },

  segmentDistanceMeters(p, a, b) {
    const sx = 111320 * Math.cos((p.lat * Math.PI) / 180);
    const sy = 110540;
    const px = p.lng * sx;
    const py = p.lat * sy;
    const ax = a.lng * sx;
    const ay = a.lat * sy;
    const bx = b.lng * sx;
    const by = b.lat * sy;
    const dx = bx - ax;
    const dy = by - ay;
    const den = dx * dx + dy * dy;
    const t = den ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / den)) : 0;
    return {
      distance: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)),
      t
    };
  },

  progressAlongRoute(p, routePoints) {
    if (!Array.isArray(routePoints) || routePoints.length < 2) {
      return { along: 0, total: 0, minDistance: Infinity };
    }
    let travelled = 0;
    let bestDist = Infinity;
    let bestAlong = 0;

    for (let i = 0; i < routePoints.length - 1; i++) {
      const a = routePoints[i];
      const b = routePoints[i + 1];
      const segLen = this.haversineMeters(a, b);
      const seg = this.segmentDistanceMeters(p, a, b);
      if (seg.distance < bestDist) {
        bestDist = seg.distance;
        bestAlong = travelled + segLen * seg.t;
      }
      travelled += segLen;
    }
    return { along: bestAlong, total: travelled, minDistance: bestDist };
  },

  // Evaluate whether a receiver position meets route-based proximity criteria
  evaluateRouteProximity(receiverPos, ambulancePos, routePoints, thresholdMeters = 300) {
    if (!receiverPos || !ambulancePos) {
      return { eligible: false, reason: "Missing coordinates" };
    }
    // If active route polyline is available, evaluate corridor distance and forward progress
    if (Array.isArray(routePoints) && routePoints.length >= 2) {
      const ambProg = this.progressAlongRoute(ambulancePos, routePoints);
      const rcvProg = this.progressAlongRoute(receiverPos, routePoints);
      const distToRoute = rcvProg.minDistance;
      const aheadMeters = rcvProg.along - ambProg.along;
      const directDist = this.haversineMeters(receiverPos, ambulancePos);

      // Eligible if receiver is within thresholdMeters of route AND not more than 50m behind ambulance AND within 5km ahead
      const withinCorridor = distToRoute <= thresholdMeters;
      const isAheadOnRoute = aheadMeters >= -50 && aheadMeters <= 5000;
      const bucket = Math.floor(ambProg.along / 250);

      return {
        eligible: withinCorridor && isAheadOnRoute,
        distanceToRouteMeters: Math.round(distToRoute),
        directDistanceMeters: Math.round(directDist),
        aheadMeters: Math.round(aheadMeters),
        bucket
      };
    }

    // Fallback if ambulance is in Emergency Mode before route polyline is locked: direct radial check
    const directDist = this.haversineMeters(receiverPos, ambulancePos);
    return {
      eligible: directDist <= thresholdMeters,
      distanceToRouteMeters: Math.round(directDist),
      directDistanceMeters: Math.round(directDist),
      aheadMeters: 0,
      bucket: 0
    };
  },

  formatDistance(m) {
    if (m === null || m === undefined || !Number.isFinite(Number(m))) return "—";
    const num = Number(m);
    return num >= 1000 ? (num / 1000).toFixed(1) + " km" : Math.round(num) + " m";
  },

  formatDuration(s) {
    if (s === null || s === undefined || !Number.isFinite(Number(s))) return "—";
    const mins = Math.max(1, Math.round(Number(s) / 60));
    return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  }
};

// Setup Footer Modals & Password Toggles on DOMContentLoaded
document.addEventListener("DOMContentLoaded", () => {
  window.SmartAmbulance.registerServiceWorker();

  // Modal Triggers
  document.querySelectorAll("[data-modal-target]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const targetId = btn.getAttribute("data-modal-target");
      const modal = document.getElementById(targetId);
      if (modal) modal.classList.add("open");
    });
  });

  document.querySelectorAll("[data-modal-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = btn.closest(".template-modal-backdrop");
      if (modal) modal.classList.remove("open");
    });
  });

  document.querySelectorAll(".template-modal-backdrop").forEach((modal) => {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.remove("open");
    });
  });

  // Password Show/Hide Toggles
  document.querySelectorAll(".pw-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-target");
      const input = targetId ? document.getElementById(targetId) : btn.parentElement.querySelector("input");
      if (!input) return;
      const isPass = input.type === "password";
      input.type = isPass ? "text" : "password";
      btn.setAttribute("aria-pressed", String(isPass));
    });
  });
});
