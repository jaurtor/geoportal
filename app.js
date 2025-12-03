// Configuración de proyecciones
proj4.defs("EPSG:3857", "+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs");
proj4.defs("EPSG:25830", "+proj=utm +zone=30 +ellps=GRS80 +units=m +no_defs");

// Variables globales
let map = L.map("map").setView([39.32, -0.5], 7);
let currentRasterLayer = null;
let currentBasemap = "osm";
let basemapLayers = {};
let vectorLayers = {};
let currentRasterData = null;
let currentTableName = null;
let pixelTimeout = null;
let currentProjection = "4326";
let isMeasuring = false;
let measurePoints = [];
let measureLayer = L.layerGroup();
let measureLine = null;

// Bounds en EPSG:3857
const boundsMap3857 = {
  "20230514_meantemperature_comvalenciana": [
    [-170029.5724387232, 4557921.9614732563],
    [76681.0429848633, 4980761.9401388783]
  ],
  "20230514_precipitation_comvalenciana": [
    [-170029.5724387232, 4557921.9614732563],
    [76681.0429848633, 4980761.9401388783]
  ]
};

// Configuración de capas raster
const rasterConfig = {
  "20230514_meantemperature_comvalenciana": { 
    title: "Temperatura (°C)",
    unit: "°C",
    type: "temperature"
  },
  "20230514_precipitation_comvalenciana": { 
    title: "Precipitación (l/m²)",
    unit: "l/m²",
    type: "precipitation"
  }
};

// ==================== INICIALIZACIÓN MAPAS BASE ====================
basemapLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap",
  maxZoom: 19
}).addTo(map);

basemapLayers.satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { attribution: "© Esri", maxZoom: 18 }
);

basemapLayers.pnoa = L.tileLayer.wms(
  "https://www.ign.es/wms-inspire/pnoa-ma",
  { layers: "OI.OrthoimageCoverage", format: "image/jpeg", transparent: false, attribution: "© IGN" }
);

// ==================== CONTROLES ====================
const scaleControl = L.control({ position: 'bottomright' });
scaleControl.onAdd = function() {
  const div = L.DomUtil.create('div', 'scale-numeric');
  
  map.on('zoomend', function() {
    const zoom = map.getZoom();
    const scale = 591657600 / Math.pow(2, zoom);
    const roundedScale = Math.round(scale / Math.pow(10, Math.floor(Math.log10(scale)))) * Math.pow(10, Math.floor(Math.log10(scale)));
    div.textContent = '1:' + Math.round(roundedScale).toLocaleString('es-ES');
  });
  
  map.fire('zoomend');
  return div;
};
scaleControl.addTo(map);

// ==================== EVENTOS DEL MAPA ====================
map.on('mousemove', (e) => {
  let lat = e.latlng.lat;
  let lng = e.latlng.lng;

  if (currentProjection === "3857") {
    const coords = proj4("EPSG:4326", "EPSG:3857", [lng, lat]);
    document.getElementById("coordX").textContent = coords[0].toFixed(2);
    document.getElementById("coordY").textContent = coords[1].toFixed(2);
  } else {
    document.getElementById("coordX").textContent = lat.toFixed(4);
    document.getElementById("coordY").textContent = lng.toFixed(4);
  }
});

map.on('click', function(e) {
  if (isMeasuring) {
    if (measurePoints.length < 2) {
      addMeasurePoint(e.latlng);
      if (measurePoints.length === 1) {
        document.getElementById("measureInstruction").textContent = "Haz clic en el segundo punto";
      }
    }
    return;
  }

  if (!currentRasterData || !currentRasterData.bounds3857) return;

  const { width, height, data: rawData, bounds3857 } = currentRasterData;
  const latlng = e.latlng;
  const coords3857 = proj4("EPSG:4326", "EPSG:3857", [latlng.lng, latlng.lat]);

  const x = coords3857[0];
  const y = coords3857[1];

  const [minX, minY] = bounds3857[0];
  const [maxX, maxY] = bounds3857[1];

  if (x < minX || x > maxX || y < minY || y > maxY) return;

  const relX = (x - minX) / (maxX - minX);
  const relY = (y - minY) / (maxY - minY);

  const pixelX = Math.floor(relX * width);
  const pixelY = Math.floor((1 - relY) * height);

  if (pixelX < 0 || pixelX >= width || pixelY < 0 || pixelY >= height) return;

  const pixelIndex = pixelY * width + pixelX;
  const value = rawData[pixelIndex];
  const pixelUnit = document.getElementById("pixelUnit");
  const pixelDisplayValue = document.getElementById("pixelDisplayValue");
  const pixelDisplay = document.getElementById("pixelDisplay");

  if (value === null || isNaN(value)) {
    pixelDisplayValue.textContent = "Sin datos";
    pixelUnit.textContent = "";
  } else {
    pixelDisplayValue.textContent = value.toFixed(2);
    const config = rasterConfig[currentTableName];
    pixelUnit.textContent = config.title;
  }

  clearTimeout(pixelTimeout);
  pixelDisplay.style.display = "block";
  
  pixelTimeout = setTimeout(() => {
    pixelDisplay.style.display = "none";
  }, 2000);
});

// ==================== FUNCIONES VECTORIALES ====================
async function loadVectorLayers() {
  try {
    loadVectorLayer("101puntos_25830");
  } catch (error) {
    document.getElementById("vectorStatus").innerHTML = `<span class="err">✗</span> ${error.message}`;
  }
}

async function loadVectorLayer(tableName) {
  try {
    document.getElementById("vectorStatus").innerHTML = `<span class="spinner"></span> Cargando...`;
    
    const response = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/${tableName}?select=*&limit=1000`, {
      headers: {
        'apikey': CONFIG.API_KEY,
        'Authorization': `Bearer ${CONFIG.API_KEY}`
      }
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = await response.json();
    
    if (rows.length === 0) {
      document.getElementById("vectorStatus").innerHTML = `<span class="err">✗</span> Sin datos`;
      return;
    }

    const features = rows.map(row => {
      const geom = row.geom;
      const [lon, lat] = proj4("EPSG:25830", "EPSG:4326", geom.coordinates);
      
      let props = { ...row };
      delete props.geom;
      
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: props
      };
    });

    const layerGroup = L.geoJSON({
      type: "FeatureCollection",
      features: features
    }, {
      pointToLayer: (f, latlng) =>
        L.circleMarker(latlng, {
          radius: 6,
          fillColor: '#58a6ff',
          color: '#238636',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.8
        }),
      onEachFeature: (f, layer) => {
        let popupHtml = `<div class="popup-content"><h4>${tableName}</h4>`;
        for (const [k, v] of Object.entries(f.properties)) {
          popupHtml += `<div class="popup-attr"><span class="attr-key">${k}:</span> <span class="attr-value">${v}</span></div>`;
        }
        popupHtml += `</div>`;
        layer.bindPopup(popupHtml);
      }
    });

    if (vectorLayers[tableName]) map.removeLayer(vectorLayers[tableName]);
    vectorLayers[tableName] = layerGroup;
    layerGroup.addTo(map);
    map.fitBounds(layerGroup.getBounds());

    document.getElementById("vectorStatus").innerHTML = `<span class="ok">✓</span> Cargado`;
  } catch (error) {
    document.getElementById("vectorStatus").innerHTML = `<span class="err">✗</span> ${error.message}`;
  }
}

// ==================== FUNCIONES RASTER ====================
async function loadRaster(tableName) {
  try {
    document.getElementById("rasterStatus").innerHTML = `<span class="spinner"></span> Cargando...`;
    
    const response = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/get_raster_data?apikey=${CONFIG.API_KEY}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${CONFIG.API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ table_name: tableName })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !data[0]) throw new Error("Sin datos");

    const raster = data[0];
    const { width, height, data: rawData } = raster;

    document.getElementById("rasterStatus").innerHTML = `<span class="spinner"></span> Renderizando...`;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);

    const config = rasterConfig[tableName];
    const isPrecipitation = config.type === 'precipitation';
    
    let validValues = isPrecipitation 
      ? rawData.filter(v => v !== null && !isNaN(v) && v > 1)
      : rawData.filter(v => v !== null && !isNaN(v) && v !== 0);

    if (validValues.length === 0) throw new Error("Sin valores válidos");

    let min = validValues[0], max = validValues[0], sum = 0;
    for (let v of validValues) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    const mean = sum / validValues.length;

    document.getElementById("statMin").textContent = min.toFixed(2);
    document.getElementById("statMax").textContent = max.toFixed(2);
    document.getElementById("statMean").textContent = mean.toFixed(2);
    document.getElementById("statsPanel").classList.add('visible');

    drawHistogram(validValues, min, max);

    const range = max - min || 1;
    for (let i = 0; i < rawData.length; i++) {
      const val = rawData[i];
      const shouldRender = isPrecipitation ? (val !== null && !isNaN(val) && val > 1) : (val !== null && !isNaN(val) && val !== 0);

      if (shouldRender) {
        const norm = (val - min) / range;
        const clamped = Math.max(0, Math.min(1, norm));
        const [r, g, b] = getColor(clamped);
        
        imageData.data[i * 4] = r;
        imageData.data[i * 4 + 1] = g;
        imageData.data[i * 4 + 2] = b;
        imageData.data[i * 4 + 3] = 255;
      } else {
        imageData.data[i * 4 + 3] = 0;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    const imageUrl = canvas.toDataURL("image/png");
    
    const bounds3857 = boundsMap3857[tableName];
    const southWest = L.CRS.EPSG3857.unproject(L.point(bounds3857[0]));
    const northEast = L.CRS.EPSG3857.unproject(L.point(bounds3857[1]));

    const boundsLatLng = [southWest, northEast];

    if (currentRasterLayer) map.removeLayer(currentRasterLayer);
    currentRasterLayer = L.imageOverlay(imageUrl, boundsLatLng, { opacity: 0.8, crossOrigin: 'anonymous' });
    currentRasterLayer.addTo(map);

    currentRasterData = { ...raster, validValues, min, max, bounds3857, boundsLatLng };
    currentTableName = tableName;

    showRasterLegend(tableName, min, max);

    document.getElementById("rasterStatus").innerHTML = `<span class="ok">✓</span> Cargado`;
  } catch (error) {
    document.getElementById("rasterStatus").innerHTML = `<span class="err">✗</span> ${error.message}`;
  }
}

function getColor(value) {
  if (value < 0.25) {
    const t = value * 4;
    return [0, Math.floor(t * 255), 255];
  } else if (value < 0.5) {
    const t = (value - 0.25) * 4;
    return [0, 255, Math.floor((1 - t) * 255)];
  } else if (value < 0.75) {
    const t = (value - 0.5) * 4;
    return [Math.floor(t * 255), 255, 0];
  } else {
    const t = (value - 0.75) * 4;
    return [255, Math.floor((1 - t) * 255), 0];
  }
}

function showRasterLegend(tableName, min, max) {
  const config = rasterConfig[tableName];
  document.getElementById("legendTitle").textContent = config.title;

  const gradient = document.getElementById("legendGradient");
  const colors = [];
  for (let i = 0; i <= 100; i += 10) {
    const norm = i / 100;
    const [r, g, b] = getColor(norm);
    colors.push(`rgb(${r},${g},${b}) ${i}%`);
  }
  gradient.style.background = `linear-gradient(to right, ${colors.join(', ')})`;

  const scale = document.getElementById("legendScale");
  scale.innerHTML = `
    <span>${min.toFixed(1)}</span>
    <span>${((min + max) / 2).toFixed(1)}</span>
    <span>${max.toFixed(1)}</span>
  `;

  document.getElementById("rasterLegend").classList.remove('hidden');
  document.getElementById("opacityControl").classList.add('visible');
}

function drawHistogram(validValues, min, max) {
  const canvas = document.getElementById("histogramCanvas");
  const ctx = canvas.getContext("2d");
  const bins = 30;
  const range = max - min || 1;
  const histogram = new Array(bins).fill(0);

  for (let v of validValues) {
    const binIdx = Math.floor((v - min) / range * bins);
    if (binIdx >= 0 && binIdx < bins) histogram[binIdx]++;
  }

  const maxCount = Math.max(...histogram);
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#58a6ff";

  for (let i = 0; i < bins; i++) {
    const barHeight = (histogram[i] / maxCount) * canvas.height;
    const x = (i / bins) * canvas.width;
    const width = canvas.width / bins;
    ctx.fillRect(x, canvas.height - barHeight, width - 1, barHeight);
  }

  canvas.classList.add('visible');
}

// ==================== FUNCIONES DE MEDICIÓN ====================
function startMeasuring() {
  isMeasuring = true;
  measurePoints = [];
  measureLayer.clearLayers();
  measureLayer.addTo(map);
  document.getElementById("measurePanel").classList.add("visible");
  document.getElementById("measureInstruction").textContent = "Haz clic en el primer punto";
  document.getElementById("measureResult").textContent = "-";
  map.getContainer().style.cursor = 'crosshair';
}

function stopMeasuring() {
  isMeasuring = false;
  measureLayer.clearLayers();
  measureLayer.removeFrom(map);
  document.getElementById("measurePanel").classList.remove("visible");
  map.getContainer().style.cursor = '';
}

function clearMeasurement() {
  measurePoints = [];
  measureLayer.clearLayers();
  document.getElementById("measureInstruction").textContent = "Haz clic en dos puntos del mapa";
  document.getElementById("measureResult").textContent = "-";
}

function calculateDistance(point1, point2) {
  const R = 6371000;
  const lat1 = point1.lat * Math.PI / 180;
  const lat2 = point2.lat * Math.PI / 180;
  const dLat = (point2.lat - point1.lat) * Math.PI / 180;
  const dLon = (point2.lng - point1.lng) * Math.PI / 180;

  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c;
}

function formatDistance(meters) {
  if (meters < 1000) {
    return `${meters.toFixed(1)} m`;
  } else {
    return `${(meters / 1000).toFixed(2)} km`;
  }
}

function addMeasurePoint(latlng) {
  const marker = L.circleMarker(latlng, {
    radius: 8,
    fillColor: '#58a6ff',
    color: '#238636',
    weight: 2,
    opacity: 1,
    fillOpacity: 0.8,
    className: 'measure-point'
  });
  
  const label = L.divIcon({
    className: 'measure-label',
    html: `<div style="color: white; font-weight: bold; font-size: 10px; text-align: center;">${measurePoints.length + 1}</div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });
  
  const labelMarker = L.marker(latlng, { icon: label });
  
  marker.addTo(measureLayer);
  labelMarker.addTo(measureLayer);
  measurePoints.push(latlng);
  
  if (measurePoints.length === 2) {
    if (measureLine) {
      measureLayer.removeLayer(measureLine);
    }
    
    measureLine = L.polyline([measurePoints[0], measurePoints[1]], {
      color: '#58a6ff',
      weight: 3,
      opacity: 0.8,
      dashArray: '5, 5',
      className: 'measure-line'
    });
    
    measureLine.addTo(measureLayer);
    
    const distance = calculateDistance(measurePoints[0], measurePoints[1]);
    document.getElementById("measureResult").textContent = formatDistance(distance);
    document.getElementById("measureInstruction").textContent = "Distancia calculada";
  }
}

// ==================== EVENT LISTENERS ====================
document.querySelectorAll('.raster-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.raster-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadRaster(btn.dataset.layer);
  });
});

document.getElementById("opacitySlider").addEventListener('input', (e) => {
  const opacity = e.target.value / 100;
  document.getElementById("opacityValue").textContent = e.target.value + '%';
  if (currentRasterLayer) currentRasterLayer.setOpacity(opacity);
});

document.querySelectorAll('.basemap-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const newBasemap = btn.dataset.basemap;
    if (basemapLayers[currentBasemap]) map.removeLayer(basemapLayers[currentBasemap]);
    basemapLayers[newBasemap].addTo(map);
    basemapLayers[newBasemap].bringToBack();
    currentBasemap = newBasemap;
    document.querySelectorAll('.basemap-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.getElementById("compassBtn").addEventListener("click", () => {
  map.setView(map.getCenter(), map.getZoom(), { animate: true });
});

document.getElementById("projectionSelect").addEventListener("change", (e) => {
  currentProjection = e.target.value;
});

document.getElementById("measureBtn").addEventListener("click", startMeasuring);
document.getElementById("clearMeasureBtn").addEventListener("click", clearMeasurement);
document.getElementById("closeMeasureBtn").addEventListener("click", stopMeasuring);

// ==================== INICIALIZACIÓN ====================
loadVectorLayers();