# Bhoomi AI

An early-stage land-record digitisation and validation prototype for Smart India Hackathon 2026 (problem statement SIH26018).

The web app provides a record registry, review actions, document storage, CSV export, and a map for coordinate-backed records and imported GeoJSON parcels.

## Run the web prototype

Requirements: Node.js and npm.

```powershell
npm.cmd install
npm.cmd start
```

Open [http://localhost:3000](http://localhost:3000).

Demo sign-ins:

- `admin` / `admin123`
- `inspector` / `inspector123`

These are public demo credentials for local development only. Do not use them for a public or production deployment.

## Data and current limitations

- Records are stored in SQLite under `data/`; uploaded documents are stored under `data/uploads/`.
- Imported parcel GeoJSON is saved locally and excluded from Git.
- The browser app currently uses the Node.js/Express backend.
- `server.py` is a separate processing prototype. Its OCR/GIS flows are not integrated with the current Node-backed browser workflow.
- OCR is not configured in the web prototype. Uploaded documents are stored for review; they are not automatically read or validated.
- Demo authentication and sample metrics are not production security or verified performance claims.

Performance figures in the product requirements document are proposed pilot targets, not measured results.
