const STORAGE_KEY = 'landRecords';
const AUTH_KEY = 'bhoomiAuthToken';
let recordsMap;
let recordsMapLayer;
let parcelMapLayer;
let parcelFeatures = { type: 'FeatureCollection', features: [] };
let mapRecords = [];
let dashboardMap;
let dashboardRecordLayer;
let dashboardParcelLayer;
let liveMapRefreshTimer;
let dashboardMapHasInitialBounds = false;
let currentRecords = [];
let currentDocuments = [];
let recordFilter = '';

async function fetchWithAuth(url, options = {}) {
  const token = localStorage.getItem(AUTH_KEY);
  const headers = { ...(options.headers || {}) };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return fetch(url, {
    ...options,
    headers
  });
}

function showAuth() {
  document.getElementById('authScreen')?.classList.remove('hidden');
  document.getElementById('appShell')?.classList.add('hidden');
}

function hideAuth() {
  document.getElementById('authScreen')?.classList.add('hidden');
  document.getElementById('appShell')?.classList.remove('hidden');
}

async function checkSession() {
  const token = localStorage.getItem(AUTH_KEY);
  if (!token) {
    showAuth();
    return;
  }

  try {
    const response = await fetchWithAuth('/api/me');
    if (response.status === 401) {
      localStorage.removeItem(AUTH_KEY);
      showAuth();
      return;
    }
    if (!response.ok) {
      throw new Error(`Session verification failed (${response.status}).`);
    }

    const payload = await response.json();
    const user = payload.user || {};
    const userName = document.querySelector('.user-name');
    const userRole = document.querySelector('.user-role');
    if (userName) userName.textContent = user.fullname || user.username || 'User';
    if (userRole) userRole.textContent = user.role || 'member';
    hideAuth();
    loadDashboard();
  } catch (error) {
    console.error('Session verification failed:', error);
    showAuth();
    const errorBox = document.getElementById('loginError');
    if (errorBox) errorBox.textContent = 'Could not verify your session. Check the server connection and sign in again.';
  }
}

async function loadDashboard() {
  try {
    const response = await fetchWithAuth('/api/dashboard');
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    const records = Array.isArray(data.records) ? data.records : [];
    const documentResponse = await fetchWithAuth('/api/documents');
    if (!documentResponse.ok) throw new Error(`Documents request failed: ${documentResponse.status}`);
    currentDocuments = await documentResponse.json();
    currentRecords = records;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    renderMetrics(data.metrics);
    renderRecordsTable(records);
    renderRegistryTable(records);
    renderReviewQueue(records, currentDocuments);
    renderReportCards(records);
    renderReportChart(records);
    renderRecordsMap(records, false);
    startLiveMapUpdates();
  } catch (error) {
    console.error('Dashboard data failed to load:', error);
    const fallback = readStoredRecords();
    currentRecords = fallback;
    renderMetrics([]);
    renderRecordsTable(fallback);
    renderRegistryTable(fallback);
    renderReviewQueue(fallback, currentDocuments);
    renderReportCards(fallback);
    renderReportChart(fallback);
    renderRecordsMap(fallback);
    showNotice('Could not refresh data from the server. Showing saved records where available.', true);
    startLiveMapUpdates();
  }
}

function readStoredRecords(baseRecords = []) {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return Array.isArray(stored) ? stored : baseRecords;
  } catch (error) {
    console.error('Saved records could not be read:', error);
    return baseRecords;
  }
}

function renderMetrics(metrics) {
  const grid = document.getElementById('metricsGrid');
  grid.replaceChildren();
  metrics.forEach((metric) => {
    const card = document.createElement('article');
    card.className = 'metric-card';
    const label = document.createElement('div');
    label.className = 'metric-label';
    label.textContent = metric.label;
    const value = document.createElement('p');
    value.className = 'metric-value';
    value.textContent = metric.value;
    const trend = document.createElement('div');
    trend.className = `metric-trend ${metric.trendDirection === 'down' ? 'down' : 'up'}`;
    trend.textContent = metric.change;
    const sparkline = document.createElement('div');
    sparkline.className = 'sparkline';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 80 26');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', metric.line);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', metric.color);
    line.setAttribute('stroke-width', '3');
    line.setAttribute('stroke-linecap', 'round');
    svg.append(line);
    sparkline.append(svg);
    card.append(label, value, trend, sparkline);
    grid.append(card);
  });
}

function renderRecordsTable(records) {
  const table = document.getElementById('recordsTableBody');
  table.replaceChildren();
  records.slice(0, 5).forEach((record) => {
    const row = document.createElement('tr');
    [record.id, record.village, record.owner].forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = value || '';
      row.append(cell);
    });
    const statusCell = document.createElement('td');
    statusCell.append(createStatusBadge(record.status));
    row.append(statusCell);
    const progressCell = document.createElement('td');
    const progressBar = document.createElement('div');
    progressBar.className = 'row-progress';
    const fill = document.createElement('div');
    fill.className = 'row-progress-bar';
    const progress = Math.max(0, Math.min(100, Number(record.progress) || 0));
    fill.style.width = `${progress}%`;
    progressBar.append(fill);
    const progressText = document.createElement('span');
    progressText.textContent = `${progress}%`;
    progressCell.append(progressBar, progressText);
    row.append(progressCell);
    table.append(row);
  });
}

function renderRegistryTable(records) {
  const table = document.getElementById('registryTableBody');
  if (!table) return;
  const query = recordFilter.trim().toLowerCase();
  const filtered = records.filter((record) => [record.id, record.owner, record.village, record.documentType, record.status]
    .some((value) => String(value || '').toLowerCase().includes(query)));
  table.replaceChildren();
  filtered.forEach((record) => {
    const row = document.createElement('tr');
    [record.id, record.village, record.owner, record.documentType || 'Mutation Record'].forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = value || '';
      row.append(cell);
    });
    const statusCell = document.createElement('td');
    statusCell.append(createStatusBadge(record.status));
    row.append(statusCell);
    const actionCell = document.createElement('td');
    const openButton = document.createElement('button');
    openButton.className = 'secondary-btn';
    openButton.type = 'button';
    openButton.textContent = 'Open';
    openButton.addEventListener('click', () => showRecordDetails(record));
    actionCell.append(openButton);
    row.append(actionCell);
    table.append(row);
  });
  if (!filtered.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'empty-table-message';
    cell.textContent = query ? 'No records match this filter.' : 'No records found.';
    row.append(cell);
    table.append(row);
  }
}

function createStatusBadge(status) {
  const badge = document.createElement('span');
  badge.className = `status ${normalizeStatus(status || '')}`;
  badge.textContent = status || 'Unknown';
  return badge;
}

function showRecordDetails(record) {
  const dialog = document.getElementById('recordDialog');
  const title = document.getElementById('recordDialogTitle');
  const content = document.getElementById('recordDialogContent');
  title.textContent = `Record ${record.id}`;
  content.replaceChildren();
  [
    ['Owner', record.owner],
    ['Village', record.village],
    ['Document type', record.documentType || 'Mutation Record'],
    ['Status', record.status],
    ['Progress', `${record.progress}%`],
    ['Coordinates', record.latitude != null && record.longitude != null ? `${record.latitude}, ${record.longitude}` : 'Not provided']
  ].forEach(([label, value]) => {
    const row = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    row.append(strong, document.createTextNode(value || ''));
    content.append(row);
  });
  const attachedDocuments = currentDocuments.filter((document) => document.recordId === record.id);
  const docsHeading = document.createElement('h4');
  docsHeading.textContent = 'Documents';
  content.append(docsHeading);
  if (!attachedDocuments.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No documents uploaded for this record.';
    content.append(empty);
  }
  attachedDocuments.forEach((document) => content.append(createDocumentItem(document)));
  dialog.showModal();
}

async function updateRecordStatus(recordId, action) {
  const updatedStatus = action === 'approve' ? 'Approved' : 'Rejected';
  const updatedProgress = action === 'approve' ? 100 : 45;

  try {
    const response = await fetchWithAuth(`/api/records/${encodeURIComponent(recordId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: updatedStatus, progress: updatedProgress })
    });
    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || `Update failed (${response.status}).`);
    }
    await loadDashboard();
    showNotice(`Record ${recordId} was ${updatedStatus.toLowerCase()}.`);
  } catch (error) {
    showNotice(error.message || 'Failed to update the record.', true);
  }
}

function renderReviewQueue(records, documents = []) {
  const queue = document.getElementById('reviewQueue');
  if (!queue) return;
  queue.replaceChildren();
  records.filter((record) => !['Approved', 'Rejected'].includes(record.status)).slice(0, 4).forEach((record) => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    const details = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = record.id;
    const subtitle = document.createElement('small');
    subtitle.textContent = `${record.village} · ${record.owner}`;
    details.append(title, subtitle);
    const actions = document.createElement('div');
    actions.className = 'queue-actions';
    [['Approve', 'approve', 'btn-approve'], ['Reject', 'reject', 'btn-reject']].forEach(([label, action, className]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = label;
      button.addEventListener('click', () => updateRecordStatus(record.id, action));
      actions.append(button);
    });
    item.append(details, actions);
    queue.append(item);
  });
  documents.forEach((document) => queue.append(createDocumentItem(document)));
  if (!queue.childElementCount) {
    const empty = document.createElement('p');
    empty.className = 'empty-queue-message';
    empty.textContent = 'No records are waiting for review and no documents have been uploaded.';
    queue.append(empty);
  }
}

function createDocumentItem(documentRecord) {
  const item = document.createElement('div');
  item.className = 'queue-item document-item';
  const details = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = documentRecord.filename;
  const subtitle = document.createElement('small');
  subtitle.textContent = `${documentRecord.recordId} · ${documentRecord.status} · OCR is not configured`;
  details.append(title, subtitle);
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'secondary-btn';
  download.textContent = 'Download';
  download.addEventListener('click', () => downloadDocument(documentRecord));
  item.append(details, download);
  return item;
}

async function downloadDocument(documentRecord) {
  try {
    const response = await fetchWithAuth(`/api/documents/${encodeURIComponent(documentRecord.id)}/file`);
    if (!response.ok) throw new Error('Document download failed.');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = documentRecord.filename;
    document.body.append(link);
    link.click();
    window.setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(url);
    }, 1000);
  } catch (error) {
    showNotice(error.message || 'Could not download the document.', true);
  }
}

function renderReportCards(records) {
  const approved = records.filter((r) => r.status === 'Approved').length;
  const pending = records.filter((r) => /pending|review/i.test(r.status)).length;

  document.getElementById('approvedToday').textContent = approved;
  document.getElementById('pendingToday').textContent = pending;
  document.getElementById('ocrConfidence').textContent = 'Not configured';
}

function renderReportChart(records) {
  const chart = document.getElementById('reportChart');
  if (!chart) return;

  const statuses = [
    { label: 'Approved', matches: (record) => record.status === 'Approved' },
    { label: 'Pending / Review', matches: (record) => /pending|review/i.test(record.status) },
    { label: 'Rejected', matches: (record) => record.status === 'Rejected' }
  ];
  const total = records.length || 1;
  chart.replaceChildren();
  statuses.forEach(({ label: status, matches }) => {
    const count = records.filter(matches).length;
    const percent = Math.round((count / total) * 100);
    const row = document.createElement('div');
    row.className = 'bar-row';
    const label = document.createElement('div');
    label.className = 'bar-label';
    label.textContent = status;
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = `${percent}%`;
    track.append(fill);
    const value = document.createElement('div');
    value.className = 'bar-value';
    value.textContent = `${count} (${percent}%)`;
    row.append(label, track, value);
    chart.append(row);
  });
}

function normalizeStatus(status) {
  return String(status || '').toLowerCase().replace(/\s+/g, '-');
}

function showNotice(message, isError = false) {
  const notice = document.getElementById('appNotice');
  notice.textContent = message;
  notice.classList.toggle('error', isError);
  notice.classList.remove('hidden');
  window.clearTimeout(showNotice.timeout);
  showNotice.timeout = window.setTimeout(() => notice.classList.add('hidden'), 6000);
}

function exportRecords() {
  const columns = ['Record ID', 'Owner', 'Village', 'Document Type', 'Status', 'Progress', 'Latitude', 'Longitude'];
  const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = currentRecords.map((record) => [
    record.id, record.owner, record.village, record.documentType, record.status,
    record.progress, record.latitude, record.longitude
  ]);
  const csv = [columns, ...rows].map((row) => row.map(quote).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'bhoomi-land-records.csv';
  document.body.append(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

function bindNavigation() {
  const navButtons = document.querySelectorAll('.nav-item');
  const viewPanels = document.querySelectorAll('.view-panel');
  const pageTitle = document.getElementById('pageTitle');

  navButtons.forEach((button) => {
    button.addEventListener('click', () => {
      navButtons.forEach((b) => b.classList.toggle('active', b === button));
      viewPanels.forEach((panel) => panel.classList.toggle('active', panel.dataset.view === button.dataset.view));
      const titles = {
        dashboard: 'Dashboard',
        records: 'Records',
        map: 'Geospatial Records',
        upload: 'Upload',
        reports: 'Reports',
        settings: 'Settings'
      };
      pageTitle.textContent = titles[button.dataset.view] || 'Dashboard';
      if (button.dataset.view === 'records') renderRegistryTable(currentRecords);
      if (button.dataset.view === 'map') {
        initializeRecordsMap();
        window.setTimeout(() => recordsMap?.invalidateSize(), 0);
        loadParcelFeatures();
      }
    });
  });
}

function bindUploadForms() {
  document.getElementById('uploadForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    addNewRecord(event.currentTarget);
  });

  document.getElementById('uploadFormSecondary')?.addEventListener('submit', (event) => {
    event.preventDefault();
    addNewRecord(event.currentTarget);
  });

  document.getElementById('addRecordButton')?.addEventListener('click', () => {
    document.querySelector('.nav-item[data-view="upload"]').click();
    window.setTimeout(() => document.querySelector('#uploadFormSecondary [name="recordId"]')?.focus(), 0);
  });
}

async function addNewRecord(form) {
  const formData = new FormData(form);
  const file = formData.get('file');
  const hasFile = file instanceof File && Boolean(file.name);
  const fileExtension = hasFile ? file.name.split('.').pop().toLowerCase() : '';
  const fileMimeType = ({
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg'
  })[fileExtension];
  const record = {
    id: String(formData.get('recordId') || '').trim(),
    owner: String(formData.get('owner') || '').trim(),
    village: String(formData.get('village') || '').trim(),
    latitude: formData.get('latitude') ? Number(formData.get('latitude')) : null,
    longitude: formData.get('longitude') ? Number(formData.get('longitude')) : null,
    documentType: formData.get('documentType') || 'Mutation Record',
    status: 'Pending',
    progress: 35
  };

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    if (hasFile && file.size === 0) throw new Error('The selected file is empty.');
    if (hasFile && file.size > 5 * 1024 * 1024) throw new Error('Files must be 5 MB or smaller.');
    if (hasFile && !fileMimeType) throw new Error('Only PDF, PNG, and JPEG files are supported.');

    const response = await fetchWithAuth('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record)
    });

    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || 'Server rejected the record submission.');
    }

    if (hasFile) {
      const binary = new Uint8Array(await file.arrayBuffer());
      let binaryString = '';
      for (let offset = 0; offset < binary.length; offset += 0x8000) {
        binaryString += String.fromCharCode(...binary.subarray(offset, offset + 0x8000));
      }
      const documentResponse = await fetchWithAuth('/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordId: record.id,
          filename: file.name,
          mimeType: fileMimeType,
          fileContent: btoa(binaryString)
        })
      });
      if (!documentResponse.ok) {
        const payload = await documentResponse.json();
        throw new Error(`The record was saved, but the document upload failed: ${payload.error || documentResponse.statusText}`);
      }
    }

    form.reset();
    await loadDashboard();
    showNotice(hasFile
      ? 'Record and document saved. OCR processing is not configured.'
      : 'Record saved successfully.');
  } catch (error) {
    showNotice(error.message || 'Record submission failed.', true);
    await loadDashboard();
  } finally {
    submitButton.disabled = false;
  }
}

function initializeRecordsMap() {
  if (!window.L || recordsMap) return;
  recordsMap = window.L.map('recordsMap').setView([19.7515, 75.7139], 6);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(recordsMap);
  recordsMapLayer = window.L.featureGroup().addTo(recordsMap);
  parcelMapLayer = window.L.geoJSON(parcelFeatures, {
    style: { color: '#176b5b', weight: 2, fillColor: '#3cae85', fillOpacity: 0.2 },
    onEachFeature: (feature, layer) => {
      const properties = feature.properties || {};
      const popup = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = properties.parcel_id || properties.survey_no || properties.surveyNumber || properties.id || 'Parcel';
      const detail = document.createElement('div');
      detail.textContent = properties._layerName || '';
      popup.append(title, detail);
      layer.bindPopup(popup);
    }
  }).addTo(recordsMap);
}

function initializeDashboardMap() {
  if (!window.L || dashboardMap) return;
  dashboardMap = window.L.map('dashboardMap').setView([19.7515, 75.7139], 6);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(dashboardMap);
  dashboardRecordLayer = window.L.featureGroup().addTo(dashboardMap);
  dashboardParcelLayer = createParcelLayer(dashboardMap);
}

function createParcelLayer(map) {
  return window.L.geoJSON(parcelFeatures, {
    style: { color: '#176b5b', weight: 2, fillColor: '#3cae85', fillOpacity: 0.2 },
    onEachFeature: (feature, layer) => {
      const properties = feature.properties || {};
      const popup = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = properties.parcel_id || properties.survey_no || properties.surveyNumber || properties.id || 'Parcel';
      const detail = document.createElement('div');
      detail.textContent = properties._layerName || '';
      popup.append(title, detail);
      layer.bindPopup(popup);
    }
  }).addTo(map);
}

function renderDashboardMap(records, fitMap = false) {
  const element = document.getElementById('dashboardMap');
  if (!element) return;
  initializeDashboardMap();
  if (!dashboardMap || !dashboardRecordLayer || !dashboardParcelLayer) return;

  const georeferenced = records.filter((record) => Number.isFinite(Number(record.latitude))
    && Number.isFinite(Number(record.longitude))
    && record.latitude !== null && record.longitude !== null);
  dashboardRecordLayer.clearLayers();
  georeferenced.forEach((record) => {
    const marker = window.L.marker([Number(record.latitude), Number(record.longitude)]);
    const popup = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = record.id;
    const detail = document.createElement('div');
    detail.textContent = `${record.village} · ${record.owner} · ${record.status}`;
    popup.append(title, detail);
    marker.bindPopup(popup).addTo(dashboardRecordLayer);
  });
  dashboardParcelLayer.clearLayers();
  dashboardParcelLayer.addData(parcelFeatures);

  const totalParcels = parcelFeatures.features.length;
  document.getElementById('dashboardMapCaption').textContent = `${georeferenced.length} of ${records.length} records mapped · ${totalParcels} parcel boundaries · refreshes every 15 seconds`;
  document.getElementById('dashboardMapEmpty').classList.toggle('hidden', georeferenced.length > 0 || totalParcels > 0);

  if (fitMap && !dashboardMapHasInitialBounds) {
    const bounds = window.L.latLngBounds([]);
    [dashboardParcelLayer, dashboardRecordLayer].forEach((layer) => {
      if (layer.getLayers().length) bounds.extend(layer.getBounds());
    });
    if (bounds.isValid()) {
      dashboardMap.fitBounds(bounds.pad(0.08), { maxZoom: 16 });
      dashboardMapHasInitialBounds = true;
    }
  }
}

function startLiveMapUpdates() {
  if (liveMapRefreshTimer) return;
  initializeDashboardMap();
  refreshLiveMap();
  liveMapRefreshTimer = window.setInterval(refreshLiveMap, 15000);
}

async function refreshLiveMap() {
  try {
    const [recordsResponse, parcelsResponse] = await Promise.all([
      fetchWithAuth('/api/records'),
      fetchWithAuth('/api/parcels')
    ]);
    if (!recordsResponse.ok || !parcelsResponse.ok) throw new Error('Live map data is unavailable');
    const [records, parcels] = await Promise.all([recordsResponse.json(), parcelsResponse.json()]);
    parcelFeatures = parcels;
    renderDashboardMap(records, true);
    renderRecordsMap(records);
    document.getElementById('liveMapUpdated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    document.getElementById('liveMapUpdated').textContent = 'Connection unavailable · retrying';
    console.error('Live map refresh failed:', error);
  }
}

function renderRecordsMap(records, fitMap = true) {
  const mapElement = document.getElementById('recordsMap');
  if (!mapElement) return;
  initializeRecordsMap();
  mapRecords = records;

  const georeferenced = records.filter((record) => Number.isFinite(Number(record.latitude))
    && Number.isFinite(Number(record.longitude))
    && record.latitude !== null && record.longitude !== null);
  document.getElementById('mapEmptyState').classList.toggle('hidden', georeferenced.length > 0 || parcelFeatures.features.length > 0);
  document.getElementById('mapCaption').textContent = `${georeferenced.length} of ${records.length} records mapped · ${parcelFeatures.features.length} parcel boundaries`;
  if (!recordsMap || !recordsMapLayer) return;

  recordsMapLayer.clearLayers();
  georeferenced.forEach((record) => {
    const marker = window.L.marker([Number(record.latitude), Number(record.longitude)]);
    const popup = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = record.id;
    const detail = document.createElement('div');
    detail.textContent = `${record.village} · ${record.owner} · ${record.status}`;
    popup.append(title, detail);
    marker.bindPopup(popup).addTo(recordsMapLayer);
  });
  const bounds = window.L.latLngBounds([]);
  [parcelMapLayer, recordsMapLayer].forEach((layer) => {
    if (layer?.getLayers().length) bounds.extend(layer.getBounds());
  });
  if (fitMap && bounds.isValid()) recordsMap.fitBounds(bounds.pad(0.08), { maxZoom: 16 });
}

async function loadParcelFeatures() {
  try {
    const response = await fetchWithAuth('/api/parcels');
    if (!response.ok) throw new Error('Could not load parcel data.');
    parcelFeatures = await response.json();
    if (parcelMapLayer) {
      parcelMapLayer.clearLayers();
      parcelMapLayer.addData(parcelFeatures);
    }
    renderDashboardMap(mapRecords, true);
    renderRecordsMap(mapRecords);
  } catch (error) {
    console.error('Parcel data failed to load:', error);
  }
}

function bindParcelImport() {
  const input = document.getElementById('parcelFileInput');
  const status = document.getElementById('parcelImportStatus');
  input?.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    status.textContent = 'Reading parcel layer...';
    try {
      const geojson = JSON.parse(await file.text());
      if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
        throw new Error('Choose a GeoJSON FeatureCollection.');
      }
      const response = await fetchWithAuth('/api/parcels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, geojson })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Parcel import failed.');
      await loadParcelFeatures();
      status.textContent = `${result.featureCount} parcel features imported from ${result.name}.`;
    } catch (error) {
      status.textContent = error.message || 'Could not import this GeoJSON file.';
    } finally {
      input.value = '';
    }
  });
}

function bindLoginForm() {
  const form = document.getElementById('loginForm');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const errorBox = document.getElementById('loginError');
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Login failed');
      }

      localStorage.setItem(AUTH_KEY, payload.token);
      errorBox.textContent = '';
      const userName = document.querySelector('.user-name');
      const userRole = document.querySelector('.user-role');
      if (userName) userName.textContent = payload.user.fullname || payload.user.username;
      if (userRole) userRole.textContent = payload.user.role || 'member';
      hideAuth();
      await loadDashboard();
    } catch (error) {
      errorBox.textContent = error.message || 'Unable to sign in.';
    } finally {
      submitButton.disabled = false;
    }
  });
}

function bindPageControls() {
  document.getElementById('recordSearch')?.addEventListener('input', (event) => {
    recordFilter = event.currentTarget.value;
    renderRegistryTable(currentRecords);
  });
  document.getElementById('exportRecordsButton')?.addEventListener('click', exportRecords);
  document.getElementById('closeRecordDialog')?.addEventListener('click', () => {
    document.getElementById('recordDialog').close();
  });
  document.getElementById('logoutButton')?.addEventListener('click', () => {
    localStorage.removeItem(AUTH_KEY);
    if (liveMapRefreshTimer) window.clearInterval(liveMapRefreshTimer);
    window.location.reload();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindNavigation();
  bindUploadForms();
  bindLoginForm();
  bindParcelImport();
  bindPageControls();
  checkSession();
});
