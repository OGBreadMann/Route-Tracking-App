# Pinky's Route Tracker

A phone web app for tracking the Pinky's Trash pickup routes, logging each stop,
and finding the fastest order to run them.

No App Store needed — it's a website you add to your iPhone home screen. All data
stays on the phone (export a backup from Settings now and then).

## Using it

1. **Install:** open the site in Safari → Share → **Add to Home Screen**. Open it from the icon and allow location.
2. **Route day:** Track tab → pick or create the route (e.g. "Monday – Lufkin") → **Start Route**.
   The first time, start at the house and it will save that spot as **Home**.
   - Tap **STOP HERE** at every pickup. Stops are remembered, so next week tapping at the
     same house counts as a visit to that saved stop.
   - Tap **🗑️ Dump** at the dump/landfill (the site is saved automatically).
   - **Keep the app on screen** while driving — iPhones pause GPS for web apps when the
     screen locks or you switch apps. If the screen still dims, set Auto-Lock to Never.
   - Tap **■ End day** when done.
3. **Optimize:** open the day (or the route) → **⚡ Find the fastest route**. It gets real
   drive times between every stop from OpenStreetMap road data, finds the fastest order
   (starting at Home, ending at the dump/home/last stop, with dump trips mid-route if the
   truck filled up), and compares it with the order you actually drove.
4. **Use this order next time** saves it; the next time you start that route it shows the
   next stop with a **Navigate** button (opens Apple Maps).

Customer list: Settings → **Import customers (CSV)**. Name / Address / City / Zip /
Route-or-Day / Lat / Lng columns are detected automatically.

## Hosting (GitHub Pages)

1. Make the repo public (Settings → General → Danger Zone → Change visibility). Only the
   code is in the repo — customer data never leaves the phone.
2. Settings → Pages → Build and deployment → **Deploy from a branch** → pick the branch,
   folder `/ (root)` → Save.
3. After a minute the app is at `https://<username>.github.io/<repo-name>/`.

## Development

Plain HTML/CSS/JS, no build step. Serve the folder with any static server
(`python3 -m http.server`) and open it. Optimizer tests: `npm test` (Node 18+).

- `js/tracker.js` – GPS recording, stop/dump logging, wake lock, resume after reload
- `js/optimizer.js` – route solver (exact for ≤10 stops; 2-opt / Or-opt / iterated local search above) and truckload splitting
- `js/matrix.js` – road drive times from public OSRM servers, cached on the phone
- `js/analysis.js` – builds the problem from recorded days and compares orders
- `js/app.js` – screens

Maps © OpenStreetMap contributors. Drive times by OSRM.
