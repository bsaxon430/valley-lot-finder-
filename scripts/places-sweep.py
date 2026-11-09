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

def nearby(types, lat, lng, radius=1500, rank='DISTANCE'):
    global calls
    calls += 1
    body = {'includedTypes': types, 'maxResultCount': 20, 'rankPreference': rank,
            'locationRestriction': {'circle': {'center': {'latitude': lat, 'longitude': lng}, 'radius': radius}}}
    req = urllib.request.Request('https://places.googleapis.com/v1/places:searchNearby', data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'X-Goog-Api-Key': K, 'X-Goog-FieldMask': FM.replace(',nextPageToken', '')})
    try: return json.load(urllib.request.urlopen(req, timeout=30)).get('places', [])
    except urllib.error.HTTPError as e: print('HTTP', e.code, e.read()[:300].decode(errors='replace')); return []

if MODE == 'nearby':
    import math
    S, W, N, E = 33.20, -112.65, 33.80, -111.50
    R = 1500; step_lat = 2.4 / 111.0; step_lng = 2.4 / (111.0 * math.cos(math.radians(33.5)))
    GROUPS = [
      ['bar', 'night_club', 'bank', 'pharmacy', 'drugstore', 'car_dealer', 'gym', 'supermarket', 'grocery_store', 'department_store', 'furniture_store',
       'hardware_store', 'home_improvement_store', 'movie_theater', 'bowling_alley', 'event_venue', 'banquet_hall', 'wedding_venue', 'car_wash',
       'auto_parts_store', 'sporting_goods_store', 'electronics_store', 'discount_store', 'warehouse_store', 'shopping_mall', 'church'],
      ['restaurant', 'fast_food_restaurant', 'mexican_restaurant', 'american_restaurant', 'steak_house', 'seafood_restaurant', 'pizza_restaurant',
       'breakfast_restaurant', 'chinese_restaurant', 'sports_bar' if False else 'bar_and_grill'],
    ]
    found = {}; seen = 0; lat = S
    centers = []
    while lat <= N:
        lng = W
        while lng <= E: centers.append((round(lat, 5), round(lng, 5))); lng += step_lng
        lat += step_lat
    print('circles', len(centers), 'groups', len(GROUPS))
    for gi, types in enumerate(GROUPS):
        for (la, ln) in centers:
            if calls >= MAX_CALLS: break
            ps = nearby(types, la, ln, R, 'DISTANCE'); seen += len(ps)
            for p in ps:
                st = p.get('businessStatus')
                if st in ('CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY') and p['id'] not in found:
                    loc = p.get('location', {})
                    found[p['id']] = {'place_id': p['id'], 'name': (p.get('displayName') or {}).get('text', ''), 'address': p.get('formattedAddress', ''),
                        'lat': loc.get('latitude'), 'lng': loc.get('longitude'), 'status': st, 'type': p.get('primaryType', ''), 'types': p.get('types', []), 'maps': p.get('googleMapsUri', '')}
        print(f'group {gi}: calls {calls}, closed so far {len(found)}')
    json.dump(sorted(found.values(), key=lambda x: x['place_id']), open('closed-places.json', 'w'), indent=1)
    print('DONE calls', calls, 'seen', seen, 'closed', len(found), dict(collections.Counter(v['status'] for v in found.values()))); sys.exit(0)

if MODE == 'probe2':
    tot = collections.Counter()
    for (lat, lng) in [(33.47, -112.07), (33.50, -112.11), (33.42, -111.94), (33.39, -111.84), (33.61, -112.12)]:
        for t in (['restaurant'], ['bank'], ['store']):
            ps = nearby(t, lat, lng)
            c = collections.Counter(p.get('businessStatus') for p in ps); tot.update(c)
            closed = [((p.get('displayName') or {}).get('text'), p.get('businessStatus')) for p in ps if p.get('businessStatus') != 'OPERATIONAL']
            print(lat, lng, t, dict(c), closed[:5])
    print('TOTAL', dict(tot), 'calls used:', calls); sys.exit(0)

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
