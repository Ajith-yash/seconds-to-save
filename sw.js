/**
 * Smart Ambulance Alert and Traffic Clearance System
 * Service Worker for Browser Notifications & Web Push Support
 */

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Listen for messages from active client pages to display system-level notifications
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SHOW_NOTIFICATION") {
    const title = data.title || "AMBULANCE APPROACHING";
    const options = {
      body: data.body || "An emergency ambulance is approaching your area. Please remain alert and give way safely when appropriate.",
      tag: data.tag || "ambulance-proximity-alert",
      renotify: true,
      requireInteraction: true,
      data: { url: data.url || "/receiver.html" }
    };
    event.waitUntil(self.registration.showNotification(title, options));
  }
});

// Handle incoming Web Push events when configured with a push server
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: "AMBULANCE APPROACHING", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "AMBULANCE APPROACHING";
  const options = {
    body: payload.body || "An emergency ambulance is approaching your area. Please remain alert and give way safely when appropriate.",
    tag: payload.tag || "ambulance-push-alert",
    requireInteraction: true,
    data: { url: payload.url || "/receiver.html" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/receiver.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
