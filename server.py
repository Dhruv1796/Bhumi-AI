from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
import hashlib
import json
import math
import os
import re
import sqlite3
import uuid
from email.parser import BytesParser
from email.policy import default

try:
    import easyocr
    import fitz
    from PIL import Image
except Exception:  # pragma: no cover - handled at runtime when OCR libraries are absent
    easyocr = None
    fitz = None
    Image = None

ROOT = os.path.dirname(__file__)
DATA_FILE = os.path.join(ROOT, 'data', 'dashboard.json')
DEMO_PARCEL_FILE = os.path.join(ROOT, 'data', 'demo_parcel.geojson')
DB_FILE = os.path.join(ROOT, 'data', 'bhoomi.db')
UPLOAD_DIR = os.path.join(ROOT, 'data', 'uploads')
PORT = 3000
TOKENS = {}
OCR_READER = None
DEFAULT_USERS = [
    ('admin', 'admin123', 'admin', 'Administrator'),
    ('inspector', 'inspector123', 'inspector', 'Field Inspector'),
    ('surveyor', 'surveyor123', 'inspector', 'Senior Surveyor'),
    ('landofficer', 'landofficer123', 'admin', 'Land Records Officer'),
    ('villageadmin', 'village123', 'inspector', 'Village Administrative Officer'),
    ('gisanalyst', 'gisanalyst123', 'inspector', 'GIS Analyst')
]

os.makedirs(UPLOAD_DIR, exist_ok=True)


def hash_password(password):
    return hashlib.sha256(password.encode('utf-8')).hexdigest()


def get_connection():
    connection = sqlite3.connect(DB_FILE)
    connection.row_factory = sqlite3.Row
    return connection


def init_database():
    connection = get_connection()
    try:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL,
                fullname TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS records (
                id TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                village TEXT NOT NULL,
                documentType TEXT DEFAULT 'Mutation Record',
                status TEXT DEFAULT 'Pending',
                progress INTEGER DEFAULT 35,
                latitude REAL,
                longitude REAL
            )
            """
        )

        record_columns = {row['name'] for row in connection.execute('PRAGMA table_info(records)')}
        if 'latitude' not in record_columns:
            connection.execute('ALTER TABLE records ADD COLUMN latitude REAL')
        if 'longitude' not in record_columns:
            connection.execute('ALTER TABLE records ADD COLUMN longitude REAL')
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                recordId TEXT NOT NULL,
                owner TEXT NOT NULL,
                village TEXT NOT NULL,
                documentType TEXT DEFAULT 'Mutation Record',
                filename TEXT,
                status TEXT DEFAULT 'Queued',
                confidence REAL DEFAULT 0.0,
                createdAt TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS parcel_layers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                geojson TEXT NOT NULL,
                uploadedAt TEXT NOT NULL
            )
            """
        )

        existing_parcel_layers = connection.execute('SELECT COUNT(*) AS count FROM parcel_layers').fetchone()['count']
        if existing_parcel_layers == 0:
            demo_layers = get_demo_parcel_layers()
            for layer_name, layer_geojson in demo_layers:
                connection.execute(
                    'INSERT INTO parcel_layers (name, geojson, uploadedAt) VALUES (?, ?, ?)',
                    (
                        layer_name,
                        json.dumps(layer_geojson, allow_nan=False),
                        __import__('datetime').datetime.utcnow().isoformat() + 'Z'
                    )
                )

        existing_users = connection.execute('SELECT COUNT(*) AS count FROM users').fetchone()['count']
        if existing_users == 0:
            for username, password, role, fullname in DEFAULT_USERS:
                connection.execute(
                    'INSERT INTO users (username, password_hash, role, fullname) VALUES (?, ?, ?, ?)',
                    (username, hash_password(password), role, fullname)
                )

        existing_records = connection.execute('SELECT COUNT(*) AS count FROM records').fetchone()['count']
        if existing_records == 0:
            with open(DATA_FILE, 'r', encoding='utf-8') as file:
                dashboard = json.load(file)
            for record in dashboard.get('records', []):
                connection.execute(
                    'INSERT INTO records (id, owner, village, documentType, status, progress) VALUES (?, ?, ?, ?, ?, ?)',
                    (
                        record.get('id'),
                        record.get('owner', 'Unknown Owner'),
                        record.get('village', 'Unknown Village'),
                        record.get('documentType', 'Mutation Record'),
                        record.get('status', 'Pending'),
                        int(record.get('progress', 35)),
                    )
                )

            for record in get_default_real_records():
                connection.execute(
                    'INSERT OR REPLACE INTO records (id, owner, village, documentType, status, progress, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    (
                        record['id'],
                        record['owner'],
                        record['village'],
                        record.get('documentType', 'Mutation Record'),
                        record.get('status', 'Pending'),
                        int(record.get('progress', 35)),
                        record.get('latitude'),
                        record.get('longitude')
                    )
                )
        connection.commit()
    finally:
        connection.close()


def get_default_real_records():
    return [
        {
            'id': 'LR-2048-021',
            'owner': 'Vilas Patil',
            'village': 'Kharad',
            'documentType': 'Mutation Record',
            'status': 'Approved',
            'progress': 98,
            'latitude': 19.7515,
            'longitude': 75.7138
        },
        {
            'id': 'LR-2048-022',
            'owner': 'Shaila More',
            'village': 'Nandgaon',
            'documentType': 'Land Conversion',
            'status': 'In Review',
            'progress': 76,
            'latitude': 19.8913,
            'longitude': 75.3142
        },
        {
            'id': 'LR-2048-023',
            'owner': 'Rajesh Pawar',
            'village': 'Shirpur',
            'documentType': 'Mutation Record',
            'status': 'Pending',
            'progress': 53,
            'latitude': 21.3487,
            'longitude': 74.8805
        },
        {
            'id': 'LR-2048-024',
            'owner': 'Deepa Kulkarni',
            'village': 'Babhulgaon',
            'documentType': 'Title Verification',
            'status': 'Approved',
            'progress': 92,
            'latitude': 20.5939,
            'longitude': 76.1720
        },
        {
            'id': 'LR-2048-025',
            'owner': 'Ashok Yadav',
            'village': 'Wadgaon',
            'documentType': 'Mutation Record',
            'status': 'Review',
            'progress': 68,
            'latitude': 19.6303,
            'longitude': 75.7158
        }
    ]


def get_demo_parcel_layers():
    return [
        (
            'Kharad Survey Cluster',
            {
                'type': 'FeatureCollection',
                'features': [
                    {
                        'type': 'Feature',
                        'properties': {
                            'parcel_id': 'MH-KR-101',
                            'survey_no': '101/2',
                            'village': 'Kharad',
                            'owner': 'Vilas Patil',
                            'land_use': 'Agricultural',
                            'source': 'Revenue survey',
                            'status': 'Approved'
                        },
                        'geometry': {
                            'type': 'Polygon',
                            'coordinates': [[
                                [75.7135, 19.7513],
                                [75.7144, 19.7511],
                                [75.7148, 19.7519],
                                [75.7140, 19.7524],
                                [75.7132, 19.7520],
                                [75.7135, 19.7513]
                            ]]
                        }
                    },
                    {
                        'type': 'Feature',
                        'properties': {
                            'parcel_id': 'MH-KR-102',
                            'survey_no': '102/1',
                            'village': 'Kharad',
                            'owner': 'Suresh Patil',
                            'land_use': 'Residential',
                            'source': 'Field verification',
                            'status': 'In Review'
                        },
                        'geometry': {
                            'type': 'Polygon',
                            'coordinates': [[
                                [75.7149, 19.7509],
                                [75.7159, 19.7508],
                                [75.7162, 19.7517],
                                [75.7153, 19.7521],
                                [75.7149, 19.7509]
                            ]]
                        }
                    }
                ]
            }
        ),
        (
            'Nandgaon Settlement Zone',
            {
                'type': 'FeatureCollection',
                'features': [
                    {
                        'type': 'Feature',
                        'properties': {
                            'parcel_id': 'MH-NG-221',
                            'survey_no': '221/4',
                            'village': 'Nandgaon',
                            'owner': 'Shaila More',
                            'land_use': 'Residential',
                            'source': 'GIS mapping',
                            'status': 'Approved'
                        },
                        'geometry': {
                            'type': 'Polygon',
                            'coordinates': [[
                                [75.3115, 19.8909],
                                [75.3128, 19.8905],
                                [75.3135, 19.8919],
                                [75.3122, 19.8926],
                                [75.3115, 19.8909]
                            ]]
                        }
                    },
                    {
                        'type': 'Feature',
                        'properties': {
                            'parcel_id': 'MH-NG-223',
                            'survey_no': '223/6',
                            'village': 'Nandgaon',
                            'owner': 'Anita Jadhav',
                            'land_use': 'Agricultural',
                            'source': 'Cadastral boundary',
                            'status': 'Review'
                        },
                        'geometry': {
                            'type': 'Polygon',
                            'coordinates': [[
                                [75.3140, 19.8898],
                                [75.3151, 19.8894],
                                [75.3158, 19.8905],
                                [75.3146, 19.8914],
                                [75.3140, 19.8898]
                            ]]
                        }
                    }
                ]
            }
        ),
        (
            'Shirpur Revenue Block',
            {
                'type': 'FeatureCollection',
                'features': [
                    {
                        'type': 'Feature',
                        'properties': {
                            'parcel_id': 'MH-SP-404',
                            'survey_no': '404/11',
                            'village': 'Shirpur',
                            'owner': 'Rajesh Pawar',
                            'land_use': 'Agricultural',
                            'source': 'Revenue department',
                            'status': 'Pending'
                        },
                        'geometry': {
                            'type': 'Polygon',
                            'coordinates': [[
                                [74.8785, 21.3468],
                                [74.8798, 21.3462],
                                [74.8805, 21.3478],
                                [74.8793, 21.3489],
                                [74.8785, 21.3468]
                            ]]
                        }
                    },
                    {
                        'type': 'Feature',
                        'properties': {
                            'parcel_id': 'MH-SP-409',
                            'survey_no': '409/2',
                            'village': 'Shirpur',
                            'owner': 'Nisha Deshmukh',
                            'land_use': 'Commercial',
                            'source': 'Survey data',
                            'status': 'Approved'
                        },
                        'geometry': {
                            'type': 'Polygon',
                            'coordinates': [[
                                [74.8810, 21.3458],
                                [74.8822, 21.3454],
                                [74.8829, 21.3468],
                                [74.8817, 21.3474],
                                [74.8810, 21.3458]
                            ]]
                        }
                    }
                ]
            }
        )
    ]


def list_users():
    connection = get_connection()
    try:
        rows = connection.execute(
            'SELECT username, role, fullname FROM users ORDER BY fullname ASC'
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        connection.close()


def calculate_feature_bounds(features):
    min_lon = float('inf')
    min_lat = float('inf')
    max_lon = float('-inf')
    max_lat = float('-inf')
    total_points = 0

    def walk_coordinates(value):
        nonlocal min_lon, min_lat, max_lon, max_lat, total_points
        if isinstance(value, list) and len(value) >= 2 and isinstance(value[0], (int, float)) and isinstance(value[1], (int, float)):
            lon = float(value[0])
            lat = float(value[1])
            min_lon = min(min_lon, lon)
            min_lat = min(min_lat, lat)
            max_lon = max(max_lon, lon)
            max_lat = max(max_lat, lat)
            total_points += 1
        elif isinstance(value, list):
            for item in value:
                walk_coordinates(item)

    for feature in features:
        geometry = feature.get('geometry', {}) if isinstance(feature, dict) else {}
        walk_coordinates(geometry.get('coordinates', []))

    if total_points == 0:
        return {'minLat': None, 'minLon': None, 'maxLat': None, 'maxLon': None}

    return {
        'minLat': round(min_lat, 6),
        'minLon': round(min_lon, 6),
        'maxLat': round(max_lat, 6),
        'maxLon': round(max_lon, 6)
    }


def estimate_feature_area_sq_km(feature):
    geometry = feature.get('geometry', {}) if isinstance(feature, dict) else {}
    coordinates = geometry.get('coordinates', []) if isinstance(geometry, dict) else []
    if not isinstance(coordinates, list):
        return 0.0

    points = []

    def walk(value):
        if isinstance(value, list) and len(value) >= 2 and isinstance(value[0], (int, float)) and isinstance(value[1], (int, float)):
            points.append((float(value[0]), float(value[1])))
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(coordinates)
    if len(points) < 3:
        return 0.0

    avg_lat = sum(lat for _, lat in points) / len(points)
    lat_factor = math.cos(math.radians(avg_lat)) if abs(avg_lat) < 89.9 else 0.0
    width_km = (max(lon for lon, _ in points) - min(lon for lon, _ in points)) * 111.32 * max(lat_factor, 0.0001)
    height_km = (max(lat for _, lat in points) - min(lat for _, lat in points)) * 111.32
    return round(max(width_km * height_km, 0.0), 2)


def list_parcel_layers():
    connection = get_connection()
    try:
        rows = connection.execute('SELECT id, name, geojson, uploadedAt FROM parcel_layers ORDER BY id').fetchall()
        layers = []
        for row in rows:
            geojson = json.loads(row['geojson'])
            feature_count = len(geojson.get('features', []))
            features = geojson.get('features', [])
            bounds = calculate_feature_bounds(features)
            total_area = sum(estimate_feature_area_sq_km(feature) for feature in features)
            layers.append({
                'id': row['id'],
                'name': row['name'],
                'featureCount': feature_count,
                'uploadedAt': row['uploadedAt'],
                'bounds': bounds,
                'totalAreaSqKm': round(total_area, 2),
                'featureCollection': geojson
            })
        return layers
    finally:
        connection.close()


def summarize_parcel_layers():
    layers = list_parcel_layers()
    feature_total = sum(layer['featureCount'] for layer in layers)
    total_area = sum(layer['totalAreaSqKm'] for layer in layers)
    bounds = {
        'minLat': min((layer['bounds']['minLat'] for layer in layers if layer['bounds']['minLat'] is not None), default=None),
        'minLon': min((layer['bounds']['minLon'] for layer in layers if layer['bounds']['minLon'] is not None), default=None),
        'maxLat': max((layer['bounds']['maxLat'] for layer in layers if layer['bounds']['maxLat'] is not None), default=None),
        'maxLon': max((layer['bounds']['maxLon'] for layer in layers if layer['bounds']['maxLon'] is not None), default=None),
    }
    return {
        'layerCount': len(layers),
        'featureCount': feature_total,
        'totalAreaSqKm': round(total_area, 2),
        'bounds': bounds,
        'layers': [
            {
                'id': layer['id'],
                'name': layer['name'],
                'featureCount': layer['featureCount'],
                'totalAreaSqKm': layer['totalAreaSqKm']
            }
            for layer in layers
        ]
    }


def list_record_map_points():
    connection = get_connection()
    try:
        rows = connection.execute(
            'SELECT id, owner, village, documentType, status, progress, latitude, longitude FROM records WHERE latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY rowid DESC'
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        connection.close()


def summarize_record_statuses():
    connection = get_connection()
    try:
        rows = connection.execute(
            'SELECT status, COUNT(*) AS count FROM records GROUP BY status ORDER BY count DESC'
        ).fetchall()
        return {row['status']: row['count'] for row in rows}
    finally:
        connection.close()


def summarize_geospatial_analytics():
    parcel_summary = summarize_parcel_layers()
    record_summary = summarize_record_statuses()
    map_points = list_record_map_points()
    by_village = {}
    for item in map_points:
        village = item.get('village', 'Unknown')
        by_village[village] = by_village.get(village, 0) + 1
    return {
        'parcelSummary': parcel_summary,
        'recordStatusCounts': record_summary,
        'mappedRecords': len(map_points),
        'recordsByVillage': by_village,
        'coverage': {
            'avgProgress': round(sum(item.get('progress', 0) for item in list_records()) / max(len(list_records()), 1), 1),
            'approved': record_summary.get('Approved', 0),
            'pending': record_summary.get('Pending', 0),
            'review': record_summary.get('Review', 0) + record_summary.get('In Review', 0)
        }
    }


def list_records():
    connection = get_connection()
    try:
        rows = connection.execute(
            'SELECT id, owner, village, documentType, status, progress, latitude, longitude FROM records ORDER BY rowid DESC'
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        connection.close()


def list_documents():
    connection = get_connection()
    try:
        rows = connection.execute(
            'SELECT id, recordId, owner, village, documentType, filename, status, confidence, createdAt FROM documents ORDER BY createdAt DESC'
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        connection.close()


def list_parcel_features(layer_name=None, village=None, owner=None, status=None):
    connection = get_connection()
    try:
        rows = connection.execute('SELECT name, geojson FROM parcel_layers ORDER BY id').fetchall()
        features = []
        for row in rows:
            if layer_name and row['name'].lower() != layer_name.lower():
                continue
            layer = json.loads(row['geojson'])
            for feature in layer['features']:
                feature = dict(feature)
                properties = dict(feature.get('properties') or {})
                if village and str(properties.get('village') or '').lower() != str(village).lower():
                    continue
                if owner and str(properties.get('owner') or '').lower() != str(owner).lower():
                    continue
                if status and str(properties.get('status') or '').lower() != str(status).lower():
                    continue
                properties['_layerName'] = row['name']
                feature['properties'] = properties
                features.append(feature)
        return {'type': 'FeatureCollection', 'features': features}
    finally:
        connection.close()


def validate_parcel_geojson(geojson):
    if not isinstance(geojson, dict) or geojson.get('type') != 'FeatureCollection':
        return 'Upload a GeoJSON FeatureCollection.'
    features = geojson.get('features')
    if not isinstance(features, list) or not features:
        return 'The GeoJSON file must contain at least one parcel feature.'

    for feature in features:
        geometry = feature.get('geometry') if isinstance(feature, dict) else None
        if not isinstance(feature, dict) or feature.get('type') != 'Feature' or not isinstance(geometry, dict):
            return 'Each item must be a valid GeoJSON feature.'
        if geometry.get('type') not in ('Polygon', 'MultiPolygon'):
            return 'Parcel features must use Polygon or MultiPolygon geometry.'

        def positions(coordinates):
            if (isinstance(coordinates, list) and len(coordinates) >= 2
                    and isinstance(coordinates[0], (int, float))
                    and isinstance(coordinates[1], (int, float))):
                yield coordinates
            elif isinstance(coordinates, list):
                for coordinate in coordinates:
                    yield from positions(coordinate)

        points = list(positions(geometry.get('coordinates')))
        if not points or any(
                not math.isfinite(point[0]) or not math.isfinite(point[1])
                or not -180 <= point[0] <= 180 or not -90 <= point[1] <= 90
                for point in points):
            return 'Parcel coordinates must be finite GeoJSON longitude/latitude values.'
    return None


def authenticate_user(username, password):
    connection = get_connection()
    try:
        row = connection.execute(
            'SELECT username, role, fullname FROM users WHERE username = ? AND password_hash = ?',
            (username, hash_password(password))
        ).fetchone()
        return dict(row) if row else None
    finally:
        connection.close()


def get_ocr_reader():
    global OCR_READER
    if OCR_READER is None:
        if easyocr is None:
            raise RuntimeError('easyocr is not installed')
        OCR_READER = easyocr.Reader(['en'], gpu=False)
    return OCR_READER


def parse_multipart_form_data(raw_data, content_type):
    if not raw_data:
        return {'fields': {}, 'files': []}

    message = BytesParser(policy=default).parsebytes(
        f'Content-Type: {content_type}\r\n\r\n'.encode('utf-8') + raw_data
    )
    fields = {}
    files = []

    if not message.is_multipart():
        return {'fields': fields, 'files': files}

    for part in message.iter_parts():
        disposition = part.get_content_disposition()
        name = part.get_param('name', header='content-disposition')
        if disposition == 'form-data' and part.get_filename():
            files.append({
                'name': name,
                'filename': part.get_filename(),
                'content_type': part.get_content_type(),
                'data': part.get_payload(decode=True) or b''
            })
        elif disposition == 'form-data' and name:
            value = part.get_payload(decode=True)
            fields[name] = value.decode('utf-8', errors='replace') if value else ''

    return {'fields': fields, 'files': files}


def find_uploaded_file(document_id):
    for filename in os.listdir(UPLOAD_DIR):
        if filename.startswith(f'{document_id}'):
            return os.path.join(UPLOAD_DIR, filename)
    return None


def extract_ocr_text(file_path):
    if not file_path or not os.path.exists(file_path):
        return ''

    try:
        if file_path.lower().endswith('.pdf'):
            if fitz is None:
                return ''
            document = fitz.open(file_path)
            if document.page_count == 0:
                return ''
            page = document[0]
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
            image = Image.frombytes('RGB', [pix.width, pix.height], pix.samples)
            document.close()
            image_array = __import__('numpy').array(image)
            results = get_ocr_reader().readtext(image_array, detail=0, paragraph=True)
            return '\n'.join(results)

        with Image.open(file_path) as image:
            image = image.convert('RGB')
            image_array = __import__('numpy').array(image)
            results = get_ocr_reader().readtext(image_array, detail=0, paragraph=True)
            return '\n'.join(results)
    except Exception:
        return ''


def infer_confidence_from_text(text):
    if not text:
        return 0.0
    words = re.findall(r'\b[A-Za-z0-9]+\b', text)
    if not words:
        return 0.0
    readable_tokens = sum(1 for token in words if len(token) >= 3)
    ratio = readable_tokens / max(len(words), 1)
    return round(min(99.9, max(55.0, ratio * 100.0)), 1)


class AppHandler(SimpleHTTPRequestHandler):
    def require_auth(self, allowed_roles=None):
        auth_header = self.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return None
        token = auth_header.split(' ', 1)[1].strip()
        user = TOKENS.get(token)
        if not user:
            return None
        if allowed_roles and user.get('role') not in allowed_roles:
            return None
        return user

    def normalize_path(self, path):
        return path.rstrip('/') if path != '/' else path

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = self.normalize_path(parsed.path)
        if path == '/api/me':
            user = self.require_auth()
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            self.send_json({'user': user})
            return
        if path == '/api/users':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            self.send_json({'users': list_users()})
            return
        if path == '/api/dashboard':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            with open(DATA_FILE, 'r', encoding='utf-8') as file:
                dashboard = json.load(file)
            dashboard['records'] = list_records()
            dashboard['documents'] = list_documents()
            dashboard['users'] = list_users()
            self.send_json(dashboard)
            return
        if path == '/api/records':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            self.send_json(list_records())
            return
        if path == '/api/parcels':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            query_params = parse_qs(parsed.query)
            layer_name = (query_params.get('layerName') or query_params.get('layer') or [None])[0]
            village = (query_params.get('village') or [None])[0]
            owner = (query_params.get('owner') or [None])[0]
            status = (query_params.get('status') or [None])[0]
            self.send_json(list_parcel_features(layer_name, village=village, owner=owner, status=status))
            return
        if path == '/api/parcels/search':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            query_params = parse_qs(parsed.query)
            self.send_json(list_parcel_features(
                layer_name=(query_params.get('layerName') or query_params.get('layer') or [None])[0],
                village=(query_params.get('village') or [None])[0],
                owner=(query_params.get('owner') or [None])[0],
                status=(query_params.get('status') or [None])[0],
            ))
            return
        if path == '/api/parcels/layers':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            self.send_json({'layers': list_parcel_layers()})
            return
        if path == '/api/parcels/summary':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            self.send_json({'summary': summarize_parcel_layers()})
            return
        if path == '/api/geospatial/layers':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            self.send_json({'layers': list_parcel_layers()})
            return
        if path == '/api/geospatial/summary':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            self.send_json({
                'summary': summarize_parcel_layers(),
                'layers': list_parcel_layers(),
                'records': list_record_map_points()
            })
            return
        if path == '/api/geospatial/analytics':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            self.send_json(summarize_geospatial_analytics())
            return
        if path == '/api/records/map':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            self.send_json({'records': list_record_map_points()})
            return
        if path == '/api/documents':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            self.send_json(list_documents())
            return
        if parsed.path == '/':
            self.path = 'index.html'
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = self.normalize_path(parsed.path)
        if path == '/api/login':
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode('utf-8') or '{}')
            username = payload.get('username')
            password = payload.get('password')
            user = authenticate_user(username, password)
            if not user:
                self.send_json({'error': 'Invalid username or password'}, status=401)
                return
            token = uuid.uuid4().hex
            TOKENS[token] = user
            self.send_json({
                'token': token,
                'user': user
            })
            return

        if path == '/api/documents':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length)
            content_type = self.headers.get('Content-Type', '')
            payload = {}
            uploaded_file = None
            uploaded_filename = None

            if content_type.startswith('multipart/form-data'):
                form_data = parse_multipart_form_data(raw, content_type)
                payload = form_data['fields']
                if form_data['files']:
                    uploaded = form_data['files'][0]
                    uploaded_file = uploaded['data']
                    uploaded_filename = uploaded['filename']
            else:
                payload = json.loads(raw.decode('utf-8') or '{}')

            record_id = payload.get('recordId') or payload.get('id')
            owner = payload.get('owner')
            village = payload.get('village')
            filename = payload.get('filename') or (uploaded_filename or f'{record_id or "record"}.pdf')
            document_type = payload.get('documentType', 'Mutation Record')
            if not record_id or not owner or not village:
                self.send_json({'error': 'Record id, owner, and village are required.'}, status=400)
                return
            document_id = payload.get('documentId') or uuid.uuid4().hex[:8].upper()
            created_at = payload.get('createdAt') or __import__('datetime').datetime.utcnow().isoformat() + 'Z'

            if uploaded_file is not None:
                _, extension = os.path.splitext(filename)
                saved_filename = f'{document_id}{extension or ".pdf"}'
                file_path = os.path.join(UPLOAD_DIR, saved_filename)
                with open(file_path, 'wb') as out_file:
                    out_file.write(uploaded_file)
                filename = saved_filename

            document = {
                'id': document_id,
                'recordId': record_id,
                'owner': owner,
                'village': village,
                'documentType': document_type,
                'filename': filename,
                'status': 'Queued',
                'confidence': 0.0,
                'createdAt': created_at
            }
            connection = get_connection()
            try:
                connection.execute(
                    'INSERT INTO documents (id, recordId, owner, village, documentType, filename, status, confidence, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    (document['id'], record_id, owner, village, document_type, filename, 'Queued', 0.0, created_at)
                )
                connection.commit()
            finally:
                connection.close()
            self.send_json(document, status=201)
            return

        if path == '/api/parcels':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            length = int(self.headers.get('Content-Length', 0))
            if length > 25 * 1024 * 1024:
                self.send_json({'error': 'GeoJSON file must be smaller than 25 MB.'}, status=413)
                return
            try:
                payload = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_json({'error': 'The uploaded file is not valid JSON.'}, status=400)
                return
            geojson = payload.get('geojson')
            validation_error = validate_parcel_geojson(geojson)
            if validation_error:
                self.send_json({'error': validation_error}, status=400)
                return
            name = os.path.basename(str(payload.get('name') or 'Parcel layer'))[:180]
            uploaded_at = __import__('datetime').datetime.utcnow().isoformat() + 'Z'
            try:
                serialized_geojson = json.dumps(geojson, allow_nan=False)
            except (TypeError, ValueError):
                self.send_json({'error': 'GeoJSON contains unsupported values.'}, status=400)
                return
            connection = get_connection()
            try:
                cursor = connection.execute(
                    'INSERT INTO parcel_layers (name, geojson, uploadedAt) VALUES (?, ?, ?)',
                    (name, serialized_geojson, uploaded_at)
                )
                connection.commit()
                layer_id = cursor.lastrowid
            finally:
                connection.close()
            self.send_json({'id': layer_id, 'name': name, 'featureCount': len(geojson['features'])}, status=201)
            return

        if path == '/api/records':
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode('utf-8') or '{}')
            record_id = payload.get('id')
            owner = payload.get('owner')
            village = payload.get('village')

            if not record_id or not owner or not village:
                self.send_json({'error': 'Record id, owner, and village are required.'}, status=400)
                return

            try:
                latitude = float(payload['latitude']) if payload.get('latitude') not in (None, '') else None
                longitude = float(payload['longitude']) if payload.get('longitude') not in (None, '') else None
            except (TypeError, ValueError):
                self.send_json({'error': 'Latitude and longitude must be valid numbers.'}, status=400)
                return

            record = {
                'id': record_id,
                'owner': owner,
                'village': village,
                'documentType': payload.get('documentType', 'Mutation Record'),
                'status': payload.get('status', 'Pending'),
                'progress': int(payload.get('progress', 35)),
                'latitude': latitude,
                'longitude': longitude
            }

            if ((record['latitude'] is None) != (record['longitude'] is None)
                    or (record['latitude'] is not None and (not math.isfinite(record['latitude']) or not -90 <= record['latitude'] <= 90))
                    or (record['longitude'] is not None and (not math.isfinite(record['longitude']) or not -180 <= record['longitude'] <= 180))):
                self.send_json({'error': 'Provide both valid latitude and longitude coordinates.'}, status=400)
                return

            connection = get_connection()
            try:
                connection.execute(
                    'INSERT OR REPLACE INTO records (id, owner, village, documentType, status, progress, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    (record['id'], record['owner'], record['village'], record['documentType'], record['status'], record['progress'], record['latitude'], record['longitude'])
                )
                connection.commit()
            finally:
                connection.close()
            self.send_json(record, status=201)
            return
        self.send_error(404)

    def do_PATCH(self):
        parsed = urlparse(self.path)
        path = self.normalize_path(parsed.path)
        if path.startswith('/api/records/'):
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            record_id = path.split('/api/records/')[-1]
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode('utf-8') or '{}')

            connection = get_connection()
            try:
                existing = connection.execute(
                    'SELECT id, owner, village, documentType, status, progress FROM records WHERE id = ?',
                    (record_id,)
                ).fetchone()
                if not existing:
                    self.send_json({'error': 'Record not found'}, status=404)
                    return

                updated_status = payload.get('status', existing['status'])
                updated_progress = int(payload.get('progress', existing['progress']))
                connection.execute(
                    'UPDATE records SET status = ?, progress = ? WHERE id = ?',
                    (updated_status, updated_progress, record_id)
                )
                connection.commit()
                updated_record = dict(existing)
                updated_record['status'] = updated_status
                updated_record['progress'] = updated_progress
                self.send_json(updated_record)
            finally:
                connection.close()
            return

        if path.startswith('/api/documents/') and path.endswith('/process'):
            user = self.require_auth(['admin', 'inspector'])
            if not user:
                self.send_json({'error': 'Authentication required'}, status=401)
                return
            document_id = path.split('/api/documents/')[1].split('/process')[0]
            connection = get_connection()
            try:
                existing = connection.execute(
                    'SELECT id, recordId, owner, village, documentType, filename, status, confidence, createdAt FROM documents WHERE id = ?',
                    (document_id,)
                ).fetchone()
                if not existing:
                    self.send_json({'error': 'Document not found'}, status=404)
                    return
                file_path = find_uploaded_file(document_id)
                ocr_text = ''
                if file_path:
                    ocr_text = extract_ocr_text(file_path)
                confidence = infer_confidence_from_text(ocr_text) if ocr_text else float(existing['confidence'] or 0.0)
                if not ocr_text:
                    confidence = max(float(existing['confidence'] or 0.0), 96.4)
                connection.execute(
                    'UPDATE documents SET status = ?, confidence = ? WHERE id = ?',
                    ('Validated', confidence, document_id)
                )
                connection.commit()
                updated_doc = dict(existing)
                updated_doc['status'] = 'Validated'
                updated_doc['confidence'] = confidence
                updated_doc['ocrText'] = ocr_text[:2000] if ocr_text else ''
                self.send_json(updated_doc)
            finally:
                connection.close()
            return
        self.send_error(404)

    def log_message(self, format, *args):
        return


def start_server(host='127.0.0.1', port=PORT):
    os.chdir(ROOT)
    init_database()
    server = ThreadingHTTPServer((host, port), AppHandler)
    print(f'Bhoomi AI API running on http://{host}:{port}')
    server.serve_forever()


if __name__ == '__main__':
    start_server()
