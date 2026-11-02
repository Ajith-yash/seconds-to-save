# Smart Ambulance Alert and Traffic Clearance System
> **"Clear the Way. Save a Life."**  
> *Real-time alerts. Faster response. A safer tomorrow.*

---

## Project Attribution
- **Project:** Smart Ambulance Alert and Traffic Clearance System
- **Tagline:** Clear the Way. Save a Life.
- **Developed by:** Ajith
- **Team Members:** Ajith Noah and Kavin Joel
- **School:** Sri Chaitanya Techno School, Iyyappanthangal

---

## 1. Architecture Overview

This production web application integrates the **Original Template Website's exact visual design** (`#F5F7FA` light slate background, `#FFFFFF` / `#F3F5F7` cards, `#EC0016` emergency red accents, `#182334` dark navy typography, red gradient corner blobs, ambulance photography banner, and 230px sidebar layout) with the **Original Working Website's real-time GPS, MapLibre GL mapping, Overpass/Photon hospital search, and OSRM routing**, upgraded to **Ably Realtime** and a **Managed Serverless Token Endpoint**.

### Technology Stack
- **Frontend:** HTML5, CSS3 (`css/ambulance-dashboard.css` + `css/app.css`), Vanilla JavaScript (`js/config.js`, `js/common.js`, `js/auth.js`, `js/driver.js`, `js/receiver.js`)
- **Realtime Messaging:** [Ably Realtime JavaScript SDK v2](https://ably.com/) (`https://cdn.ably.com/lib/ably.min-2.js`)
- **Managed Serverless Backend:** Stateless Node.js Serverless Functions (`netlify/functions/api.js` for Netlify Functions and `api/index.js` for Vercel Serverless) using native Node `crypto` and `https` modules—no permanently running custom server or database required.
- **Maps & Routing:** [MapLibre GL JS](https://maplibre.org/) with [Carto Basemaps](https://carto.com/), [Project OSRM](https://project-osrm.org/) driving route calculation & automatic off-route recalculation, and [Overpass API](https://overpass-api.de/) / [Photon](https://photon.komoot.io/) hospital discovery.
- **Browser APIs:** HTML5 Geolocation API, Notifications API, Service Workers (`sw.js`), Web Audio API, and `localStorage` (strictly for non-sensitive preferences).

---

## 2. Ably Application & Security Configuration

### Ably Setup
1. Log in to your [Ably Dashboard](https://ably.com/) and open your application:
   - **Application Name:** `Smart-Ambulance-Alert`
   - **API Key Nickname:** `Ambulance-Realtime`
2. Verify the key capabilities match your specification:
   - **Messages:** Publish (`Enabled`), Subscribe (`Enabled`), History (`Enabled`), Channel Metadata (`Disabled`)
   - **Updates, deletes and appends:** All `Disabled`
   - **Presence:** `Enabled`
   - **LiveObjects / Push / Statistics / Privileged Headers:** `Disabled`
3. Copy the full private API key (`appId.keyId:keySecret`) and store it **exclusively** in your serverless environment variable `ABLY_API_KEY`. **Never** place the private key in any frontend file.

### Role-Scoped Ably Token Capabilities
The serverless endpoint (`?action=ably-token`) verifies the caller's HMAC-SHA256 signed session token before generating a short-lived (45-minute TTL) Ably token or signed `TokenRequest`:
- **Ambulance Driver (`role === "driver"`):**
  - `ambulance`: `["publish", "subscribe", "presence", "history"]`
  - `ambulance:{ambulanceId}`: `["publish", "subscribe", "presence", "history"]`
- **Receiver (`role === "receiver"`):**
  - `ambulance`: `["subscribe", "presence", "history"]`
  - `ambulance:*`: `["subscribe", "history"]`
  - `receiver:{receiverId}`: `["publish", "subscribe", "presence", "history"]`
  *(Receivers are cryptographically prevented from publishing to any ambulance channel.)*

---

## 3. User Roles & Pre-Configured Driver Accounts

### A. Receiver Accounts (`index.html` -> `receiver.html`)
- **Registration:** Full Name, Email Address, Phone Number, and Password.
- **Email Verification:** Generates a 6-digit HMAC verification code to verify the receiver's email before activating the account.
- **Security:** Passwords are never stored in `localStorage`. Only a server-signed HMAC account certificate and non-sensitive preferences (remembered email, alert distance threshold, and notification history) are stored locally.

### B. Authorised Ambulance Driver Accounts (`index.html` -> `driver.html`)
A receiver cannot become a driver by modifying browser storage; every driver session is cryptographically signed by the serverless endpoint and verified before issuing publish-capable Ably tokens.

Pre-authorised fleet operator accounts included for immediate testing:
| Driver Email | Password | Driver Name | Registration No | Ambulance ID |
| :--- | :--- | :--- | :--- | :--- |
| `ajith@ambulance.org` | `ClearTheWay@108` | Ajith (Lead Operator) | `TN-10-SC-0108` | `AMB-0108` |
| `driver1@ambulance.org` | `Driver@108` | Rajesh Kumar | `TN-01-AM-1081` | `AMB-1081` |
| `driver2@ambulance.org` | `Driver@108` | Suresh Babu | `TN-09-EM-2045` | `AMB-2045` |

*(Additional custom drivers can also authenticate by providing the server-side `DRIVER_ACCESS_CODE`, default `SCTS-AMB-2026`.)*

---

## 4. Deployment Instructions

### Option A: Deploy Everything on Netlify (Frontend + Managed Serverless Functions)
1. Push this project folder to a GitHub repository.
2. In the [Netlify Dashboard](https://app.netlify.com/), click **Add new site > Import an existing project** and select your repository.
3. Netlify automatically detects `netlify.toml`:
   - **Publish directory:** `.`
   - **Functions directory:** `netlify/functions`
4. Go to **Site configuration > Environment variables** and add:
   - `ABLY_API_KEY` = `your_ably_api_key_here`
   - `SESSION_SECRET` = `a_long_random_secret_string`
   - `DRIVER_ACCESS_CODE` = `SCTS-AMB-2026`
5. Trigger a redeploy. Your entire frontend and serverless token endpoint will be live over HTTPS.

### Option B: Frontend on GitHub Pages + Serverless Endpoint on Netlify or Vercel
1. Deploy the repository to Netlify or Vercel first and set the `ABLY_API_KEY` and `SESSION_SECRET` environment variables.
2. Copy your deployed serverless URL (e.g., `https://your-site.netlify.app/.netlify/functions/api` or `https://your-site.vercel.app/api`).
3. Open `js/config.js` and set:
   ```javascript
   SERVERLESS_API_URL: "https://your-site.netlify.app/.netlify/functions/api"
   ```
4. Enable **GitHub Pages** in your repository settings (`Settings > Pages > Deploy from branch`).


## Repair notes (November 2026)
- Restored the missing `css/ambulance-dashboard.css` and `css/app.css` files referenced by all three HTML pages. Their absence caused the unstyled/jumbled layout.
- Simplified the driver sign-in form to **Full Name, Email Address, and Password**.
- Driver sign-in now checks those three fields against a server-authorized operator profile. The full name must match the authorized profile; removing vehicle/fleet fields from the form does not make arbitrary accounts authorized.
- The CSS is responsive for mobile and desktop. The landing-page Framer layout is constrained to prevent oversized elements from overflowing.
- This is a student demonstration prototype. Do not use it for real emergency dispatch or operational traffic control.
