# Valley Lot Finder

Phoenix-metro parking-lot discovery map for vehicle-testing crews. Open the link on a phone, see your GPS
location, find nearby candidate lots from real county parcel data, preview them, and tap NAVIGATE.

**Discovery tool, not an authorization system.** Every county parcel is a *candidate* until an employee
inspects it. A high discovery score never implies permission to enter.

## Live site
GitHub Pages: `https://bsaxon430.github.io/valley-lot-finder-/`

Install on a phone: open the link → Share → **Add to Home Screen** (iPhone) or the browser's **Install app** (Android).

## What is implemented (Phase 1–2, plus parts of 4–5)
| Feature | Status | Source |
|---|---|---|
| Real Phoenix street map, dark/street/satellite/hybrid, 3D buildings | ✅ | OpenFreeMap (OSM vector tiles), Esri World Imagery |
| GPS blue dot, recenter, pinch/zoom, compass | ✅ | Browser Geolocation API |
| County commercial/industrial parcels ≥ N acres in viewport, clustered | ✅ | Maricopa County Assessor ArcGIS REST (live, no key) |
| Parcel outlines, APN, owner, lot size, use code, legal class, zoning, year built | ✅ | Same |
| FIND NEAREST LOT (radius search from GPS), sort nearest/largest/score | ✅ | Same |
| OSM parking-area polygons + capacity/access tags (P button) | ✅ | Overpass API (live) |
| Address / business / city search | ✅ | Nominatim + county address match |
| NAVIGATE (Apple Maps / Google Maps / Waze / geo:) | ✅ | Deep links with real coordinates |
| Copy coords/address, share link that opens directly to the parcel (`#apn-…`) | ✅ | — |
| Employee pins, field reports, photos, favorites, visited, review requests | ✅ on-device | localStorage (per phone) + JSON export |
| Discovery score 0–100 with reasons; separate authorization field | ✅ | Computed from documented attributes only |
| PWA manifest + home-screen install | ✅ | — |

## Not implemented yet (needs accounts/keys or data agreements)
| Feature | Blocker | What's needed |
|---|---|---|
| Shared team database (pins/reports visible to everyone, admin review, roles) | needs a backend | Supabase project (free tier) — adapter planned in `app.js` → `S.local` is the only persistence layer today |
| Google Street View previews | API key + billing | Google Maps Platform key with Street View Static API |
| Driving time | routing service | e.g. OpenRouteService key or Google Directions |
| Crexi / LoopNet listings (FOR LEASE) | no public API; scraping prohibited by their terms | licensed data feed or manual entry via field report "Listing URL" |
| Phoenix Vacant Property Registry | no public address-level download found | FOIA/public-records request or city data agreement |
| Building square footage | not in the county GIS feed | Assessor bulk data download (free, requires registration) |
| Employee login | needs auth provider | Supabase Auth or GitHub Pages → move to Vercel/Cloudflare with access control |

## Data notes
- **VACANT / ABANDONED / CLOSED / FOR LEASE / LOW ACTIVITY / VERIFIED** come only from employee reports (and later, listings). County parcel records never set these.
- "Hide government / exempt" filters owners matching city/county/state/school/utility names and legal class 9.
- Unknown fields display **UNKNOWN**. No parking counts, photos, or listings are fabricated.
- Map data © OpenStreetMap contributors (ODbL). Imagery © Esri and partners. Parcels © Maricopa County Assessor.

## Files
`index.html` UI · `app.js` all logic · `styles.css` · `manifest.webmanifest` · `sw.js` app-shell cache · `icons/`
No build step. Any static host works.
