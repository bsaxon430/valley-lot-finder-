# Finds temporarily / permanently closed businesses across the Phoenix metro via Google Places API (New).
# Runs only in GitHub Actions (key comes from the PLACES_KEY secret, never printed).
# MODE=probe -> tiny test, prints status counts.  MODE=sweep -> full grid, writes closed-places.json
import json, os, sys, time, urllib.request, urllib.error, collections
K = os.environ['PLACES_KEY'].strip()
MODE = os.environ.get('MODE', 'probe')
MAX_CALLS = int(os.environ.get('MAX_CALLS', '3000'))
FM = 'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus,places.primaryType,places.types,places.googleMapsUri,nextPageToken'
calls = 0
def search(body):
    global calls
    calls += 1
    req = urllib.request.Request('https://places.googleapis.com/v1/places:searchText', data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'X-Goog-Api-Key': K, 'X-Goog-FieldMask': FM})
    for i in range(3):
        try: return json.load(urllib.request.urlopen(req, timeout=30))
        except urllib.error.HTTPError as e:
            msg = e.read()[:300].decode(errors='replace')
            if e.code in (429, 500, 503): time.sleep(3 * (i + 1)); continue
            print('HTTP', e.code, msg); sys.exit(1)
        except Exception as e: time.sleep(3)
    return {}
def run(q, rect, pages=3):
    body = {'textQuery': q, 'locationRestriction': {'rectangle': rect}, 'pageSize': 20}
    out, tok = [], None
    for _ in range(pages):
        if calls >= MAX_CALLS: break
        if tok: body['pageToken'] = tok; time.sleep(1.5)
        j = search(body); out += j.get('places', []); tok = j.get('nextPageToken')
        if not tok: break
    return out, bool(tok)

if MODE == 'probe':
    rect = {'low': {'latitude': 33.44, 'longitude': -112.10}, 'high': {'latitude': 33.50, 'longitude': -112.02}}
    for q in ['restaurant', 'closed restaurant', 'permanently closed', 'bank']:
        ps, more = run(q, rect)
        print(f'{q!r}: {len(ps)} places, statuses={dict(collections.Counter(p.get("businessStatus") for p in ps))}, more_pages={more}')
    print('calls used:', calls); sys.exit(0)

S, W, N, E = 33.20, -112.65, 33.80, -111.50
DLAT, DLNG = 0.06, 0.08
QUERIES = [q.strip() for q in os.environ.get('QUERIES', 'restaurant|fast food|bank|pharmacy|grocery store|store|gym|car dealer|furniture store|auto repair').split('|')]
found = {}
cells = []
lat = S
while lat < N:
    lng = W
    while lng < E:
        cells.append({'low': {'latitude': round(lat, 4), 'longitude': round(lng, 4)}, 'high': {'latitude': round(min(lat + DLAT, N), 4), 'longitude': round(min(lng + DLNG, E), 4)}})
        lng += DLNG
    lat += DLAT
seen = 0
for q in QUERIES:
    for c in cells:
        if calls >= MAX_CALLS: break
        ps, _ = run(q, c); seen += len(ps)
        for p in ps:
            st = p.get('businessStatus')
            if st in ('CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY') and p['id'] not in found:
                loc = p.get('location', {})
                found[p['id']] = {'place_id': p['id'], 'name': (p.get('displayName') or {}).get('text', ''), 'address': p.get('formattedAddress', ''),
                    'lat': loc.get('latitude'), 'lng': loc.get('longitude'), 'status': st, 'type': p.get('primaryType', ''), 'types': p.get('types', []), 'maps': p.get('googleMapsUri', ''), 'query': q}
    print(f'{q!r}: calls so far {calls}, closed found {len(found)}')
json.dump(sorted(found.values(), key=lambda x: x['place_id']), open('closed-places.json', 'w'), indent=1)
print('DONE calls', calls, 'places seen', seen, 'closed', len(found), dict(collections.Counter(v['status'] for v in found.values())))
