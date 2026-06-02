
    const STORAGE_KEY = "quantum-cost-control-local-v1";

    let state = {
      materiasPrimas: [],
      recetas: [],
      activeRecipeId: null,
      warehouses: [],
      payrollInfo: {},
      productionReports: [],
      productionHistoryRaw: [],
      employees: [],
      logsByMonth: {}
    };

    let aiPendingRecipes = [];
    let aiPendingTasks = [];
    let liveCosteoTimer = null;
    let dashboardTypeFilter = "panaderia";
    let dashCostPieChart = null;
    let dashCompareChart = null;
    let prodCostTrendChart = null;
    let prodVolumeChart = null;
    let prodVolumeDonutChart = null;
    let dashboardCompareSelectedIds = new Set();
    let dashboardCurrentFilteredRecipeIds = [];
    let reportSelectedRecipeIds = new Set();
    let pendingProductionNeeds = null;
    let unmappedHistorySelections = {};
    let lastHistoryImportMeta = null;
    let lastHistoryImportRejectedRows = [];
    let linkedSecureFileHandle = null;
    let linkedSecurePassphrase = "";
    let linkedSecureAutoSaveEnabled = false;
    let secureAutoSaveTimer = null;
    let linkedHistoryDbFileHandle = null;
    let historyDbAutoSaveEnabled = false;
    let historyDbAutoSaveTimer = null;

    function normalizeRecipeType(value) {
      return String(value || "").toLowerCase() === "pasteleria" ? "pasteleria" : "panaderia";
    }

    function formatRecipeTypeLabel(value) {
      return normalizeRecipeType(value) === "pasteleria" ? "PastelerÃ­a" : "PanaderÃ­a";
    }

    function loadState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          state = {
            materiasPrimas: Array.isArray(parsed.materiasPrimas) ? parsed.materiasPrimas : [],
            recetas: Array.isArray(parsed.recetas) ? parsed.recetas : [],
            activeRecipeId: parsed.activeRecipeId || null,
            warehouses: Array.isArray(parsed.warehouses) ? parsed.warehouses : [],
            payrollInfo: parsed.payrollInfo && typeof parsed.payrollInfo === "object" ? parsed.payrollInfo : {},
            productionReports: Array.isArray(parsed.productionReports) ? parsed.productionReports : [],
            productionHistoryRaw: Array.isArray(parsed.productionHistoryRaw) ? parsed.productionHistoryRaw : [],
            employees: Array.isArray(parsed.employees) ? parsed.employees : [],
            logsByMonth: parsed.logsByMonth && typeof parsed.logsByMonth === "object" ? parsed.logsByMonth : {}
          };
        }
      } catch {
        alert("No se pudo leer el estado local guardado. Se cargarÃ¡ un estado limpio.");
      }
    }

    function isStateLikeObject(obj) {
      return !!(obj && typeof obj === "object" && Array.isArray(obj.recetas) && Array.isArray(obj.materiasPrimas));
    }

    function findLegacyStateFromAnyLocalStorageKey() {
      try {
        const direct = localStorage.getItem(STORAGE_KEY);
        if (direct) {
          const parsed = JSON.parse(direct);
          if (isStateLikeObject(parsed)) return parsed;
        }

        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (!k) continue;
          const raw = localStorage.getItem(k);
          if (!raw || raw.length < 20) continue;
          try {
            const parsed = JSON.parse(raw);
            if (isStateLikeObject(parsed)) return parsed;
            if (parsed && typeof parsed === "object" && isStateLikeObject(parsed.state)) return parsed.state;
          } catch {
            // ignore non-json localStorage keys
          }
        }
      } catch {
        return null;
      }
      return null;
    }

    async function tryAutoBridgeFromFileOrigin() {
      if (location.protocol !== "file:") return;
      const markerKey = "qcc-file-bridge-done-v1";
      if (sessionStorage.getItem(markerKey) === "1") return;

      const legacyState = findLegacyStateFromAnyLocalStorageKey();
      if (!legacyState) return;

      try {
        const res = await fetch("http://localhost:8001/api/recovery-state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: location.href, state: legacyState })
        });
        if (!res.ok) return;
        sessionStorage.setItem(markerKey, "1");
        alert("MigraciÃ³n automÃ¡tica lista: datos enviados a localhost. Ahora abre http://localhost:8001 para ver tus recetas.");
      } catch {
        // localhost not available; skip silently
      }
    }

    async function tryAutoImportRecoveryStateOnHttp() {
      if (!/^https?:$/i.test(location.protocol)) return;

      let hasCurrent = false;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          hasCurrent = isStateLikeObject(parsed) && ((parsed.recetas?.length || 0) > 0 || (parsed.materiasPrimas?.length || 0) > 0);
        }
      } catch {
        hasCurrent = false;
      }
      if (hasCurrent) return;

      try {
        const res = await fetch("/api/recovery-state", { method: "GET" });
        if (!res.ok) return;
        const payload = await res.json();
        const imported = payload?.state && typeof payload.state === "object" ? payload.state : payload;
        if (!isStateLikeObject(imported)) return;

        restoreStateFromImported(imported);
        await fetch("/api/recovery-state", { method: "DELETE" });
        alert("Datos recuperados automÃ¡ticamente en localhost.");
      } catch {
        // no recovery payload available
      }
    }

    function saveState() {
      state.warehouses = Array.isArray(state.warehouses) ? state.warehouses : [];
      state.payrollInfo = state.payrollInfo && typeof state.payrollInfo === "object" ? state.payrollInfo : {};
      state.productionReports = Array.isArray(state.productionReports) ? state.productionReports : [];
      state.productionHistoryRaw = Array.isArray(state.productionHistoryRaw) ? state.productionHistoryRaw : [];
      state.employees = Array.isArray(state.employees) ? state.employees : [];
      state.logsByMonth = state.logsByMonth && typeof state.logsByMonth === "object" ? state.logsByMonth : {};
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      scheduleSecureSystemAutoSave();
      scheduleHistoryDbAutoSave();
    }

    function ensureWarehouses() {
      if (!Array.isArray(state.warehouses) || !state.warehouses.length) {
        state.warehouses = [{ id: uid(), nombre: "Almacen Principal" }];
      }
      return state.warehouses;
    }

    function getWarehouseName(id) {
      return ensureWarehouses().find(w => w.id === id)?.nombre || "Almacen";
    }

    function ensureMpStockMap(mp) {
      if (!mp || typeof mp !== "object") return {};
      mp.stockByWarehouse = (mp.stockByWarehouse && typeof mp.stockByWarehouse === "object") ? mp.stockByWarehouse : {};
      return mp.stockByWarehouse;
    }

    function ensureRecipeFinishedStockMap(recipe) {
      if (!recipe || typeof recipe !== "object") return {};
      recipe.finishedStockByWarehouse = (recipe.finishedStockByWarehouse && typeof recipe.finishedStockByWarehouse === "object") ? recipe.finishedStockByWarehouse : {};
      return recipe.finishedStockByWarehouse;
    }

    function getMpStock(mp, warehouseId) {
      const map = ensureMpStockMap(mp);
      return Number(map[warehouseId] || 0);
    }

    function setMpStock(mp, warehouseId, value) {
      const map = ensureMpStockMap(mp);
      map[warehouseId] = Number.isFinite(Number(value)) ? Number(value) : 0;
    }

    function getFinishedStock(recipe, warehouseId) {
      const map = ensureRecipeFinishedStockMap(recipe);
      return Number(map[warehouseId] || 0);
    }

    function setFinishedStock(recipe, warehouseId, value) {
      const map = ensureRecipeFinishedStockMap(recipe);
      map[warehouseId] = Number.isFinite(Number(value)) ? Number(value) : 0;
    }

    function upsertDashboardCompareSelectionFromFiltered(filtered) {
      if (!Array.isArray(filtered) || !filtered.length) {
        dashboardCompareSelectedIds = new Set();
        return;
      }
      const filteredIds = new Set(filtered.map(r => r.id));
      dashboardCompareSelectedIds.forEach(id => {
        if (!filteredIds.has(id)) dashboardCompareSelectedIds.delete(id);
      });
      if (!dashboardCompareSelectedIds.size) {
        filtered.slice(0, 6).forEach(r => dashboardCompareSelectedIds.add(r.id));
      }
    }

    function toggleDashboardCompareRecipe(recipeId, checked) {
      if (checked) dashboardCompareSelectedIds.add(recipeId);
      else dashboardCompareSelectedIds.delete(recipeId);
      renderDashboardCharts();
    }

    function selectAllDashboardCompareRecipes() {
      dashboardCompareSelectedIds = new Set(dashboardCurrentFilteredRecipeIds);
      renderDashboardCharts();
    }

    function selectFirstDashboardCompareRecipeOnly() {
      if (!dashboardCurrentFilteredRecipeIds.length) {
        dashboardCompareSelectedIds = new Set();
        renderDashboardCharts();
        return;
      }
      dashboardCompareSelectedIds = new Set([dashboardCurrentFilteredRecipeIds[0]]);
      renderDashboardCharts();
    }

    function renderDashboardCharts() {
      const filtered = state.recetas.filter(r => normalizeRecipeType(r.tipo) === dashboardTypeFilter);
      dashboardCurrentFilteredRecipeIds = filtered.map(r => r.id);
      const modeSelect = document.getElementById("dashChartMode");
      const pieSelect = document.getElementById("dashPieRecipe");
      const compareSelector = document.getElementById("dashCompareSelector");
      const chartTypeSelect = document.getElementById("dashCompareChartType");
      const lineMetricBox = document.getElementById("dashLineMetricBox");
      const compareBulkActions = document.getElementById("dashCompareBulkActions");
      const pieBox = document.getElementById("dashPieBox");
      const compareBox = document.getElementById("dashCompareBox");
      const pieCanvas = document.getElementById("dashCostPieChart");
      const compareCanvas = document.getElementById("dashCompareChart");
      if (!modeSelect || !pieSelect || !compareSelector || !chartTypeSelect || !lineMetricBox || !compareBulkActions || !pieCanvas || !compareCanvas || !pieBox || !compareBox) return;

      if (typeof Chart === "undefined") {
        compareSelector.innerHTML = "<div class='muted'>No se pudo cargar Chart.js.</div>";
        return;
      }

      pieSelect.innerHTML = filtered.map(r => `<option value="${r.id}">${escapeHtml(r.nombre || "Sin nombre")}</option>`).join("");
      upsertDashboardCompareSelectionFromFiltered(filtered);

      const currentPieId = filtered.some(r => r.id === pieSelect.value) ? pieSelect.value : (filtered[0]?.id || "");
      pieSelect.value = currentPieId;

      compareSelector.innerHTML = filtered.length
        ? filtered.map(r => {
          const checked = dashboardCompareSelectedIds.has(r.id) ? "checked" : "";
          return `<label class='option-row' style='padding:.35rem .45rem;'>
            <input type='checkbox' data-compare-id='${r.id}' ${checked}>
            <span>${escapeHtml(r.nombre || "Sin nombre")}</span>
          </label>`;
        }).join("")
        : "<div class='muted'>No hay recetas para comparar.</div>";

      compareSelector.querySelectorAll("input[data-compare-id]").forEach(el => {
        el.addEventListener("change", () => toggleDashboardCompareRecipe(el.dataset.compareId, el.checked));
      });

      if (dashCostPieChart) {
        dashCostPieChart.destroy();
        dashCostPieChart = null;
      }
      if (dashCompareChart) {
        dashCompareChart.destroy();
        dashCompareChart = null;
      }

      const mode = modeSelect.value === "compare" ? "compare" : "pie";
      pieBox.classList.toggle("hidden", mode !== "pie");
      compareBox.classList.toggle("hidden", mode !== "compare");
      const chartType = ["bar", "line", "radar"].includes(chartTypeSelect.value) ? chartTypeSelect.value : "bar";
      lineMetricBox.classList.toggle("hidden", mode !== "compare" || chartType !== "line");
      compareBulkActions.classList.toggle("hidden", mode !== "compare" || !["bar", "line"].includes(chartType));

      if (mode === "pie" && currentPieId) {
        const recipe = state.recetas.find(r => r.id === currentPieId);
        if (recipe) {
          const cs = ensureCostStructure(recipe);
          const totals = computeCostStructureTotals(cs);
          const distributionData = [
            Number(totals.costoReceta || 0),
            Number(totals.cargaFabril || 0),
            Number(totals.materialEmpaque || 0)
          ];
          const distributionTotal = distributionData.reduce((acc, n) => acc + n, 0);
          dashCostPieChart = new Chart(pieCanvas.getContext("2d"), {
            type: "pie",
            data: {
              labels: ["Costo Receta", "Carga Fabril", "Material de Empaque"],
              datasets: [{
                data: distributionData,
                backgroundColor: ["#16a34a", "#f59e0b", "#2563eb"]
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: { position: "bottom" },
                tooltip: {
                  callbacks: {
                    label: (ctx) => {
                      const value = Number(ctx.parsed || 0);
                      const pct = distributionTotal > 0 ? (value / distributionTotal) * 100 : 0;
                      return `${ctx.label}: B/. ${value.toFixed(4)} (${pct.toFixed(2)}%)`;
                    },
                    afterBody: () => [
                      `TOTAL COSTO x UNIDAD: B/. ${Number(totals.totalCostoUnidad || 0).toFixed(4)}`,
                      `TOTAL COSTO UNITARIO: B/. ${Number(totals.totalCostoUnitario || 0).toFixed(4)}`
                    ]
                  }
                }
              }
            }
          });
        }
      }

      const selected = filtered.filter(r => dashboardCompareSelectedIds.has(r.id));
      if (mode === "compare" && selected.length) {
        const labels = selected.map(r => r.nombre || "Sin nombre");
        const totalsList = selected.map(r => computeCostStructureTotals(ensureCostStructure(r)));
        const metricCatalog = {
          pvUnitario: {
            label: "PV Unitario",
            data: totalsList.map(t => Number(t.pvUnitario || 0)),
            borderColor: "#2563eb",
            backgroundColor: "rgba(37,99,235,0.3)",
            yAxisID: "yMoney"
          },
          mbUnitario: {
            label: "Utilidad B/.",
            data: totalsList.map(t => Number(t.mbUnitario || 0)),
            borderColor: "#f59e0b",
            backgroundColor: "rgba(245,158,11,0.3)",
            yAxisID: "yMoney"
          },
          mbUnitPct: {
            label: "Utilidad %",
            data: totalsList.map(t => Number(t.mbUnitPct || 0)),
            borderColor: "#ef4444",
            backgroundColor: "rgba(239,68,68,0.35)",
            yAxisID: "yPercent"
          },
          pcUnitario: {
            label: "Costo Producto B/.",
            data: totalsList.map(t => Number(t.pcUnitario || 0)),
            borderColor: "#059669",
            backgroundColor: "rgba(5,150,105,0.3)",
            yAxisID: "yMoney"
          }
        };

        const defaultMetrics = ["mbUnitPct", "pvUnitario", "pcUnitario"];
        const checkedLineMetrics = Array.from(document.querySelectorAll("input[data-line-metric]"))
          .filter(el => el.checked)
          .map(el => el.dataset.lineMetric)
          .filter(key => !!metricCatalog[key]);
        const metricsToUse = chartType === "line"
          ? (checkedLineMetrics.length ? checkedLineMetrics : ["pvUnitario"])
          : defaultMetrics;
        if (chartType === "line" && !checkedLineMetrics.length) {
          const fallback = document.querySelector("input[data-line-metric='pvUnitario']");
          if (fallback) fallback.checked = true;
        }

        const datasets = metricsToUse.map(key => ({ ...metricCatalog[key] }));
        const showPercentAxis = datasets.some(d => d.yAxisID === "yPercent");
        const showMoneyAxis = datasets.some(d => d.yAxisID === "yMoney");
        const chartScales = {
          yMoney: {
            type: "linear",
            position: showPercentAxis ? "right" : "left",
            beginAtZero: true,
            grid: { drawOnChartArea: !showPercentAxis }
          },
          yPercent: {
            type: "linear",
            position: "left",
            beginAtZero: true,
            ticks: { callback: (value) => `${value}%` },
            grid: { drawOnChartArea: false }
          }
        };

        if (!showMoneyAxis) delete chartScales.yMoney;
        if (!showPercentAxis) delete chartScales.yPercent;

        dashCompareChart = new Chart(compareCanvas.getContext("2d"), {
          type: chartType,
          data: {
            labels,
            datasets
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: chartScales
          }
        });
      }
    }

    function applyBatchAdjustmentByIngredient() {
      const receta = currentRecipe();
      if (!receta) {
        alert("Selecciona una receta antes de aplicar ajuste por batch.");
        return;
      }
      const idx = Number(document.getElementById("batchRefIngredient").value);
      const available = Number(document.getElementById("batchRefAvailable").value || 0);
      const ingredientes = Array.isArray(receta.ingredientes) ? receta.ingredientes : [];

      if (!Number.isInteger(idx) || idx < 0 || idx >= ingredientes.length) {
        alert("Selecciona un ingrediente de referencia valido.");
        return;
      }
      if (!(Number.isFinite(available) && available > 0)) {
        alert("Ingresa una cantidad disponible mayor a cero.");
        return;
      }

      const refActual = Number(ingredientes[idx].cantidad || 0);
      if (!(Number.isFinite(refActual) && refActual > 0)) {
        alert("La cantidad actual del ingrediente de referencia no es valida.");
        return;
      }

      const factor = available / refActual;
      ingredientes.forEach(i => {
        const q = Number(i.cantidad || 0);
        if (Number.isFinite(q)) i.cantidad = Number((q * factor).toFixed(4));
        const c = Number(i.costoReceta);
        if (Number.isFinite(c) && c >= 0) i.costoReceta = Number((c * factor).toFixed(4));
      });

      receta.produccion = Math.max(1, Number((Number(receta.produccion || 1) * factor).toFixed(4)));
      receta.costeo = receta.costeo || {};
      if (Number.isFinite(Number(receta.costeo.unidadesDeseadas || 0)) && Number(receta.costeo.unidadesDeseadas || 0) > 0) {
        receta.costeo.unidadesDeseadas = Number((Number(receta.costeo.unidadesDeseadas) * factor).toFixed(4));
      } else {
        receta.costeo.unidadesDeseadas = receta.produccion;
      }
      if (Number.isFinite(Number(receta.costeo.batchDeseadoGr || 0)) && Number(receta.costeo.batchDeseadoGr || 0) > 0) {
        receta.costeo.batchDeseadoGr = Number((Number(receta.costeo.batchDeseadoGr) * factor).toFixed(4));
      }

      calculateIngredientPercentages(receta);
      document.getElementById("txtBatchFactor").textContent = `Factor aplicado: ${factor.toFixed(4)}x`;
      saveState();
      renderAll();
      alert("Ajuste proporcional aplicado en toda la receta.");
    }

    function uid() {
      return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    }

    function currentRecipe() {
      return state.recetas.find(r => r.id === state.activeRecipeId) || null;
    }

    function switchView(view) {
      document.querySelectorAll("[id^='view-']").forEach(s => s.classList.add("hidden"));
      document.getElementById("view-" + view).classList.remove("hidden");

      document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      document.querySelector(`.nav-btn[data-view='${view}']`).classList.add("active");

      const refresh = (typeof renderAll === "function")
        ? renderAll
        : (typeof window.renderAll === "function" ? window.renderAll : null);
      if (refresh) refresh();
    }

    function renderKpis() {
      document.getElementById("kpiRecetas").textContent = state.recetas.length;
      document.getElementById("kpiInsumos").textContent = state.materiasPrimas.length;
    }

    function renderRecipes() {
      const cont = document.getElementById("listaRecetas");
      const filtered = state.recetas.filter(r => normalizeRecipeType(r.tipo) === dashboardTypeFilter);

      if (!filtered.length) {
        cont.innerHTML = "<div class='panel'>No hay recetas todavÃ­a.</div>";
        return;
      }

      cont.innerHTML = filtered.map(r => {
        const nombre = escapeHtml(r.nombre || "Sin nombre");
        const estado = (r.ingredientes || []).length ? "EDICION" : "BORRADOR";
        const tipoLabel = formatRecipeTypeLabel(r.tipo);
        const cs = ensureCostStructure(r);
        const totals = computeCostStructureTotals(cs);
        return `<article class='recipe-card'>
          <div style='display:flex; justify-content:space-between; align-items:center; gap:.5rem;'>
            <strong>${nombre}</strong>
            <span class='badge'>${estado}</span>
          </div>
          <p style='color:#64748b; font-size:.85rem; margin:.35rem 0;'>Tipo de receta: <strong>${tipoLabel}</strong></p>
          <p style='color:#64748b; font-size:.9rem;'>${escapeHtml(r.descripcion || "Sin descripciÃ³n")}</p>
          <div class='muted' style='font-size:.86rem;'>PC unitario: B/. ${totals.pcUnitario.toFixed(4)}</div>
          <div class='muted' style='font-size:.86rem;'>Precio de venta: B/. ${totals.pvUnitario.toFixed(4)}</div>
          <div class='muted' style='font-size:.86rem; margin-bottom:.5rem;'>Utilidad %: ${totals.mbUnitPct.toFixed(2)}%</div>
          <div style='display:flex; gap:.5rem;'>
            <button class='btn primary' onclick='openRecipe("${r.id}")'>Abrir</button>
            <button class='btn' onclick='downloadRecipePdfById("${r.id}")'>Ficha PDF</button>
            <button class='btn' onclick='deleteRecipe("${r.id}")'>Eliminar</button>
          </div>
        </article>`;
      }).join("");
    }

    function renderInventory() {
      const cont = document.getElementById("listaMP");
      const meta = document.getElementById("inventarioSearchMeta");
      const term = String(document.getElementById("inventarioSearch")?.value || "").trim().toLowerCase();
      const allItems = Array.isArray(state.materiasPrimas) ? state.materiasPrimas : [];
      const items = term
        ? allItems.filter(mp => {
          const name = String(mp.nombre || "").toLowerCase();
          const provider = String(mp.proveedor || "").toLowerCase();
          const unit = String(mp.unidadBase || "").toLowerCase();
          return name.includes(term) || provider.includes(term) || unit.includes(term);
        })
        : allItems;

      if (meta) {
        meta.textContent = term
          ? `Mostrando ${items.length} de ${allItems.length} resultados`
          : `Mostrando ${items.length} resultados`;
      }

      if (!items.length) {
        cont.innerHTML = "<div class='list-item'>No hay materias primas cargadas.</div>";
        return;
      }

      cont.innerHTML = items.map(mp => {
        const costo = Number(mp.precioEmpaque || 0).toFixed(2);
        const warehouses = ensureWarehouses();
        const stockLine = warehouses
          .map(w => `${w.nombre}: ${getMpStock(mp, w.id).toFixed(2)}`)
          .join(" | ");
        return `<div class='list-item'>
          <div>
            <strong>${escapeHtml(mp.nombre)}</strong>
            <div style='color:#64748b; font-size:.84rem;'>${escapeHtml(mp.proveedor || "Sin proveedor")} | ${escapeHtml(mp.unidadBase || "un")}</div>
            <div class='muted' style='font-size:.8rem;'>Stock por almacÃ©n: ${escapeHtml(stockLine || "0")}</div>
          </div>
          <div style='display:flex; align-items:center; gap:.45rem;'>
            <span>$${costo}</span>
            <button class='btn' onclick='editMp("${mp.id}")'>Editar</button>
            <button class='btn' onclick='deleteMp("${mp.id}")'>X</button>
          </div>
        </div>`;
      }).join("");

      const select = document.getElementById("ingMp");
      select.innerHTML = state.materiasPrimas.map(mp => `<option value='${mp.id}'>${escapeHtml(mp.nombre)}</option>`).join("");
    }

    function getMonthKey(dateLike = new Date()) {
      const d = new Date(dateLike);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      return `${y}-${m}`;
    }

    function logSystem(moduleName, action, entity, detail = {}) {
      state.logsByMonth = (state.logsByMonth && typeof state.logsByMonth === "object") ? state.logsByMonth : {};
      const monthKey = getMonthKey();
      if (!Array.isArray(state.logsByMonth[monthKey])) state.logsByMonth[monthKey] = [];
      const row = {
        ts: new Date().toISOString(),
        module: moduleName,
        action,
        entity,
        detail
      };
      state.logsByMonth[monthKey].push(row);
      if (state.logsByMonth[monthKey].length > 1200) {
        state.logsByMonth[monthKey] = state.logsByMonth[monthKey].slice(-1200);
      }
    }

    function csvEscape(value) {
      const s = String(value ?? "");
      if (/[",\n;]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
      return s;
    }

    function downloadCsv(fileName, headers, rows) {
      const csv = [headers.join(","), ...rows.map(r => r.map(csvEscape).join(","))].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    }

    function parseSimpleCsvObjects(text) {
      const rows = String(text || "").split(/\r?\n/).filter(r => r.trim());
      if (!rows.length) return [];
      const delimiter = rows[0].includes(";") ? ";" : ",";
      const headers = rows[0].split(delimiter).map(h => h.trim());
      return rows.slice(1).map(line => {
        const cols = line.split(delimiter).map(c => c.trim());
        const obj = {};
        headers.forEach((h, i) => { obj[h] = cols[i] || ""; });
        return obj;
      });
    }

    function getCurrentPeriodRange() {
      const period = document.getElementById("prodSummaryPeriod")?.value || "month";
      const baseRaw = document.getElementById("prodSummaryDate")?.value;
      const base = baseRaw ? new Date(`${baseRaw}T00:00:00`) : new Date();
      let start = new Date(base);
      let end = new Date(base);

      if (period === "day") {
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
      } else if (period === "week") {
        const day = start.getDay();
        const deltaToMonday = (day + 6) % 7;
        start.setDate(start.getDate() - deltaToMonday);
        start.setHours(0, 0, 0, 0);
        end = new Date(start);
        end.setDate(end.getDate() + 6);
        end.setHours(23, 59, 59, 999);
      } else {
        start = new Date(base.getFullYear(), base.getMonth(), 1);
        end = new Date(base.getFullYear(), base.getMonth() + 1, 0, 23, 59, 59, 999);
      }

      return { start, end, period, base };
    }

    function getDayKey(dateLike = new Date()) {
      const d = new Date(dateLike);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function getProductionMixByDay(dayKey, extraQtyByRecipe = null) {
      const key = String(dayKey || getDayKey());
      const reports = Array.isArray(state.productionReports) ? state.productionReports : [];
      const byRecipe = {};

      reports.forEach(r => {
        const reportDay = getDayKey(r.fecha || new Date());
        if (reportDay !== key) return;
        const recipeId = String(r.recipeId || "");
        if (!recipeId) return;
        const qty = Math.max(0, Number(r.requestedQty || 0));
        if (!(qty > 0)) return;
        if (!byRecipe[recipeId]) byRecipe[recipeId] = 0;
        byRecipe[recipeId] += qty;
      });

      if (extraQtyByRecipe && typeof extraQtyByRecipe === "object") {
        Object.entries(extraQtyByRecipe).forEach(([recipeId, qtyRaw]) => {
          const qty = Math.max(0, Number(qtyRaw || 0));
          if (!recipeId || !(qty > 0)) return;
          if (!byRecipe[recipeId]) byRecipe[recipeId] = 0;
          byRecipe[recipeId] += qty;
        });
      }

      const scores = {};
      let totalScore = 0;
      Object.entries(byRecipe).forEach(([recipeId, qty]) => {
        const recipe = state.recetas.find(r => r.id === recipeId);
        const cs = recipe ? ensureCostStructure(recipe) : null;
        const unitsPerPack = Math.max(1, Number(cs?.unidadesPorEmpaque || 1));
        const packed = qty / unitsPerPack;
        const score = qty + packed;
        scores[recipeId] = score;
        totalScore += score;
      });

      return { byRecipe, scores, totalScore };
    }

    function getLastProductionCfRecord(recipeId) {
      const reports = Array.isArray(state.productionReports) ? state.productionReports : [];
      const candidates = reports
        .filter(r => r.recipeId === recipeId && Number.isFinite(Number(r.cfUnitCost)))
        .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());
      return candidates[0] || null;
    }

    function getCostSourceLabel(sourceType) {
      const labels = {
        planificacion_manual: "PlanificaciÃ³n manual",
        import_csv_produccion: "ImportaciÃ³n CSV producciÃ³n",
        import_historico_mapeado: "ImportaciÃ³n histÃ³rica mapeada",
        historico_asociado_lote: "HistÃ³rico asociado en lote",
        load_bd_historica: "Carga de BD histÃ³rica",
        sin_traza: "Sin traza"
      };
      return labels[sourceType] || sourceType || "Sin traza";
    }

    function resolveProductionCostSource(report) {
      const explicit = String(report?.costSourceType || "").trim();
      if (explicit) return explicit;

      if (report?.externalKey && report?.invoiceNumber) return "import_historico_mapeado";
      if (Array.isArray(report?.requirements) && report.requirements.length) return "planificacion_manual";
      if (report?.externalKey) return "load_bd_historica";
      return "sin_traza";
    }

    function summarizeSourceCostMap(sourceCostMap, totalCost) {
      const entries = Object.entries(sourceCostMap || {})
        .filter(([, value]) => Number(value || 0) > 0)
        .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
      if (!entries.length) return "Origen de costo: sin datos";

      const top = entries.slice(0, 3).map(([type, value]) => {
        const pct = totalCost > 0 ? ((Number(value || 0) / totalCost) * 100) : 0;
        return `${getCostSourceLabel(type)} ${pct.toFixed(1)}%`;
      });
      return `Origen de costo: ${top.join(" | ")}`;
    }

    function resolveCfForProduction(recipe, dayKey, extraQtyByRecipe = null) {
      const cs = ensureCostStructure(recipe);
      const generic = calculateCfFromConfig(cs, recipe.tipo);
      const mix = getProductionMixByDay(dayKey, extraQtyByRecipe);
      const score = Number(mix.scores[recipe.id] || 0);

      if (mix.totalScore > 0 && score > 0) {
        const dynamicPct = (score / mix.totalScore) * 100;

        // Build a shared CF pool for the day and then distribute it by each product's participation.
        let dailyCfPool = 0;
        const byRecipeQty = mix.byRecipe && typeof mix.byRecipe === "object" ? mix.byRecipe : {};
        Object.entries(byRecipeQty).forEach(([recipeId, qtyRaw]) => {
          const qty = Math.max(0, Number(qtyRaw || 0));
          if (!(qty > 0)) return;
          const recipeRef = state.recetas.find(r => r.id === recipeId);
          if (!recipeRef) return;
          const csRef = ensureCostStructure(recipeRef);
          const genericRef = calculateCfFromConfig(csRef, recipeRef.tipo);
          const cfUnitRef = Math.max(0, Number(genericRef.cfFinal || 0));
          dailyCfPool += (cfUnitRef * qty);
        });

        const qtyCurrent = Math.max(0, Number(mix.byRecipe?.[recipe.id] || 0));
        const allocatedTotal = dailyCfPool * (dynamicPct / 100);
        const allocatedUnit = qtyCurrent > 0 ? (allocatedTotal / qtyCurrent) : Number(generic.cfFinal || 0);

        return {
          mode: "dynamic",
          cfUnit: Number.isFinite(allocatedUnit) ? Math.max(0, allocatedUnit) : Number(generic.cfFinal || 0),
          cfSharePct: dynamicPct,
          energiaPct: dynamicPct,
          infraPct: dynamicPct,
          source: "produccion-dia"
        };
      }

      const last = getLastProductionCfRecord(recipe.id);
      if (last) {
        return {
          mode: "last",
          cfUnit: Number(last.cfUnitCost || 0),
          cfSharePct: Number(last.cfSharePct || 100),
          energiaPct: Number(last.energiaPct || 0),
          infraPct: Number(last.infraPct || 0),
          source: "historico"
        };
      }

      return {
        mode: "generic",
        cfUnit: Number(generic.cfFinal || 0),
        cfSharePct: 100,
        energiaPct: Number(cs.cfCalc?.energiaAsignacionPct || 100),
        infraPct: Number(cs.cfCalc?.infraAsignacionPct || 100),
        source: "generico"
      };
    }

    function getReportBaseUnitCostWithoutCf(report) {
      const explicitBase = Number(report?.baseUnitCostNoCf);
      if (Number.isFinite(explicitBase) && explicitBase >= 0) return explicitBase;

      const unit = Number(report?.unitCost || 0);
      const cf = Math.max(0, Number(report?.cfUnitCost || 0));
      if (Number.isFinite(unit) && unit >= cf) return Math.max(0, unit - cf);

      const qty = Math.max(0, Number(report?.requestedQty || 0));
      const total = Math.max(0, Number(report?.totalConsumedCost || 0));
      if (qty > 0) {
        const inferredUnit = total / qty;
        if (Number.isFinite(inferredUnit) && inferredUnit >= cf) return Math.max(0, inferredUnit - cf);
      }

      return Math.max(0, Number.isFinite(unit) ? unit : 0);
    }

    function applyResolvedCfToReport(report, cfResolved) {
      const qty = Math.max(0, Number(report?.requestedQty || 0));
      const baseUnit = getReportBaseUnitCostWithoutCf(report);
      const cfUnit = Math.max(0, Number(cfResolved?.cfUnit || 0));
      const unit = baseUnit + cfUnit;
      const total = unit * qty;

      report.baseUnitCostNoCf = Number(baseUnit.toFixed(6));
      report.unitCost = Number(unit.toFixed(6));
      report.estimatedCost = Number(total.toFixed(6));
      report.totalConsumedCost = Number(total.toFixed(6));
      report.cfUnitCost = Number(cfUnit.toFixed(6));
      report.cfSharePct = Number(Math.max(0, Number(cfResolved?.cfSharePct || 0)).toFixed(6));
      report.energiaPct = Number(Math.max(0, Number(cfResolved?.energiaPct || 0)).toFixed(6));
      report.infraPct = Number(Math.max(0, Number(cfResolved?.infraPct || 0)).toFixed(6));
      report.cfSource = String(cfResolved?.source || "generico");
    }

    function rebalanceProductionDay(dayKey) {
      const key = String(dayKey || getDayKey());
      const reports = Array.isArray(state.productionReports) ? state.productionReports : [];
      const reportsInDay = reports.filter(r => getDayKey(r.fecha || new Date()) === key && String(r.recipeId || "").trim());
      if (!reportsInDay.length) return 0;

      reportsInDay.forEach(report => {
        const recipe = state.recetas.find(x => x.id === report.recipeId);
        if (!recipe) return;
        const cfResolved = resolveCfForProduction(recipe, key, null);
        applyResolvedCfToReport(report, cfResolved);
      });

      return reportsInDay.length;
    }

    function getHistoryGroupKey(row) {
      const product = normalizeNameForMatch(row?.productName || "sin-producto");
      const code = normalizeNameForMatch(row?.itemCode || "sin-codigo");
      return `${product}|${code}`;
    }

    function resolveRecipeForHistoryRow(row) {
      const itemCode = String(row?.itemCode || "").trim();
      const productName = String(row?.productName || "").trim();
      const byCode = itemCode
        ? state.recetas.find(x => normalizeNameForMatch(x.codigo || x.itemCode || x.sku || x.codigoInterno || "") === normalizeNameForMatch(itemCode))
        : null;
      const byName = productName
        ? state.recetas.find(x => normalizeNameForMatch(x.nombre || "") === normalizeNameForMatch(productName))
        : null;
      return byCode || byName || null;
    }

    function getRecipePvUnit(recipe) {
      if (!recipe) return 0;
      const cs = ensureCostStructure(recipe);
      const pv = Number(cs?.pvUnitario || 0);
      return Number.isFinite(pv) ? Math.max(0, pv) : 0;
    }

    function getUnmappedHistoryGroups() {
      state.productionHistoryRaw = Array.isArray(state.productionHistoryRaw) ? state.productionHistoryRaw : [];
      const groups = {};

      state.productionHistoryRaw.forEach(row => {
        const recipeExists = row?.recipeId ? state.recetas.some(r => r.id === row.recipeId) : false;
        if (recipeExists) return;

        const key = getHistoryGroupKey(row);
        if (!groups[key]) {
          groups[key] = {
            key,
            productName: String(row?.productName || "Sin nombre").trim() || "Sin nombre",
            itemCode: String(row?.itemCode || "").trim(),
            rows: 0,
            units: 0,
            total: 0,
            pvUnit: 0,
            sampleDate: String(row?.invoiceDate || row?.fecha || "")
          };
        }

        const qty = Math.max(0, Number(row?.units || 0));
        const recipeForPv = resolveRecipeForHistoryRow(row);
        const pvUnit = getRecipePvUnit(recipeForPv);
        const total = qty * pvUnit;
        groups[key].rows += 1;
        groups[key].units += qty;
        groups[key].total += total;
        groups[key].pvUnit = pvUnit;
      });

      return Object.values(groups)
        .sort((a, b) => a.productName.localeCompare(b.productName));
    }

    function setUnmappedHistoryGroupRecipe(groupKey, recipeId) {
      unmappedHistorySelections[groupKey] = String(recipeId || "");
    }

    function renderUnmappedHistoryView() {
      const summary = document.getElementById("prodUnmappedHistorySummary");
      const table = document.getElementById("prodUnmappedHistoryTable");
      if (!summary || !table) return;

      const groupsAll = getUnmappedHistoryGroups();
      const filter = String(document.getElementById("prodUnmappedHistoryFilter")?.value || "").trim().toLowerCase();
      const groups = filter
        ? groupsAll.filter(g => String(g.productName || "").toLowerCase().includes(filter) || String(g.itemCode || "").toLowerCase().includes(filter))
        : groupsAll;

      if (!groupsAll.length) {
        summary.textContent = "No hay histÃ³ricos pendientes de asociaciÃ³n.";
        table.innerHTML = "<div class='muted' style='padding:.6rem;'>Todos los histÃ³ricos estÃ¡n mapeados a receta.</div>";
        return;
      }

      if (!groups.length) {
        summary.textContent = `Pendientes: ${groupsAll.length} grupos | filtro sin coincidencias`;
        table.innerHTML = "<div class='muted' style='padding:.6rem;'>No hay resultados para el filtro aplicado.</div>";
        return;
      }

      const totalRows = groups.reduce((acc, g) => acc + g.rows, 0);
      const totalUnits = groups.reduce((acc, g) => acc + g.units, 0);
      summary.textContent = `Pendientes: ${groups.length}/${groupsAll.length} grupos | ${totalRows} filas | ${totalUnits.toFixed(4)} unidades`;

      const recipeOptions = state.recetas.map(r => `<option value='${r.id}'>${escapeHtml(r.nombre || "Sin nombre")}</option>`).join("");
      const body = groups.map(g => {
        const suggested = state.recetas.find(r => normalizeNameForMatch(r.nombre || "") === normalizeNameForMatch(g.productName));
        const selected = Object.prototype.hasOwnProperty.call(unmappedHistorySelections, g.key)
          ? String(unmappedHistorySelections[g.key] || "")
          : String(suggested?.id || "");
        unmappedHistorySelections[g.key] = selected;
        return `<tr>
          <td>${escapeHtml(g.productName)}</td>
          <td>${escapeHtml(g.itemCode || "-")}</td>
          <td>${g.rows}</td>
          <td>${g.units.toFixed(4)}</td>
          <td>B/. ${g.total.toFixed(4)}</td>
          <td>B/. ${Number(g.pvUnit || 0).toFixed(4)}</td>
          <td>
            <select onchange='setUnmappedHistoryGroupRecipe("${escapeHtml(g.key)}", this.value)'>
              <option value=''>Sin asociar</option>
              ${recipeOptions}
            </select>
          </td>
        </tr>`;
      }).join("");

      table.innerHTML = `<table class='tech-table'><thead><tr><th>Producto histÃ³rico</th><th>CÃ³digo</th><th>Filas</th><th>Unidades</th><th>Total (PVU)</th><th>PV Unitario</th><th>Asociar a receta</th></tr></thead><tbody>${body}</tbody></table>`;

      groups.forEach(g => {
        const select = table.querySelector(`select[onchange='setUnmappedHistoryGroupRecipe("${escapeHtml(g.key)}", this.value)']`);
        if (select) select.value = String(unmappedHistorySelections[g.key] || "");
      });
    }

    function getMappedHistoryGroups() {
      state.productionHistoryRaw = Array.isArray(state.productionHistoryRaw) ? state.productionHistoryRaw : [];
      const groups = {};

      state.productionHistoryRaw.forEach(row => {
        const recipe = row?.recipeId ? state.recetas.find(r => r.id === row.recipeId) : null;
        if (!recipe) return;

        const key = `${getHistoryGroupKey(row)}|${recipe.id}`;
        if (!groups[key]) {
          groups[key] = {
            key,
            productName: String(row?.productName || "Sin nombre").trim() || "Sin nombre",
            itemCode: String(row?.itemCode || "").trim(),
            recipeName: String(recipe?.nombre || row?.recipeName || "Sin nombre").trim() || "Sin nombre",
            rows: 0,
            units: 0,
            total: 0,
            pvUnit: 0,
            sampleDate: String(row?.invoiceDate || row?.fecha || "")
          };
        }

        const qty = Math.max(0, Number(row?.units || 0));
        const pvUnit = getRecipePvUnit(recipe);
        const total = qty * pvUnit;
        groups[key].rows += 1;
        groups[key].units += qty;
        groups[key].total += total;
        groups[key].pvUnit = pvUnit;
      });

      return Object.values(groups)
        .sort((a, b) => a.productName.localeCompare(b.productName));
    }

    function renderMappedHistoryView() {
      const summary = document.getElementById("prodMappedHistorySummary");
      const table = document.getElementById("prodMappedHistoryTable");
      if (!summary || !table) return;

      const groupsAll = getMappedHistoryGroups();
      const filter = String(document.getElementById("prodMappedHistoryFilter")?.value || "").trim().toLowerCase();
      const groups = filter
        ? groupsAll.filter(g =>
            String(g.productName || "").toLowerCase().includes(filter)
            || String(g.itemCode || "").toLowerCase().includes(filter)
            || String(g.recipeName || "").toLowerCase().includes(filter)
          )
        : groupsAll;

      if (!groupsAll.length) {
        summary.textContent = "No hay histÃ³ricos mapeados todavÃ­a.";
        table.innerHTML = "<div class='muted' style='padding:.6rem;'>AÃºn no hay lÃ­neas histÃ³ricas vinculadas a recetas.</div>";
        return;
      }

      if (!groups.length) {
        summary.textContent = `Mapeados: ${groupsAll.length} grupos | filtro sin coincidencias`;
        table.innerHTML = "<div class='muted' style='padding:.6rem;'>No hay resultados para el filtro aplicado.</div>";
        return;
      }

      const totalRows = groups.reduce((acc, g) => acc + g.rows, 0);
      const totalUnits = groups.reduce((acc, g) => acc + g.units, 0);
      summary.textContent = `Mapeados: ${groups.length}/${groupsAll.length} grupos | ${totalRows} filas | ${totalUnits.toFixed(4)} unidades`;

      const body = groups.map(g => `<tr>
        <td>${escapeHtml(g.productName)}</td>
        <td>${escapeHtml(g.itemCode || "-")}</td>
        <td>${escapeHtml(g.recipeName || "-")}</td>
        <td>${g.rows}</td>
        <td>${g.units.toFixed(4)}</td>
        <td>B/. ${g.total.toFixed(4)}</td>
        <td>B/. ${Number(g.pvUnit || 0).toFixed(4)}</td>
      </tr>`).join("");

      table.innerHTML = `<table class='tech-table'><thead><tr><th>Producto histÃ³rico</th><th>CÃ³digo</th><th>Receta mapeada</th><th>Filas</th><th>Unidades</th><th>Total (PVU)</th><th>PV Unitario</th></tr></thead><tbody>${body}</tbody></table>`;
    }

    function renderHistoryRejectDiagnostics() {
      const meta = document.getElementById("prodHistoryRejectMeta");
      const table = document.getElementById("prodHistoryRejectTable");
      if (!meta || !table) return;

      const rows = Array.isArray(lastHistoryImportRejectedRows) ? lastHistoryImportRejectedRows : [];
      if (!lastHistoryImportMeta) {
        meta.textContent = "AÃºn no hay importaciones histÃ³ricas para diagnosticar.";
        table.innerHTML = "<div class='muted' style='padding:.6rem;'>Importa un archivo histÃ³rico para ver por quÃ© se rechazan lÃ­neas.</div>";
        return;
      }

      const m = lastHistoryImportMeta;
      meta.textContent = `Ãšltima importaciÃ³n: leÃ­das ${m.read || 0}, nuevas ${m.rawAdded || 0}, sin mapear ${m.unmapped || 0}, rechazadas sin producto ${m.rejectedMissingProduct || 0}, rechazadas sin unidades ${m.rejectedMissingUnits || 0}, duplicadas ${m.rejectedDuplicate || 0}.`;

      if (!rows.length) {
        table.innerHTML = "<div class='muted' style='padding:.6rem;'>No hubo lÃ­neas rechazadas en la Ãºltima importaciÃ³n.</div>";
        return;
      }

      const body = rows.map(r => `<tr>
        <td>${Number(r.row || 0)}</td>
        <td>${escapeHtml(r.reason || "-")}</td>
        <td>${escapeHtml(r.productName || "-")}</td>
        <td>${escapeHtml(r.itemCode || "-")}</td>
        <td>${escapeHtml(String(r.unitsRaw ?? ""))}</td>
        <td>${Number(r.unitsParsed || 0).toFixed(6)}</td>
        <td>${escapeHtml(String(r.unitPriceRaw ?? ""))}</td>
        <td>${escapeHtml(String(r.lineTotalRaw ?? ""))}</td>
        <td>${escapeHtml(r.invoiceNumber || "-")}</td>
      </tr>`).join("");

      table.innerHTML = `<div class='muted' style='padding:0 0 .45rem 0;'>Mostrando ${rows.length} lÃ­neas rechazadas de la Ãºltima importaciÃ³n.</div><table class='tech-table'><thead><tr><th>Fila</th><th>Motivo</th><th>Producto</th><th>CÃ³digo</th><th>Unidades (crudo)</th><th>Unidades (parseado)</th><th>Precio U. (crudo)</th><th>Total (crudo)</th><th>Factura</th></tr></thead><tbody>${body}</tbody></table>`;
    }

    function recalculateRealCostsAllProducts() {
      const reports = Array.isArray(state.productionReports) ? state.productionReports : [];
      const byRecipe = {};
      reports.forEach(r => {
        const recipeId = String(r.recipeId || "");
        if (!recipeId) return;
        const qty = Math.max(0, Number(r.requestedQty || 0));
        const total = Math.max(0, Number(r.totalConsumedCost || 0));
        if (!byRecipe[recipeId]) byRecipe[recipeId] = { qty: 0, total: 0 };
        byRecipe[recipeId].qty += qty;
        byRecipe[recipeId].total += total;
      });

      Object.entries(byRecipe).forEach(([recipeId, agg]) => {
        if (!(agg.qty > 0)) return;
        const recipe = state.recetas.find(x => x.id === recipeId);
        if (!recipe) return;
        const cs = ensureCostStructure(recipe);
        cs.realUnitCostRef = Number((agg.total / agg.qty).toFixed(4));
        cs.realUnitCostRefPeriod = "historico_acumulado";
        cs.realUnitCostRefBaseDate = null;
        cs.realUnitCostRefUpdatedAt = new Date().toISOString();
      });
    }

    function associateUnmappedHistoryInBatch() {
      const groups = getUnmappedHistoryGroups();
      if (!groups.length) return alert("No hay histÃ³ricos pendientes por asociar.");

      const groupToRecipe = {};
      groups.forEach(g => {
        const recipeId = String(unmappedHistorySelections[g.key] || "").trim();
        if (recipeId) groupToRecipe[g.key] = recipeId;
      });

      const selectedGroupKeys = Object.keys(groupToRecipe);
      if (!selectedGroupKeys.length) {
        alert("Selecciona al menos una receta en la tabla para asociar pendientes.");
        return;
      }

      const rowsToAssociate = (state.productionHistoryRaw || []).filter(row => {
        const recipeExists = row?.recipeId ? state.recetas.some(r => r.id === row.recipeId) : false;
        if (recipeExists) return false;
        const groupKey = getHistoryGroupKey(row);
        return Boolean(groupToRecipe[groupKey]);
      });

      if (!rowsToAssociate.length) {
        alert("No hay filas vÃ¡lidas para asociar con la selecciÃ³n actual.");
        return;
      }

      const qtyByDayAndRecipe = {};
      rowsToAssociate.forEach(row => {
        const groupKey = getHistoryGroupKey(row);
        const recipeId = groupToRecipe[groupKey];
        const day = String(row.dayKey || getDayKey(row.invoiceDate || row.fecha || new Date()));
        const qty = Math.max(0, Number(row.units || 0));
        if (!(qty > 0)) return;
        qtyByDayAndRecipe[day] = qtyByDayAndRecipe[day] || {};
        qtyByDayAndRecipe[day][recipeId] = (qtyByDayAndRecipe[day][recipeId] || 0) + qty;
      });

      state.productionReports = Array.isArray(state.productionReports) ? state.productionReports : [];
      const knownProd = new Set(state.productionReports.map(r => String(r.externalKey || "")));

      let associated = 0;
      let addedToProduction = 0;

      rowsToAssociate.forEach(row => {
        const groupKey = getHistoryGroupKey(row);
        const recipeId = groupToRecipe[groupKey];
        const recipe = state.recetas.find(r => r.id === recipeId);
        if (!recipe) return;

        row.recipeId = recipe.id;
        row.recipeName = recipe.nombre || "Sin nombre";
        associated += 1;

        const extKey = String(row.externalKey || "");
        if (!extKey || knownProd.has(extKey)) return;

        const dayKey = String(row.dayKey || getDayKey(row.invoiceDate || row.fecha || new Date()));
        const cfResolved = resolveCfForProduction(recipe, dayKey, qtyByDayAndRecipe[dayKey] || null);
        const cs = ensureCostStructure(recipe);
        const unitsPerPack = Math.max(1, Number(cs.unidadesPorEmpaque || 1));

        const qty = Math.max(0, Number(row.units || 0));
        const total = Math.max(0, Number(row.lineTotal || (qty * Number(row.unitPrice || 0))));
        const unit = qty > 0 ? (total / qty) : Math.max(0, Number(row.unitPrice || 0));

        state.productionReports.unshift({
          id: uid(),
          fecha: row.invoiceDate || row.fecha || new Date().toISOString(),
          recipeId: recipe.id,
          recipeName: recipe.nombre || "Sin nombre",
          requestedQty: qty,
          factor: 1,
          requirements: [],
          estimatedCost: total,
          existingPt: 0,
          warehouseMpId: state.warehouses[0]?.id || null,
          warehousePtId: state.warehouses[0]?.id || null,
          unitCost: unit,
          baseUnitCostNoCf: Math.max(0, unit - Number(cfResolved.cfUnit || 0)),
          packedQty: qty / unitsPerPack,
          cfUnitCost: Number(cfResolved.cfUnit || 0),
          cfSharePct: Number(cfResolved.cfSharePct || 0),
          energiaPct: Number(cfResolved.energiaPct || 0),
          infraPct: Number(cfResolved.infraPct || 0),
          cfSource: cfResolved.source || "historico",
          totalConsumedCost: total,
          costSourceType: "historico_asociado_lote",
          costSourceLabel: getCostSourceLabel("historico_asociado_lote"),
          externalKey: extKey,
          invoiceNumber: row.invoiceNumber || "",
          lot: row.lot || "",
          itemCode: row.itemCode || "",
          warehouseName: row.warehouse || ""
        });
        knownProd.add(extKey);
        addedToProduction += 1;
      });

      const affectedDays = Object.keys(qtyByDayAndRecipe || {});
      affectedDays.forEach(day => rebalanceProductionDay(day));

      recalculateRealCostsAllProducts();
      logSystem("produccion", "associate", "history_unmapped_batch", { associated, addedToProduction, groups: selectedGroupKeys.length });
      saveState();
      renderAll();
      generateProductionConsumptionReport();
      alert(`AsociaciÃ³n completada. HistÃ³ricos asociados: ${associated}. Nuevos registros en producciÃ³n: ${addedToProduction}. Costos reales recalculados.`);
    }

    function renderProductionView() {
      ensureWarehouses();

      const whList = document.getElementById("warehouseList");
      const whMp = document.getElementById("prodWarehouseMp");
      const whPt = document.getElementById("prodWarehousePt");
      const mpSel = document.getElementById("prodMpSelect");
      const recStockSel = document.getElementById("prodRecipeStockSelect");
      const recPlanSel = document.getElementById("prodRecipePlanSelect");
      if (!whList || !whMp || !whPt || !mpSel || !recStockSel || !recPlanSel) return;

      whList.innerHTML = state.warehouses.map(w => `<div class='list-item'><span>${escapeHtml(w.nombre)}</span></div>`).join("") || "<div class='list-item'>No hay almacenes.</div>";

      const warehouseOptions = state.warehouses.map(w => `<option value='${w.id}'>${escapeHtml(w.nombre)}</option>`).join("");
      whMp.innerHTML = warehouseOptions;
      whPt.innerHTML = warehouseOptions;

      mpSel.innerHTML = state.materiasPrimas.map(mp => `<option value='${mp.id}'>${escapeHtml(mp.nombre)}</option>`).join("");
      const recipeOptions = state.recetas.map(r => `<option value='${r.id}'>${escapeHtml(r.nombre || "Sin nombre")}</option>`).join("");
      recStockSel.innerHTML = recipeOptions;
      recPlanSel.innerHTML = recipeOptions;

      const totalMpStock = state.materiasPrimas.reduce((acc, mp) => acc + state.warehouses.reduce((s, w) => s + getMpStock(mp, w.id), 0), 0);
      const totalPtStock = state.recetas.reduce((acc, r) => acc + state.warehouses.reduce((s, w) => s + getFinishedStock(r, w.id), 0), 0);
      document.getElementById("prodKpiWarehouses").textContent = String(state.warehouses.length);
      document.getElementById("prodKpiMpStock").textContent = totalMpStock.toFixed(2);
      document.getElementById("prodKpiPtStock").textContent = totalPtStock.toFixed(2);

      const dateInput = document.getElementById("prodSummaryDate");
      if (dateInput && !dateInput.value) {
        const d = new Date();
        dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      }

      const historyMeta = document.getElementById("prodHistoryMeta");
      if (historyMeta) {
        const count = Array.isArray(state.productionHistoryRaw) ? state.productionHistoryRaw.length : 0;
        const linked = historyDbAutoSaveEnabled ? "Enlazada" : "No enlazada";
        historyMeta.textContent = `BD histÃ³rica: ${linked} | Registros histÃ³ricos: ${count}`;
      }

      renderUnmappedHistoryView();
      renderMappedHistoryView();
      renderHistoryRejectDiagnostics();

      const trendSel = document.getElementById("prodTrendRecipeFilter");
      if (trendSel) {
        const previous = Array.from(trendSel.selectedOptions || []).map(o => String(o.value || "")).filter(Boolean);
        trendSel.innerHTML = state.recetas.map(r => `<option value='${r.id}'>${escapeHtml(r.nombre || "Sin nombre")}</option>`).join("");
        const validIds = new Set(state.recetas.map(r => String(r.id || "")).filter(Boolean));
        const selected = previous.filter(id => validIds.has(id));
        if (selected.length) {
          Array.from(trendSel.options).forEach(opt => {
            opt.selected = selected.includes(String(opt.value || ""));
          });
        } else {
          Array.from(trendSel.options).forEach(opt => {
            opt.selected = true;
          });
        }
        applyTrendRecipeSearchFilter();
      }

      const today = getDayKey(new Date());
      const trendDay = document.getElementById("prodTrendDay");
      const trendFrom = document.getElementById("prodTrendDateFrom");
      const trendTo = document.getElementById("prodTrendDateTo");
      if (trendDay && !trendDay.value) trendDay.value = today;
      if (trendFrom && !trendFrom.value) trendFrom.value = today;
      if (trendTo && !trendTo.value) trendTo.value = today;

      const dateModeSel = document.getElementById("prodTrendDateMode");
      if (dateModeSel && !dateModeSel.value) {
        dateModeSel.value = "all";
      }

      const volumeMetric = document.getElementById("prodVolumeMetric");
      const volumeGroupBy = document.getElementById("prodVolumeGroupBy");
      if (volumeMetric && !volumeMetric.value) volumeMetric.value = "unitsTotal";
      if (volumeGroupBy && !volumeGroupBy.value) volumeGroupBy.value = "day";
    }

    function renderPlanillaView() {
      state.employees = Array.isArray(state.employees) ? state.employees : [];
      const list = document.getElementById("employeeList");
      const recipeSel = document.getElementById("payrollRecipeSelect");
      if (!list || !recipeSel) return;

      list.innerHTML = state.employees.length
        ? state.employees.map(e => `<div class='list-item'>
            <div>
              <strong>${escapeHtml(e.nombre || "Empleado")}</strong>
              <div class='muted'>${escapeHtml(e.puesto || "-")} | ${escapeHtml(e.estado || "activo")} | B/. ${Number(e.salario || 0).toFixed(2)}</div>
              <div class='muted' style='font-size:.8rem;'>${escapeHtml(e.correo || "-")} | ${escapeHtml(e.telefono || "-")}</div>
            </div>
            <button class='btn' onclick='deleteEmployee("${e.id}")'>X</button>
          </div>`).join("")
        : "<div class='list-item'>No hay empleados en planilla.</div>";

      recipeSel.innerHTML = state.recetas.map(r => `<option value='${r.id}'>${escapeHtml(r.nombre || "Sin nombre")}</option>`).join("");
      renderPayrollSummary();
    }

    function addWarehouse() {
      const input = document.getElementById("warehouseName");
      const nombre = String(input?.value || "").trim();
      if (!nombre) return alert("Ingresa un nombre de almacÃ©n.");
      if (ensureWarehouses().some(w => w.nombre.toLowerCase() === nombre.toLowerCase())) return alert("Ese almacÃ©n ya existe.");
      state.warehouses.push({ id: uid(), nombre });
      logSystem("produccion", "create", "warehouse", { nombre });
      saveState();
      renderAll();
      input.value = "";
    }

    function addEmployee() {
      state.employees = Array.isArray(state.employees) ? state.employees : [];
      const nombre = String(document.getElementById("empNombre")?.value || "").trim();
      if (!nombre) return alert("El nombre del empleado es obligatorio.");
      const puesto = String(document.getElementById("empPuesto")?.value || "").trim();
      const salario = Math.max(0, readLocaleInputNumber("empSalario", 0));
      const estado = document.getElementById("empEstado")?.value || "activo";
      const correo = String(document.getElementById("empCorreo")?.value || "").trim();
      const telefono = String(document.getElementById("empTelefono")?.value || "").trim();

      state.employees.push({ id: uid(), nombre, puesto, salario, estado, correo, telefono });
      logSystem("planilla", "create", "employee", { nombre, puesto, salario, estado });
      saveState();
      renderPlanillaView();
      ["empNombre", "empPuesto", "empSalario", "empCorreo", "empTelefono"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
    }

    function deleteEmployee(id) {
      state.employees = (state.employees || []).filter(e => e.id !== id);
      logSystem("planilla", "delete", "employee", { id });
      saveState();
      renderPlanillaView();
    }

    function applyMpMovement() {
      const warehouseId = document.getElementById("prodWarehouseMp")?.value;
      const mpId = document.getElementById("prodMpSelect")?.value;
      const delta = Number(document.getElementById("prodMpDelta")?.value || 0);
      const mp = state.materiasPrimas.find(x => x.id === mpId);
      if (!warehouseId || !mp || !Number.isFinite(delta) || delta === 0) return alert("Completa almacÃ©n, materia prima y cantidad vÃ¡lida.");
      setMpStock(mp, warehouseId, getMpStock(mp, warehouseId) + delta);
      logSystem("inventario", "movement", "materia_prima", { mpId, warehouseId, delta });
      saveState();
      renderAll();
      document.getElementById("prodMpDelta").value = "";
    }

    function applyPtMovement() {
      const warehouseId = document.getElementById("prodWarehousePt")?.value;
      const recipeId = document.getElementById("prodRecipeStockSelect")?.value;
      const delta = Number(document.getElementById("prodPtDelta")?.value || 0);
      const recipe = state.recetas.find(r => r.id === recipeId);
      if (!warehouseId || !recipe || !Number.isFinite(delta) || delta === 0) return alert("Completa almacÃ©n, producto y cantidad vÃ¡lida.");
      setFinishedStock(recipe, warehouseId, getFinishedStock(recipe, warehouseId) + delta);
      logSystem("inventario", "movement", "producto_terminado", { recipeId, warehouseId, delta });
      saveState();
      renderAll();
      document.getElementById("prodPtDelta").value = "";
    }

    function calculateProductionNeeds() {
      const recipeId = document.getElementById("prodRecipePlanSelect")?.value;
      const requestedQty = Math.max(1, Number(document.getElementById("prodRequestedQty")?.value || 1));
      const warehouseMpId = document.getElementById("prodWarehouseMp")?.value;
      const warehousePtId = document.getElementById("prodWarehousePt")?.value;
      const recipe = state.recetas.find(r => r.id === recipeId);
      if (!recipe) return alert("Selecciona un producto para planificar."), null;

      const baseQty = Math.max(1, Number(recipe.produccion || 1));
      const factor = requestedQty / baseQty;
      const dayKey = getDayKey();
      const cfResolved = resolveCfForProduction(recipe, dayKey, { [recipeId]: requestedQty });
      const previewCs = { ...ensureCostStructure(recipe), cargaFabril: Number(cfResolved.cfUnit || 0) };
      const totals = computeCostStructureTotals(previewCs);
      const unitCost = Number(totals.pcUnitario || 0);
      const requirements = (recipe.ingredientes || []).map(i => {
        const mp = state.materiasPrimas.find(x => x.id === i.mpId);
        const neededQty = Number(i.cantidad || 0) * factor;
        const available = mp && warehouseMpId ? getMpStock(mp, warehouseMpId) : 0;
        return { mpId: i.mpId, nombre: mp?.nombre || "Insumo", unidad: i.unidad || mp?.unidadBase || "un", neededQty, available, shortage: Math.max(0, neededQty - available) };
      });

      pendingProductionNeeds = {
        recipeId,
        recipeName: recipe.nombre || "Sin nombre",
        requestedQty,
        factor,
        requirements,
        estimatedCost: unitCost * requestedQty,
        existingPt: warehousePtId ? getFinishedStock(recipe, warehousePtId) : 0,
        warehouseMpId,
        warehousePtId,
        unitCost,
        cfResolved,
        dayKey
      };

      document.getElementById("prodNeedsSummary").textContent = `Producto: ${pendingProductionNeeds.recipeName} | Pedido: ${requestedQty.toFixed(2)} u | Costo estimado: B/. ${pendingProductionNeeds.estimatedCost.toFixed(4)}`;
      document.getElementById("prodNeedsTable").innerHTML = `<table class='tech-table'><thead><tr><th>Materia Prima</th><th>Necesario</th><th>Disponible</th><th>Faltante</th></tr></thead><tbody>${requirements.map(r => `<tr><td>${escapeHtml(r.nombre)}</td><td>${r.neededQty.toFixed(4)} ${escapeHtml(r.unidad)}</td><td>${r.available.toFixed(4)} ${escapeHtml(r.unidad)}</td><td>${r.shortage.toFixed(4)} ${escapeHtml(r.unidad)}</td></tr>`).join("") || "<tr><td colspan='4'>Sin ingredientes</td></tr>"}</tbody></table>`;
      return pendingProductionNeeds;
    }

    function registerProductionFromNeeds() {
      const plan = pendingProductionNeeds || calculateProductionNeeds();
      if (!plan) return;
      if (!plan.warehouseMpId || !plan.warehousePtId) return alert("Selecciona almacÃ©n de MP y PT.");

      plan.requirements.forEach(req => {
        const mp = state.materiasPrimas.find(x => x.id === req.mpId);
        if (!mp) return;
        setMpStock(mp, plan.warehouseMpId, getMpStock(mp, plan.warehouseMpId) - req.neededQty);
      });

      const recipe = state.recetas.find(r => r.id === plan.recipeId);
      if (recipe) setFinishedStock(recipe, plan.warehousePtId, getFinishedStock(recipe, plan.warehousePtId) + plan.requestedQty);

      const cs = recipe ? ensureCostStructure(recipe) : null;

      const unitsPerPack = Math.max(1, Number(cs?.unidadesPorEmpaque || 1));
      const packedQty = Number(plan.requestedQty || 0) / unitsPerPack;

      state.productionReports = Array.isArray(state.productionReports) ? state.productionReports : [];
      state.productionReports.unshift({
        id: uid(),
        fecha: new Date().toISOString(),
        ...plan,
        packedQty,
        baseUnitCostNoCf: Math.max(0, Number(plan.unitCost || 0) - Number(plan.cfResolved?.cfUnit || 0)),
        cfUnitCost: Number(plan.cfResolved?.cfUnit || 0),
        cfSharePct: Number(plan.cfResolved?.cfSharePct || 0),
        energiaPct: Number(plan.cfResolved?.energiaPct || 0),
        infraPct: Number(plan.cfResolved?.infraPct || 0),
        cfSource: plan.cfResolved?.source || "generico",
        totalConsumedCost: plan.estimatedCost,
        costSourceType: "planificacion_manual",
        costSourceLabel: getCostSourceLabel("planificacion_manual")
      });

      rebalanceProductionDay(plan.dayKey || getDayKey());
      logSystem("produccion", "create", "orden", { recipeId: plan.recipeId, requestedQty: plan.requestedQty, totalConsumedCost: plan.estimatedCost });
      saveState();
      renderAll();
      alert("ProducciÃ³n registrada correctamente.");
    }

    function computePayrollInfo() {
      state.employees = Array.isArray(state.employees) ? state.employees : [];
      const activos = state.employees.filter(e => String(e.estado || "activo").toLowerCase() !== "inactivo");
      const totalMensual = activos.reduce((acc, e) => acc + Number(e.salario || 0), 0);
      const dias = Math.max(1, Number(document.getElementById("payrollDias")?.value || 26));
      const horasDia = Math.max(1, Number(document.getElementById("payrollHorasDia")?.value || 8));
      return {
        activos: activos.length,
        totalMensual,
        costoDia: totalMensual / dias,
        costoHora: (totalMensual / dias) / horasDia,
        dias,
        horasDia
      };
    }

    function renderPayrollSummary() {
      const out = document.getElementById("payrollSummary");
      if (!out) return;
      const p = computePayrollInfo();
      out.textContent = `Empleados activos: ${p.activos} | Planilla mensual: B/. ${p.totalMensual.toFixed(2)} | Costo/dÃ­a: B/. ${p.costoDia.toFixed(2)} | Costo/hora: B/. ${p.costoHora.toFixed(4)}`;
    }

    function applyPayrollToCf() {
      const recipeId = document.getElementById("payrollRecipeSelect")?.value;
      const recipe = state.recetas.find(r => r.id === recipeId);
      if (!recipe) return alert("Selecciona una receta para aplicar a CF.");
      const p = computePayrollInfo();
      const cs = ensureCostStructure(recipe);
      cs.cfCalc = cs.cfCalc || {};
      cs.cfCalc.salarioBase = Number((p.totalMensual / Math.max(1, p.activos || 1)).toFixed(4));
      cs.cfCalc.personas = Math.max(1, p.activos || 1);
      cs.cfCalc.diasProduccion = p.dias;
      cs.cfCalc.horasDia = p.horasDia;
      const cf = calculateCfFromConfig(cs, recipe.tipo);
      cs.cargaFabril = Number(cf.cfFinal.toFixed(4));
      logSystem("planilla", "apply", "cf", { recipeId, empleadosActivos: p.activos, totalMensual: p.totalMensual });
      saveState();
      renderAll();
      alert("Planilla aplicada a carga fabril de la receta.");
    }

    function getProductionSummaryRows() {
      const { start, end } = getCurrentPeriodRange();
      const inRange = (state.productionReports || []).filter(r => {
        const d = new Date(r.fecha);
        return d >= start && d <= end;
      });

      const byRecipe = {};
      inRange.forEach(r => {
        if (!byRecipe[r.recipeId]) {
          byRecipe[r.recipeId] = {
            recipeId: r.recipeId,
            recipeName: r.recipeName,
            qty: 0,
            totalCost: 0,
            sourceCostMap: {},
            cfShareWeighted: 0,
            cfShareQtyWeight: 0
          };
        }
        const srcType = resolveProductionCostSource(r);
        const cost = Number(r.totalConsumedCost || 0);
        const qty = Math.max(0, Number(r.requestedQty || 0));
        const cfSharePct = Math.max(0, Number(r.cfSharePct ?? r.energiaPct ?? 0));
        byRecipe[r.recipeId].qty += Number(r.requestedQty || 0);
        byRecipe[r.recipeId].totalCost += cost;
        byRecipe[r.recipeId].sourceCostMap[srcType] = (byRecipe[r.recipeId].sourceCostMap[srcType] || 0) + cost;
        byRecipe[r.recipeId].cfShareWeighted += (cfSharePct * qty);
        byRecipe[r.recipeId].cfShareQtyWeight += qty;
      });

      return Object.values(byRecipe).map(x => {
        const dominantEntry = Object.entries(x.sourceCostMap || {}).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0] || null;
        const dominantType = dominantEntry ? String(dominantEntry[0]) : "sin_traza";
        const dominantLabel = getCostSourceLabel(dominantType);
        return {
          ...x,
          realUnitCost: x.qty > 0 ? (x.totalCost / x.qty) : 0,
          cfSharePctAvg: x.cfShareQtyWeight > 0 ? (x.cfShareWeighted / x.cfShareQtyWeight) : 0,
          dominantSourceType: dominantType,
          dominantSourceLabel: dominantLabel
        };
      });
    }

    function generateProductionConsumptionReport() {
      const rows = getProductionSummaryRows();
      const table = document.getElementById("prodSummaryTable");
      const out = document.getElementById("prodReportOutput");
      if (!rows.length) {
        if (table) table.innerHTML = "<div class='muted' style='padding:.6rem;'>No hay producciones en el periodo seleccionado.</div>";
        if (out) out.value = "No hay producciones en el periodo seleccionado.";
        return;
      }

      if (table) {
        const totalQty = rows.reduce((acc, r) => acc + Number(r.qty || 0), 0);
        const totalCost = rows.reduce((acc, r) => acc + Number(r.totalCost || 0), 0);
        const weightedCfShare = rows.reduce((acc, r) => acc + (Number(r.cfSharePctAvg || 0) * Number(r.qty || 0)), 0);
        const totalRealUnit = totalQty > 0 ? (totalCost / totalQty) : 0;
        const totalCfShare = totalQty > 0 ? (weightedCfShare / totalQty) : 0;
        table.innerHTML = `<table class='tech-table'><thead><tr><th>Producto</th><th>Cantidad</th><th>Costo Total</th><th>Costo Real Unitario</th><th>% CF del dÃ­a (prom.)</th><th>Origen Dominante</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escapeHtml(r.recipeName || "Sin nombre")}</td><td>${formatNumberUi(r.qty, 4)}</td><td>${formatCurrencyUi(r.totalCost, 2)}</td><td>${formatCurrencyUi(r.realUnitCost, 2)}</td><td>${formatPercentUi(r.cfSharePctAvg, 2)}</td><td>${escapeHtml(r.dominantSourceLabel || "Sin traza")}</td></tr>`).join("")}</tbody><tfoot><tr><td>TOTAL</td><td>${formatNumberUi(totalQty, 4)}</td><td>${formatCurrencyUi(totalCost, 2)}</td><td>${formatCurrencyUi(totalRealUnit, 2)}</td><td>${formatPercentUi(totalCfShare, 2)}</td><td>-</td></tr></tfoot></table>`;
      }

      const lines = ["RESUMEN DE PRODUCCION Y COSTOS REALES", `Generado: ${new Date().toLocaleString()}`, ""];
      rows.forEach((r, idx) => {
        lines.push(`${idx + 1}. ${r.recipeName} | Cantidad: ${r.qty.toFixed(4)} | Costo total: B/. ${r.totalCost.toFixed(4)} | Costo real unit: B/. ${r.realUnitCost.toFixed(4)} | % CF dÃ­a (prom): ${Number(r.cfSharePctAvg || 0).toFixed(2)}% | Origen dominante: ${r.dominantSourceLabel || "Sin traza"}`);
      });
      if (out) out.value = lines.join("\n");
    }

    function getProductionCostTrendRows(recipeFilter = "all") {
      const reports = Array.isArray(state.productionReports) ? state.productionReports : [];
      const byDay = {};

      reports.forEach(r => {
        const day = getDayKey(r.fecha || new Date());
        if (!byDay[day]) {
          byDay[day] = { day, totalQty: 0, dayWorkCost: 0, qtyByRecipe: {}, sourceCostMap: {} };
        }
        const recipeId = String(r.recipeId || "");
        const qty = Math.max(0, Number(r.requestedQty || 0));
        const cfUnit = Math.max(0, Number(r.cfUnitCost || 0));
        const allocated = cfUnit * qty;
        const srcType = resolveProductionCostSource(r);

        byDay[day].totalQty += qty;
        byDay[day].dayWorkCost += allocated;
        byDay[day].sourceCostMap[srcType] = (byDay[day].sourceCostMap[srcType] || 0) + allocated;
        if (recipeId) byDay[day].qtyByRecipe[recipeId] = (byDay[day].qtyByRecipe[recipeId] || 0) + qty;
      });

      return Object.values(byDay)
        .sort((a, b) => a.day.localeCompare(b.day))
        .map(x => {
          const recipeTypes = Object.keys(x.qtyByRecipe || {}).filter(id => Number(x.qtyByRecipe[id] || 0) > 0).length;
          if (recipeFilter === "all") {
            return {
              day: x.day,
              qty: x.totalQty,
              totalCost: x.dayWorkCost,
              realUnitCost: x.totalQty > 0 ? (x.dayWorkCost / x.totalQty) : 0,
              sourceCostMap: x.sourceCostMap,
              sourceSummary: summarizeSourceCostMap(x.sourceCostMap, x.dayWorkCost)
            };
          }

          const qtyRecipe = Math.max(0, Number(x.qtyByRecipe?.[recipeFilter] || 0));
          const perTypeCost = recipeTypes > 0 ? (x.dayWorkCost / recipeTypes) : 0;
          return {
            day: x.day,
            qty: qtyRecipe,
            totalCost: x.dayWorkCost,
            realUnitCost: qtyRecipe > 0 ? (perTypeCost / qtyRecipe) : 0,
            sourceCostMap: x.sourceCostMap,
            sourceSummary: summarizeSourceCostMap(x.sourceCostMap, x.dayWorkCost)
          };
        })
        .filter(r => recipeFilter === "all" ? true : Number(r.qty || 0) > 0);
    }

    function getTrendDateFilterConfig() {
      const mode = String(document.getElementById("prodTrendDateMode")?.value || "all");
      const day = String(document.getElementById("prodTrendDay")?.value || "").trim();
      const from = String(document.getElementById("prodTrendDateFrom")?.value || "").trim();
      const to = String(document.getElementById("prodTrendDateTo")?.value || "").trim();
      return { mode, day, from, to };
    }

    function isDayIncludedByTrendFilter(dayKey, filterCfg) {
      const cfg = filterCfg || { mode: "all", day: "", from: "", to: "" };
      if (cfg.mode === "day") {
        if (!cfg.day) return true;
        return dayKey === cfg.day;
      }
      if (cfg.mode === "range") {
        const afterFrom = !cfg.from || dayKey >= cfg.from;
        const beforeTo = !cfg.to || dayKey <= cfg.to;
        return afterFrom && beforeTo;
      }
      return true;
    }

    function getSelectedTrendRecipeIds() {
      const sel = document.getElementById("prodTrendRecipeFilter");
      if (!sel) return [];
      const selected = Array.from(sel.selectedOptions || []).map(o => String(o.value || "")).filter(Boolean);
      if (selected.length) return selected;
      return state.recetas.map(r => String(r.id || "")).filter(Boolean);
    }

    function applyTrendRecipeSearchFilter() {
      const sel = document.getElementById("prodTrendRecipeFilter");
      const search = String(document.getElementById("prodTrendRecipeSearch")?.value || "").trim().toLowerCase();
      const meta = document.getElementById("prodTrendFilterMeta");
      if (!sel) return;

      const options = Array.from(sel.options || []);
      let visibleCount = 0;
      options.forEach(opt => {
        const match = !search || String(opt.textContent || "").toLowerCase().includes(search);
        opt.hidden = !match;
        if (match) visibleCount += 1;
      });

      if (meta) {
        const selectedVisible = options.filter(o => !o.hidden && o.selected).length;
        meta.textContent = `Visibles: ${visibleCount} | Seleccionados visibles: ${selectedVisible} | Total seleccionados: ${sel.selectedOptions.length}`;
      }
    }

    function selectFilteredTrendRecipes() {
      const sel = document.getElementById("prodTrendRecipeFilter");
      if (!sel) return;
      Array.from(sel.options).forEach(opt => {
        opt.selected = !opt.hidden;
      });
      applyTrendRecipeSearchFilter();
      renderProductionCostTrendChart();
      renderProductionVolumeChart();
    }

    function selectAllTrendRecipes() {
      const sel = document.getElementById("prodTrendRecipeFilter");
      if (!sel) return;
      Array.from(sel.options).forEach(opt => {
        opt.selected = true;
      });
      applyTrendRecipeSearchFilter();
      renderProductionCostTrendChart();
      renderProductionVolumeChart();
    }

    function clearTrendRecipeSelection() {
      const sel = document.getElementById("prodTrendRecipeFilter");
      if (!sel) return;
      Array.from(sel.options).forEach(opt => {
        opt.selected = false;
      });
      applyTrendRecipeSearchFilter();
      renderProductionCostTrendChart();
      renderProductionVolumeChart();
    }

    function refreshTrendDateInputsState() {
      const mode = String(document.getElementById("prodTrendDateMode")?.value || "all");
      const dayInput = document.getElementById("prodTrendDay");
      const fromInput = document.getElementById("prodTrendDateFrom");
      const toInput = document.getElementById("prodTrendDateTo");
      if (dayInput) dayInput.disabled = mode !== "day";
      if (fromInput) fromInput.disabled = mode !== "range";
      if (toInput) toInput.disabled = mode !== "range";
    }

    function getFactoryDayCostFromRecipes(recipeIds = []) {
      const ids = Array.isArray(recipeIds) ? recipeIds.map(id => String(id || "")).filter(Boolean) : [];
      if (!ids.length) return 0;

      const costs = ids.map(recipeId => {
        const recipe = state.recetas.find(r => r.id === recipeId);
        if (!recipe) return null;
        const cs = ensureCostStructure(recipe);
        const cfResult = calculateCfFromConfig(cs, recipe.tipo);
        const cfg = cs.cfCalc || {};
        const diasProduccion = Math.max(1, Number(cfg.diasProduccion || 1));
        const energiaAsignada = Math.max(0, Number(cfg.energiaGlobal || 0)) * (Math.max(0, Number(cfg.energiaAsignacionPct || 0)) / 100);
        const infraAsignada = Math.max(0, Number(cfg.infraGlobal || 0)) * (Math.max(0, Number(cfg.infraAsignacionPct || 0)) / 100);
        const serviciosDia = (energiaAsignada + infraAsignada) / diasProduccion;
        const planillaDia = Math.max(0, Number(cfResult.salarioDia || 0));
        return planillaDia + serviciosDia;
      }).filter(v => Number.isFinite(Number(v)) && Number(v) >= 0);

      if (!costs.length) return 0;
      if (costs.length === 1) return Number(costs[0] || 0);
      const sum = costs.reduce((acc, val) => acc + Number(val || 0), 0);
      return sum / costs.length;
    }

    function getProductionCostTrendRowsByRecipe(dateFilter = null, recipeIds = []) {
      const reports = Array.isArray(state.productionReports) ? state.productionReports : [];
      const byDayGlobal = {};
      const byDaySelected = {};
      const allowed = new Set((recipeIds || []).map(x => String(x || "")).filter(Boolean));

      reports.forEach(r => {
        const recipeId = String(r.recipeId || "");
        if (!recipeId) return;
        const day = getDayKey(r.fecha || new Date());
        if (!isDayIncludedByTrendFilter(day, dateFilter || getTrendDateFilterConfig())) return;

        if (!byDayGlobal[day]) byDayGlobal[day] = { day, dayWorkCost: 0, qtyByRecipe: {}, sourceCostMap: {} };
        if (!byDaySelected[day]) byDaySelected[day] = { day, qtyByRecipe: {} };

        const qty = Math.max(0, Number(r.requestedQty || 0));
        const srcType = resolveProductionCostSource(r);

        byDayGlobal[day].qtyByRecipe[recipeId] = (byDayGlobal[day].qtyByRecipe[recipeId] || 0) + qty;
        byDayGlobal[day].sourceCostMap[srcType] = (byDayGlobal[day].sourceCostMap[srcType] || 0) + qty;

        if (allowed.size === 0 || allowed.has(recipeId)) {
          byDaySelected[day].qtyByRecipe[recipeId] = (byDaySelected[day].qtyByRecipe[recipeId] || 0) + qty;
        }
      });

      const out = {};
      Object.keys(byDayGlobal).forEach(day => {
        const globalEntry = byDayGlobal[day];
        const selectedEntry = byDaySelected[day] || { day, qtyByRecipe: {} };
        const recipeTypesGlobal = Object.keys(globalEntry.qtyByRecipe || {}).filter(id => Number(globalEntry.qtyByRecipe[id] || 0) > 0).length;
        const dayRecipeIds = Object.keys(globalEntry.qtyByRecipe || {}).filter(id => Number(globalEntry.qtyByRecipe[id] || 0) > 0);
        const dayCostFixed = getFactoryDayCostFromRecipes(dayRecipeIds);
        const perTypeCost = recipeTypesGlobal > 0 ? (dayCostFixed / recipeTypesGlobal) : 0;

        Object.entries(selectedEntry.qtyByRecipe || {}).forEach(([recipeId, qtyRaw]) => {
          const qty = Math.max(0, Number(qtyRaw || 0));
          if (!(qty > 0)) return;
          if (!out[recipeId]) out[recipeId] = [];
          out[recipeId].push({
            day,
            qty,
            totalCost: dayCostFixed,
            realUnitCost: perTypeCost / qty,
            sourceCostMap: globalEntry.sourceCostMap,
            sourceSummary: summarizeSourceCostMap(globalEntry.sourceCostMap, dayCostFixed)
          });
        });
      });

      Object.keys(out).forEach(recipeId => {
        out[recipeId] = out[recipeId].sort((a, b) => a.day.localeCompare(b.day));
      });
      return out;
    }

    function getTrendMetricConfig() {
      const metric = document.getElementById("prodTrendCostMetric")?.value || "totalCost";
      if (metric === "realUnitCost") {
        return { key: "realUnitCost", label: "Costo Real Unitario (B/.)", color: "#16a34a" };
      }
      return { key: "totalCost", label: "Costo DÃ­a (Servicios + Planilla) (B/.)", color: "#2563eb" };
    }

    function buildTrendDayStats(dateFilter = null, recipeIds = []) {
      const reports = Array.isArray(state.productionReports) ? state.productionReports : [];
      const cfg = dateFilter || getTrendDateFilterConfig();
      const allowed = new Set((recipeIds || []).map(x => String(x || "")).filter(Boolean));
      const byDayGlobal = {};
      const byDaySelected = {};

      reports.forEach(r => {
        const recipeId = String(r.recipeId || "");
        if (!recipeId) return;
        const day = getDayKey(r.fecha || new Date());
        if (!isDayIncludedByTrendFilter(day, cfg)) return;
        if (!byDayGlobal[day]) byDayGlobal[day] = { day, dayWorkCost: 0, qtyByRecipe: {} };
        if (!byDaySelected[day]) byDaySelected[day] = { day, qtyByRecipe: {} };

        const qty = Math.max(0, Number(r.requestedQty || 0));
        byDayGlobal[day].qtyByRecipe[recipeId] = (byDayGlobal[day].qtyByRecipe[recipeId] || 0) + qty;
        if (allowed.size === 0 || allowed.has(recipeId)) {
          byDaySelected[day].qtyByRecipe[recipeId] = (byDaySelected[day].qtyByRecipe[recipeId] || 0) + qty;
        }
      });

      return Object.keys(byDayGlobal)
        .map(day => {
          const g = byDayGlobal[day];
          const dayRecipeIds = Object.keys(g.qtyByRecipe || {}).filter(id => Number(g.qtyByRecipe[id] || 0) > 0);
          const dayCostFixed = getFactoryDayCostFromRecipes(dayRecipeIds);
          return {
            day,
            dayWorkCost: Number(dayCostFixed || 0),
            qtyByRecipeGlobal: g.qtyByRecipe || {},
            qtyByRecipeSelected: (byDaySelected[day] && byDaySelected[day].qtyByRecipe) ? byDaySelected[day].qtyByRecipe : {}
          };
        })
        .sort((a, b) => a.day.localeCompare(b.day));
    }

    function renderTrendCalculationSummary(dayStats, selectedRecipeIds, dateFilter) {
      const box = document.getElementById("prodTrendCalcSummary");
      if (!box) return;

      if (!Array.isArray(dayStats) || !dayStats.length) {
        box.innerHTML = "<div class='muted' style='padding:.5rem;'>Sin datos para mostrar desglose de cÃ¡lculo.</div>";
        return;
      }

      const selectedSet = new Set((selectedRecipeIds || []).map(id => String(id || "")).filter(Boolean));
      const allRecipeIds = selectedSet.size ? Array.from(selectedSet) : state.recetas.map(r => String(r.id || "")).filter(Boolean);

      if (String(dateFilter?.mode || "all") === "day") {
        const selectedDay = String(dateFilter?.day || "").trim();
        const dayRow = dayStats.find(r => r.day === selectedDay) || dayStats[0];
        if (!dayRow) {
          box.innerHTML = "<div class='muted' style='padding:.5rem;'>No se encontrÃ³ el dÃ­a seleccionado para el desglose.</div>";
          return;
        }

        const recipeTypesGlobal = Object.keys(dayRow.qtyByRecipeGlobal || {}).filter(id => Number(dayRow.qtyByRecipeGlobal[id] || 0) > 0).length;
        const perTypeCost = recipeTypesGlobal > 0 ? (dayRow.dayWorkCost / recipeTypesGlobal) : 0;
        const rows = allRecipeIds
          .map(recipeId => {
            const qty = Math.max(0, Number(dayRow.qtyByRecipeSelected?.[recipeId] || 0));
            if (!(qty > 0)) return "";
            const recipeName = state.recetas.find(r => r.id === recipeId)?.nombre || "Sin nombre";
            const unitCost = perTypeCost / qty;
            return `<tr><td>${escapeHtml(recipeName)}</td><td>${dayRow.day}</td><td>B/. ${dayRow.dayWorkCost.toFixed(4)}</td><td>${recipeTypesGlobal}</td><td>${qty.toFixed(4)}</td><td>B/. ${unitCost.toFixed(4)}</td></tr>`;
          })
          .filter(Boolean)
          .join("");

        if (!rows) {
          box.innerHTML = "<div class='muted' style='padding:.5rem;'>En el dÃ­a seleccionado no hay unidades para los productos elegidos.</div>";
          return;
        }

        box.innerHTML = `<table class='tech-table'><thead><tr><th>Producto</th><th>DÃ­a</th><th>Costo dÃ­a</th><th>Tipos en dÃ­a</th><th>Unidades del producto</th><th>Costo real unitario</th></tr></thead><tbody>${rows}</tbody></table>`;
        return;
      }

      const agg = {};
      dayStats.forEach(dayRow => {
        const recipeTypesGlobal = Object.keys(dayRow.qtyByRecipeGlobal || {}).filter(id => Number(dayRow.qtyByRecipeGlobal[id] || 0) > 0).length;
        const perTypeCost = recipeTypesGlobal > 0 ? (dayRow.dayWorkCost / recipeTypesGlobal) : 0;
        allRecipeIds.forEach(recipeId => {
          const qty = Math.max(0, Number(dayRow.qtyByRecipeSelected?.[recipeId] || 0));
          if (!(qty > 0)) return;
          if (!agg[recipeId]) agg[recipeId] = { units: 0, allocated: 0, days: 0, dayWorkTotal: 0 };
          agg[recipeId].units += qty;
          agg[recipeId].allocated += perTypeCost;
          agg[recipeId].days += 1;
          agg[recipeId].dayWorkTotal += dayRow.dayWorkCost;
        });
      });

      const rows = Object.entries(agg).map(([recipeId, x]) => {
        const recipeName = state.recetas.find(r => r.id === recipeId)?.nombre || "Sin nombre";
        const unitCost = x.units > 0 ? (x.allocated / x.units) : 0;
        const avgDayWork = x.days > 0 ? (x.dayWorkTotal / x.days) : 0;
        return `<tr><td>${escapeHtml(recipeName)}</td><td>${x.days}</td><td>B/. ${avgDayWork.toFixed(4)}</td><td>${x.units.toFixed(4)}</td><td>B/. ${unitCost.toFixed(4)}</td></tr>`;
      }).join("");

      if (!rows) {
        box.innerHTML = "<div class='muted' style='padding:.5rem;'>No hay datos del periodo para los productos seleccionados.</div>";
        return;
      }

      box.innerHTML = `<table class='tech-table'><thead><tr><th>Producto</th><th>DÃ­as con producciÃ³n</th><th>Costo dÃ­a prom.</th><th>Unidades periodo</th><th>Costo real unitario periodo</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    function renderProductionCostTrendChart() {
      const box = document.getElementById("prodCostTrendBox");
      const canvas = document.getElementById("prodCostTrendChart");
      const msg = document.getElementById("prodCostTrendMsg");
      if (!box || !canvas || !msg) return;

      refreshTrendDateInputsState();

      const selectedRecipeIds = getSelectedTrendRecipeIds();
      const dateFilter = getTrendDateFilterConfig();
      const metricCfg = getTrendMetricConfig();
      const dayStats = buildTrendDayStats(dateFilter, selectedRecipeIds);

      box.classList.remove("hidden");
      if (typeof Chart === "undefined") {
        msg.textContent = "No se pudo cargar Chart.js.";
        if (prodCostTrendChart) {
          prodCostTrendChart.destroy();
          prodCostTrendChart = null;
        }
        return;
      }

      if (prodCostTrendChart) {
        prodCostTrendChart.destroy();
        prodCostTrendChart = null;
      }

      let labels = [];
      let datasets = [];
      const byRecipe = getProductionCostTrendRowsByRecipe(dateFilter, selectedRecipeIds);
      const palette = ["#2563eb", "#16a34a", "#f59e0b", "#ef4444", "#7c3aed", "#0ea5e9", "#14b8a6", "#a16207"];
      const days = new Set();

      Object.values(byRecipe).forEach(rows => rows.forEach(r => days.add(r.day)));
      labels = Array.from(days).sort();

      datasets = Object.entries(byRecipe).map(([recipeId, rows], idx) => {
        const recipeName = state.recetas.find(r => r.id === recipeId)?.nombre || "Sin nombre";
        const rowMap = rows.reduce((acc, row) => {
          acc[row.day] = Number(row[metricCfg.key] || 0);
          return acc;
        }, {});
        const srcMap = rows.reduce((acc, row) => {
          acc[row.day] = row.sourceSummary || "Origen de costo: sin datos";
          return acc;
        }, {});
        const color = palette[idx % palette.length];
        return {
          label: `${recipeName} - ${metricCfg.label}`,
          data: labels.map(day => (Object.prototype.hasOwnProperty.call(rowMap, day) ? rowMap[day] : null)),
          sourceSummaryByIndex: labels.map(day => srcMap[day] || "Origen de costo: sin datos"),
          borderColor: color,
          backgroundColor: color,
          tension: 0.25,
          spanGaps: true
        };
      }).filter(d => d.data.some(v => v !== null));

      const dateMsg = dateFilter.mode === "day"
        ? `DÃ­a: ${dateFilter.day || "(sin definir)"}`
        : (dateFilter.mode === "range"
          ? `Periodo: ${dateFilter.from || "inicio"} a ${dateFilter.to || "fin"}`
          : "Periodo: todo el historial");
      msg.textContent = `Filtro activo: comparaciÃ³n por producto. ${dateMsg}.`;
      renderTrendCalculationSummary(dayStats, selectedRecipeIds, dateFilter);

      if (!labels.length || !datasets.length) {
        msg.textContent = "No hay historial de producciÃ³n para graficar con el filtro actual.";
        return;
      }

      prodCostTrendChart = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            tooltip: {
              callbacks: {
                afterBody: (ctx) => {
                  const item = Array.isArray(ctx) ? ctx[0] : null;
                  if (!item) return [];
                  const ds = item.dataset || {};
                  const idx = Number(item.dataIndex || 0);
                  const msgLine = Array.isArray(ds.sourceSummaryByIndex)
                    ? (ds.sourceSummaryByIndex[idx] || "Origen de costo: sin datos")
                    : "Origen de costo: sin datos";
                  return [msgLine];
                }
              }
            }
          },
          scales: {
            y: { type: "linear", position: "left", beginAtZero: true }
          }
        }
      });
    }

    function getRecipeUnitWeightGr(recipe) {
      if (!recipe) return 0;
      const costeo = recipe.costeo || {};
      const pesoUnidad = Number(costeo.pesoUnidad || 0);
      if (Number.isFinite(pesoUnidad) && pesoUnidad > 0) return pesoUnidad;

      const batchGr = Number(costeo.batchDeseadoGr || 0);
      const unidadesDeseadas = Math.max(1, Number(costeo.unidadesDeseadas || recipe.produccion || 1));
      if (Number.isFinite(batchGr) && batchGr > 0 && Number.isFinite(unidadesDeseadas) && unidadesDeseadas > 0) {
        return batchGr / unidadesDeseadas;
      }

      const ingredientes = Array.isArray(recipe.ingredientes) ? recipe.ingredientes : [];
      const totalGr = ingredientes.reduce((acc, i) => {
        const mp = state.materiasPrimas.find(x => x.id === i.mpId);
        const qGr = toIngredientGrams(i, mp);
        return acc + (Number.isFinite(qGr) && qGr > 0 ? qGr : 0);
      }, 0);
      const produccion = Math.max(1, Number(recipe.produccion || 1));
      return totalGr > 0 ? (totalGr / produccion) : 0;
    }

    function toPeriodKeyByMode(dateLike, groupBy = "day") {
      const d = new Date(dateLike);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      if (groupBy === "month") return `${yyyy}-${mm}`;
      if (groupBy === "week") {
        const monday = new Date(d);
        const shift = (monday.getDay() + 6) % 7;
        monday.setDate(monday.getDate() - shift);
        const weekYear = monday.getFullYear();
        const startYear = new Date(weekYear, 0, 1);
        const startShift = (startYear.getDay() + 6) % 7;
        startYear.setDate(startYear.getDate() - startShift);
        const diffDays = Math.floor((monday - startYear) / 86400000);
        const week = Math.floor(diffDays / 7) + 1;
        return `${weekYear}-W${String(week).padStart(2, "0")}`;
      }
      return `${yyyy}-${mm}-${dd}`;
    }

    function buildProductionVolumeRows(groupBy = "day", dateFilter = null, recipeIds = []) {
      const reports = Array.isArray(state.productionReports) ? state.productionReports : [];
      const cfg = dateFilter || getTrendDateFilterConfig();
      const allowed = new Set((recipeIds || []).map(x => String(x || "")).filter(Boolean));
      const byPeriod = {};

      reports.forEach(r => {
        const recipeId = String(r.recipeId || "");
        if (!recipeId) return;
        if (allowed.size && !allowed.has(recipeId)) return;

        const dayKey = getDayKey(r.fecha || new Date());
        if (!isDayIncludedByTrendFilter(dayKey, cfg)) return;

        const period = toPeriodKeyByMode(r.fecha || new Date(), groupBy);
        if (!byPeriod[period]) {
          byPeriod[period] = {
            period,
            totalUnits: 0,
            totalMassGr: 0,
            missingWeightRows: 0,
            byProduct: {}
          };
        }

        const qty = Math.max(0, Number(r.requestedQty || 0));
        if (!(qty > 0)) return;
        const recipe = state.recetas.find(x => x.id === recipeId) || null;
        const productName = recipe?.nombre || r.recipeName || "Sin nombre";
        const weightGr = getRecipeUnitWeightGr(recipe);
        const massGr = Number.isFinite(weightGr) && weightGr > 0 ? (qty * weightGr) : 0;

        byPeriod[period].totalUnits += qty;
        byPeriod[period].totalMassGr += massGr;
        if (!(Number.isFinite(weightGr) && weightGr > 0)) byPeriod[period].missingWeightRows += 1;

        if (!byPeriod[period].byProduct[recipeId]) {
          byPeriod[period].byProduct[recipeId] = {
            recipeId,
            productName,
            units: 0,
            massGr: 0
          };
        }
        byPeriod[period].byProduct[recipeId].units += qty;
        byPeriod[period].byProduct[recipeId].massGr += massGr;
      });

      return Object.values(byPeriod).sort((a, b) => a.period.localeCompare(b.period));
    }

    function renderProductionVolumeSummary(rows, groupBy) {
      const box = document.getElementById("prodVolumeSummaryTable");
      if (!box) return;
      if (!rows.length) {
        box.innerHTML = "<div class='muted' style='padding:.5rem;'>No hay datos para el anÃ¡lisis de unidades y masa.</div>";
        return;
      }

      const periodLabel = groupBy === "week" ? "Semana" : (groupBy === "month" ? "Mes" : "DÃ­a");
      const periodRows = rows.map(r => `<tr><td>${escapeHtml(r.period)}</td><td>${formatNumberUi(Number(r.totalUnits || 0), 4)}</td><td>${formatNumberUi((Number(r.totalMassGr || 0) / 1000), 4)}</td><td>${Object.keys(r.byProduct || {}).length}</td></tr>`).join("");
      const totalPeriodUnits = rows.reduce((acc, r) => acc + Number(r.totalUnits || 0), 0);
      const totalPeriodMassKg = rows.reduce((acc, r) => acc + (Number(r.totalMassGr || 0) / 1000), 0);

      const productAgg = {};
      rows.forEach(r => {
        Object.values(r.byProduct || {}).forEach(p => {
          if (!productAgg[p.recipeId]) {
            productAgg[p.recipeId] = { name: p.productName, units: 0, massGr: 0 };
          }
          productAgg[p.recipeId].units += Number(p.units || 0);
          productAgg[p.recipeId].massGr += Number(p.massGr || 0);
        });
      });
      const totalMassProductGr = Object.values(productAgg).reduce((acc, x) => acc + Number(x.massGr || 0), 0);
      const totalProductUnits = Object.values(productAgg).reduce((acc, x) => acc + Number(x.units || 0), 0);
      const productRows = Object.values(productAgg)
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
        .map(p => {
          const pct = totalMassProductGr > 0 ? ((Number(p.massGr || 0) / totalMassProductGr) * 100) : 0;
          return `<tr><td>${escapeHtml(p.name || "Sin nombre")}</td><td>${formatNumberUi(Number(p.units || 0), 4)}</td><td>${formatNumberUi((Number(p.massGr || 0) / 1000), 4)}</td><td>${formatPercentUi(pct, 2)}</td></tr>`;
        })
        .join("");

      box.innerHTML = `
        <table class='tech-table'>
          <thead><tr><th>${periodLabel}</th><th>Unidades total</th><th>Masa total (kg)</th><th>Productos</th></tr></thead>
          <tbody>${periodRows}</tbody>
          <tfoot><tr><td>TOTAL</td><td>${formatNumberUi(totalPeriodUnits, 4)}</td><td>${formatNumberUi(totalPeriodMassKg, 4)}</td><td>-</td></tr></tfoot>
        </table>
        <table class='tech-table' style='margin-top:.4rem;'>
          <thead><tr><th>Producto</th><th>Unidades acumuladas</th><th>Masa acumulada (kg)</th><th>ParticipaciÃ³n masa</th></tr></thead>
          <tbody>${productRows || "<tr><td colspan='4'>Sin datos por producto</td></tr>"}</tbody>
          <tfoot><tr><td>TOTAL</td><td>${formatNumberUi(totalProductUnits, 4)}</td><td>${formatNumberUi((totalMassProductGr / 1000), 4)}</td><td>${formatPercentUi(100, 2)}</td></tr></tfoot>
        </table>
      `;
    }

    function buildMassParticipationFromRows(rows) {
      const agg = {};
      rows.forEach(r => {
        Object.values(r.byProduct || {}).forEach(p => {
          if (!agg[p.recipeId]) agg[p.recipeId] = { name: p.productName, massGr: 0 };
          agg[p.recipeId].massGr += Number(p.massGr || 0);
        });
      });
      const items = Object.values(agg)
        .filter(x => Number(x.massGr || 0) > 0)
        .sort((a, b) => Number(b.massGr || 0) - Number(a.massGr || 0));
      const total = items.reduce((acc, x) => acc + Number(x.massGr || 0), 0);
      return {
        labels: items.map(x => x.name || "Sin nombre"),
        valuesKg: items.map(x => Number(x.massGr || 0) / 1000),
        pct: items.map(x => total > 0 ? ((Number(x.massGr || 0) / total) * 100) : 0),
        totalKg: total / 1000
      };
    }

    function groupMassParticipationTopN(massPart, topN) {
      const n = Math.max(1, Number(topN || 0));
      if (!massPart || !Array.isArray(massPart.labels) || massPart.labels.length <= n) return massPart;

      const topLabels = massPart.labels.slice(0, n);
      const topValues = massPart.valuesKg.slice(0, n);
      const topPct = massPart.pct.slice(0, n);

      const otherValue = massPart.valuesKg.slice(n).reduce((acc, x) => acc + Number(x || 0), 0);
      const otherPct = massPart.pct.slice(n).reduce((acc, x) => acc + Number(x || 0), 0);

      if (otherValue <= 0) return massPart;

      return {
        labels: [...topLabels, "Otros"],
        valuesKg: [...topValues, otherValue],
        pct: [...topPct, otherPct],
        totalKg: massPart.totalKg
      };
    }

    function renderProductionVolumeChart() {
      const box = document.getElementById("prodVolumeBox");
      const canvas = document.getElementById("prodVolumeChart");
      const donutCanvas = document.getElementById("prodVolumeDonutChart");
      const msg = document.getElementById("prodVolumeMsg");
      if (!box || !canvas || !donutCanvas || !msg) return;

      const metric = document.getElementById("prodVolumeMetric")?.value || "unitsTotal";
      const groupBy = document.getElementById("prodVolumeGroupBy")?.value || "day";
      const selectedRecipeIds = getSelectedTrendRecipeIds();
      const dateFilter = getTrendDateFilterConfig();
      const rows = buildProductionVolumeRows(groupBy, dateFilter, selectedRecipeIds);

      box.classList.remove("hidden");

      if (prodVolumeChart) {
        prodVolumeChart.destroy();
        prodVolumeChart = null;
      }
      if (prodVolumeDonutChart) {
        prodVolumeDonutChart.destroy();
        prodVolumeDonutChart = null;
      }

      renderProductionVolumeSummary(rows, groupBy);

      if (typeof Chart === "undefined") {
        msg.textContent = "No se pudo cargar Chart.js.";
        return;
      }

      if (!rows.length) {
        msg.textContent = "No hay historial para calcular unidades y masa con el filtro actual.";
        return;
      }

      const labels = rows.map(r => r.period);
      const palette = ["#2563eb", "#16a34a", "#f59e0b", "#ef4444", "#7c3aed", "#0ea5e9", "#14b8a6", "#a16207"];
      const datasets = [];

      if (metric === "unitsByProduct" || metric === "massByProduct") {
        const productKeys = new Set();
        rows.forEach(r => Object.keys(r.byProduct || {}).forEach(k => productKeys.add(k)));
        Array.from(productKeys).forEach((recipeId, idx) => {
          const productName = state.recetas.find(r => r.id === recipeId)?.nombre || rows.find(r => r.byProduct?.[recipeId])?.byProduct?.[recipeId]?.productName || "Sin nombre";
          const color = palette[idx % palette.length];
          datasets.push({
            label: metric === "massByProduct" ? `${productName} - Masa (kg)` : `${productName} - Unidades`,
            data: rows.map(r => {
              const p = r.byProduct?.[recipeId];
              if (!p) return null;
              return metric === "massByProduct"
                ? (Number(p.massGr || 0) / 1000)
                : Number(p.units || 0);
            }),
            borderColor: color,
            backgroundColor: color,
            tension: 0.25,
            spanGaps: true
          });
        });
      } else {
        const label = metric === "massTotal" ? "Masa Total (kg)" : "Unidades Totales";
        const color = metric === "massTotal" ? "#16a34a" : "#2563eb";
        datasets.push({
          label,
          data: rows.map(r => metric === "massTotal" ? (Number(r.totalMassGr || 0) / 1000) : Number(r.totalUnits || 0)),
          borderColor: color,
          backgroundColor: color,
          tension: 0.25,
          spanGaps: true
        });
      }

      const missing = rows.reduce((acc, r) => acc + Number(r.missingWeightRows || 0), 0);
      const massPart = groupMassParticipationTopN(buildMassParticipationFromRows(rows), 8);
      msg.textContent = `AnÃ¡lisis ${groupBy === "week" ? "semanal" : (groupBy === "month" ? "mensual" : "diario")} listo.${missing > 0 ? ` Registros sin peso unitario: ${missing}.` : ""}`;

      prodVolumeChart = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true }
          }
        }
      });

      if (massPart.labels.length) {
        const palette = ["#2563eb", "#16a34a", "#f59e0b", "#ef4444", "#7c3aed", "#0ea5e9", "#14b8a6", "#a16207", "#dc2626", "#1d4ed8"];
        prodVolumeDonutChart = new Chart(donutCanvas.getContext("2d"), {
          type: "doughnut",
          data: {
            labels: massPart.labels,
            datasets: [{
              label: "ParticipaciÃ³n de masa (kg)",
              data: massPart.valuesKg,
              backgroundColor: massPart.labels.map((_, i) => palette[i % palette.length]),
              borderWidth: 1
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: "bottom" },
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const i = Number(ctx.dataIndex || 0);
                    const val = Number(massPart.valuesKg[i] || 0).toFixed(4);
                    const pct = Number(massPart.pct[i] || 0).toFixed(2);
                    return `${ctx.label}: ${val} kg (${pct}%)`;
                  }
                }
              }
            }
          }
        });
      }
    }

    function getFilteredProductionReportsForTrend(dateFilter = null, selectedRecipeIds = []) {
      const cfg = dateFilter || getTrendDateFilterConfig();
      const allowed = new Set((selectedRecipeIds || []).map(x => String(x || "")).filter(Boolean));
      const reports = Array.isArray(state.productionReports) ? state.productionReports : [];
      return reports.filter(r => {
        const recipeId = String(r.recipeId || "");
        if (!recipeId) return false;
        if (allowed.size && !allowed.has(recipeId)) return false;
        const day = getDayKey(r.fecha || new Date());
        return isDayIncludedByTrendFilter(day, cfg);
      });
    }

    function buildProductionAnalysisDataForPdf(topN = 0) {
      const selectedRecipeIds = getSelectedTrendRecipeIds();
      const dateFilter = getTrendDateFilterConfig();
      const groupBy = document.getElementById("prodVolumeGroupBy")?.value || "day";
      const rows = buildProductionVolumeRows(groupBy, dateFilter, selectedRecipeIds);
      const massPart = groupMassParticipationTopN(buildMassParticipationFromRows(rows), 8);
      const reports = getFilteredProductionReportsForTrend(dateFilter, selectedRecipeIds);

      const byProduct = {};
      const byType = {};

      reports.forEach(r => {
        const recipeId = String(r.recipeId || "");
        const recipe = state.recetas.find(x => x.id === recipeId) || null;
        const recipeName = recipe?.nombre || r.recipeName || "Sin nombre";
        const typeKey = normalizeRecipeType(recipe?.tipo || "panaderia");
        const typeLabel = formatRecipeTypeLabel(typeKey);
        const qty = Math.max(0, Number(r.requestedQty || 0));
        const totalCost = Math.max(0, Number(r.totalConsumedCost || 0));
        const unitWeightGr = getRecipeUnitWeightGr(recipe);
        const massKg = (Number.isFinite(unitWeightGr) && unitWeightGr > 0) ? ((qty * unitWeightGr) / 1000) : 0;

        if (!byProduct[recipeId]) {
          byProduct[recipeId] = {
            recipeName,
            typeLabel,
            units: 0,
            massKg: 0,
            totalCost: 0
          };
        }
        byProduct[recipeId].units += qty;
        byProduct[recipeId].massKg += massKg;
        byProduct[recipeId].totalCost += totalCost;

        const cs = recipe ? ensureCostStructure(recipe) : { cfCalc: {} };
        const cfCfg = cs.cfCalc || {};
        const stageMin = ["mezcladoMin", "laminadoMin", "formadoMin", "fermentadoMin", "horneadoMin"]
          .reduce((acc, k) => acc + Math.max(0, Number(cfCfg[k] || 0)), 0);
        const cfCalc = recipe ? calculateCfFromConfig(cs, recipe.tipo) : { tasaHoraLinea: 0 };
        const rateHour = Math.max(0, Number(cfCalc.tasaHoraLinea || 0));
        const stageHoursWeighted = (stageMin * qty) / 60;
        const timeCost = stageHoursWeighted * rateHour;

        if (!byType[typeKey]) {
          byType[typeKey] = {
            typeLabel,
            units: 0,
            massKg: 0,
            totalCost: 0,
            stageHours: 0,
            stageCost: 0
          };
        }
        byType[typeKey].units += qty;
        byType[typeKey].massKg += massKg;
        byType[typeKey].totalCost += totalCost;
        byType[typeKey].stageHours += stageHoursWeighted;
        byType[typeKey].stageCost += timeCost;
      });

      const productRowsRaw = Object.values(byProduct)
        .sort((a, b) => Number(b.massKg || 0) - Number(a.massKg || 0))
        .map(x => ({
          ...x,
          realUnitCost: x.units > 0 ? (x.totalCost / x.units) : 0,
          costPerKg: x.massKg > 0 ? (x.totalCost / x.massKg) : 0
        }));

      let productRows = productRowsRaw;
      let topNApplied = 0;
      if (Number.isFinite(Number(topN)) && Number(topN) > 0) {
        const n = Math.max(1, Math.floor(Number(topN)));
        if (productRowsRaw.length > n) {
          const kept = productRowsRaw.slice(0, n);
          const other = productRowsRaw.slice(n);
          const otherUnits = other.reduce((acc, x) => acc + Number(x.units || 0), 0);
          const otherMassKg = other.reduce((acc, x) => acc + Number(x.massKg || 0), 0);
          const otherCost = other.reduce((acc, x) => acc + Number(x.totalCost || 0), 0);
          const otherRow = {
            recipeName: "Otros",
            typeLabel: "Mixto",
            units: otherUnits,
            massKg: otherMassKg,
            totalCost: otherCost,
            realUnitCost: otherUnits > 0 ? (otherCost / otherUnits) : 0,
            costPerKg: otherMassKg > 0 ? (otherCost / otherMassKg) : 0
          };
          productRows = [...kept, otherRow];
        } else {
          productRows = productRowsRaw;
        }
        topNApplied = n;
      }

      const typeRows = Object.values(byType)
        .sort((a, b) => String(a.typeLabel || "").localeCompare(String(b.typeLabel || "")))
        .map(x => ({
          ...x,
          avgStageCostPerHour: x.stageHours > 0 ? (x.stageCost / x.stageHours) : 0,
          costPerKg: x.massKg > 0 ? (x.totalCost / x.massKg) : 0
        }));

      return {
        dateFilter,
        groupBy,
        rows,
        massPart,
        productRows,
        typeRows,
        selectedRecipeIds,
        topNApplied
      };
    }

    function exportProductionAnalysisPdf() {
      if (!window.jspdf || !window.jspdf.jsPDF) {
        alert("No se pudo cargar el generador PDF. Revisa tu conexiÃ³n.");
        return;
      }

      renderProductionCostTrendChart();
      renderProductionVolumeChart();

      const data = buildProductionAnalysisDataForPdf(0);
      if (!data.rows.length) {
        alert("No hay datos con el filtro actual para exportar el anÃ¡lisis PDF.");
        return;
      }

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 36;
      let y = 42;

      const ensurePage = (required = 40) => {
        if (y + required > pageH - 40) {
          doc.addPage();
          y = 42;
        }
      };

      const dateMsg = data.dateFilter.mode === "day"
        ? `DÃ­a: ${data.dateFilter.day || "(sin definir)"}`
        : (data.dateFilter.mode === "range"
          ? `Periodo: ${data.dateFilter.from || "inicio"} a ${data.dateFilter.to || "fin"}`
          : "Periodo: todo el historial");

      const periodLabel = data.groupBy === "week" ? "Semana" : (data.groupBy === "month" ? "Mes" : "DÃ­a");
      const metric = document.getElementById("prodVolumeMetric")?.value || "unitsTotal";
      const metricLabelMap = {
        unitsTotal: "Unidades total",
        massTotal: "Masa total (kg)",
        unitsByProduct: "Unidades por producto",
        massByProduct: "Masa por producto (kg)"
      };

      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.text("ANALISIS DE PRODUCCION: GRAFICAS Y UNIDADES/MASA", margin, y);
      y += 16;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.text(`Generado: ${new Date().toLocaleString()}`, margin, y);
      y += 13;
      doc.text(`Filtro: ${dateMsg}`, margin, y);
      y += 13;
      doc.text(`Productos seleccionados: ${data.selectedRecipeIds.length}`, margin, y);
      y += 13;
      doc.text(`Vista anÃ¡lisis en pantalla: ${metricLabelMap[metric] || metricLabelMap.unitsTotal} | Agrupado por ${periodLabel}`, margin, y);
      y += 18;

      if (doc.autoTable) {
        doc.autoTable({
          startY: y,
          head: [[periodLabel, "Unidades total", "Masa total (kg)", "Productos"]],
          body: data.rows.map(r => [
            r.period,
            formatNumberUi(Number(r.totalUnits || 0), 4),
            formatNumberUi((Number(r.totalMassGr || 0) / 1000), 4),
            Object.keys(r.byProduct || {}).length
          ]),
          foot: [[
            "TOTAL",
            formatNumberUi(data.rows.reduce((acc, r) => acc + Number(r.totalUnits || 0), 0), 4),
            formatNumberUi(data.rows.reduce((acc, r) => acc + (Number(r.totalMassGr || 0) / 1000), 0), 4),
            "-"
          ]],
          theme: "grid",
          headStyles: { fillColor: [22, 101, 52] },
          styles: { fontSize: 8 }
        });
        y = (doc.lastAutoTable?.finalY || y) + 14;

        const productAgg = {};
        data.rows.forEach(r => {
          Object.values(r.byProduct || {}).forEach(p => {
            if (!productAgg[p.recipeId]) {
              productAgg[p.recipeId] = { name: p.productName, units: 0, massGr: 0 };
            }
            productAgg[p.recipeId].units += Number(p.units || 0);
            productAgg[p.recipeId].massGr += Number(p.massGr || 0);
          });
        });
        const productRows = Object.values(productAgg)
          .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
        const totalMassProductGr = productRows.reduce((acc, x) => acc + Number(x.massGr || 0), 0);
        const totalProductUnits = productRows.reduce((acc, x) => acc + Number(x.units || 0), 0);

        ensurePage(140);
        doc.autoTable({
          startY: y,
          head: [["Producto", "Unidades acumuladas", "Masa acumulada (kg)", "ParticipaciÃ³n masa"]],
          body: productRows.map(p => {
            const pct = totalMassProductGr > 0 ? ((Number(p.massGr || 0) / totalMassProductGr) * 100) : 0;
            return [
              p.name || "Sin nombre",
              formatNumberUi(Number(p.units || 0), 4),
              formatNumberUi((Number(p.massGr || 0) / 1000), 4),
              formatPercentUi(pct, 2)
            ];
          }),
          foot: [[
            "TOTAL",
            formatNumberUi(totalProductUnits, 4),
            formatNumberUi((totalMassProductGr / 1000), 4),
            formatPercentUi(100, 2)
          ]],
          theme: "grid",
          headStyles: { fillColor: [21, 128, 61] },
          styles: { fontSize: 8 }
        });
        y = (doc.lastAutoTable?.finalY || y) + 14;
      }

      const resolveChartDataUrl = (chart, canvasId) => {
        try {
          if (chart && typeof chart.update === "function") chart.update("none");
        } catch {
          // continue with fallback chain
        }

        try {
          if (chart && typeof chart.toBase64Image === "function") {
            const chartImg = chart.toBase64Image();
            if (chartImg && chartImg !== "data:," && chartImg.startsWith("data:image/")) return chartImg;
          }
        } catch {
          // ignore and continue to canvas
        }

        const canvas = document.getElementById(canvasId);
        if (canvas && typeof canvas.toDataURL === "function") {
          const canvasImg = canvas.toDataURL("image/png", 1);
          if (canvasImg && canvasImg !== "data:," && canvasImg.startsWith("data:image/")) return canvasImg;
        }
        return null;
      };

      const addChartIfFits = (title, chart, canvasId, height = 180) => {
        const img = resolveChartDataUrl(chart, canvasId);
        if (!img) return;
        ensurePage(height + 30);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.text(title, margin, y);
        y += 8;
        doc.addImage(img, "PNG", margin, y, pageW - (margin * 2), height);
        y += height + 12;
      };

      addChartIfFits("GrÃ¡fica histÃ³rica de costos", prodCostTrendChart, "prodCostTrendChart", 170);
      addChartIfFits("AnÃ¡lisis de unidades y masa", prodVolumeChart, "prodVolumeChart", 170);
      addChartIfFits("ParticipaciÃ³n de masa", prodVolumeDonutChart, "prodVolumeDonutChart", 160);

      addProjectFooterToPdf(doc);
      previewPdfDocument(doc, "analisis_produccion_peso_tiempos.pdf", false);
    }

    function applyRealCostsToProducts() {
      const rows = getProductionSummaryRows();
      if (!rows.length) return alert("No hay datos histÃ³ricos para actualizar costos reales referenciales.");
      const periodMeta = getCurrentPeriodRange();
      const baseDate = periodMeta?.base instanceof Date ? periodMeta.base.toISOString().slice(0, 10) : null;
      const period = String(periodMeta?.period || "month");
      rows.forEach(r => {
        const recipe = state.recetas.find(x => x.id === r.recipeId);
        if (!recipe) return;
        const cs = ensureCostStructure(recipe);
        cs.realUnitCostRef = Number(r.realUnitCost.toFixed(4));
        cs.realUnitCostRefPeriod = period;
        cs.realUnitCostRefBaseDate = baseDate;
        cs.realUnitCostRefUpdatedAt = new Date().toISOString();
      });
      logSystem("costos", "update", "real_cost", { products: rows.length });
      saveState();
      renderAll();
      alert("Costo real referencial actualizado en productos del periodo seleccionado. El costo receta base no se modificÃ³.");
    }

    function downloadPlanillaTemplate() {
      downloadCsv("plantilla_planilla.csv", ["nombre", "puesto", "salario", "estado", "correo", "telefono"], [["Juan Perez", "Operario", "750", "activo", "juan@empresa.com", "6000-0000"]]);
    }

    function importPlanillaCsv(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        state.employees = Array.isArray(state.employees) ? state.employees : [];
        const rows = parseSimpleCsvObjects(String(reader.result || ""));
        let added = 0;
        rows.forEach(r => {
          const nombre = String(r.nombre || "").trim();
          if (!nombre) return;
          state.employees.push({
            id: uid(),
            nombre,
            puesto: String(r.puesto || "").trim(),
            salario: Math.max(0, Number(parseLocaleNumber(r.salario) || 0)),
            estado: String(r.estado || "activo").toLowerCase() === "inactivo" ? "inactivo" : "activo",
            correo: String(r.correo || "").trim(),
            telefono: String(r.telefono || "").trim()
          });
          added += 1;
        });
        logSystem("planilla", "import", "employees_csv", { added });
        saveState();
        renderPlanillaView();
        alert(`Planilla importada: ${added} empleados.`);
      };
      reader.readAsText(file);
    }

    function downloadProductionTemplate() {
      if (!state.recetas.length) {
        alert("No hay productos en el recetario para generar la plantilla.");
        return;
      }
      if (typeof XLSX === "undefined") {
        alert("No se pudo cargar el generador de Excel. Revisa tu conexiÃ³n a internet.");
        return;
      }

      const rows = state.recetas.map(r => ({
        Nombre: r.nombre || "Sin nombre",
        Cantidad: ""
      }));

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(rows, { header: ["Nombre", "Cantidad"] });
      XLSX.utils.book_append_sheet(wb, ws, "ProduccionDia");
      XLSX.writeFile(wb, "plantilla_produccion_dia.xlsx");
    }

    function normalizeProductionHeader(raw) {
      const key = String(raw || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "")
        .replace(/[^a-z0-9]/g, "");

      const map = {
        nombre: "nombreProducto",
        nombreproducto: "nombreProducto",
        producto: "nombreProducto",
        receta: "nombreProducto",
        cantidad: "cantidadProducida",
        cantidadproducida: "cantidadProducida",
        monto: "cantidadProducida"
      };
      return map[key] || key;
    }

    function normalizeHistoricalProductionHeader(raw) {
      const key = String(raw || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "")
        .replace(/[^a-z0-9]/g, "");

      const map = {
        // Plantilla histÃ³rica simplificada: Fecha Factura, Producto, Unidades.
        fechafactura: "invoiceDate",
        fecha: "invoiceDate",
        producto: "productName",
        product: "productName",
        nombredelproducto: "productName",
        nombreproducto: "productName",
        nombre: "productName",
        cantproducido: "units",
        cantproducida: "units",
        unidades: "units",
        cantidad: "units",
        cantidadproducida: "units",
        qty: "units",
        quantity: "units",
        unidad: "units",
        unid: "units",
        // Opcionales para trazabilidad/matching
        nofactura: "invoiceNumber",
        numerofactura: "invoiceNumber",
        itemnumber: "itemCode",
        codigo: "itemCode",
        codigoproducto: "itemCode",
        upc: "itemCode"
      };
      return map[key] || key;
    }

    function rowHasAnyValue(row) {
      return Array.isArray(row) && row.some(v => String(v ?? "").trim() !== "");
    }

    function scoreHistoricalHeaderCandidate(row) {
      const interesting = new Set([
        "invoiceNumber",
        "invoiceDate",
        "productName",
        "itemCode",
        "units",
        "unitPrice",
        "lineTotal",
        "subTotal",
        "lineDiscountPct",
        "lineDiscountAmount",
        "warehouse",
        "lot",
        "customer",
        "seller"
      ]);
      const normalized = (row || []).map(c => normalizeHistoricalProductionHeader(c));
      return normalized.reduce((acc, key) => acc + (interesting.has(key) ? 1 : 0), 0);
    }

    function buildObjectsFromTabularMatrix(matrix, headerMapper) {
      if (!Array.isArray(matrix) || !matrix.length) return [];

      const usableRows = matrix
        .map(r => Array.isArray(r) ? r : [r])
        .filter(r => rowHasAnyValue(r));
      if (!usableRows.length) return [];

      const maxProbe = usableRows.length;
      let bestIdx = 0;
      let bestSemantic = -1;
      let bestNonEmpty = -1;
      for (let i = 0; i < maxProbe; i += 1) {
        const row = usableRows[i] || [];
        const semantic = scoreHistoricalHeaderCandidate(row);
        const nonEmptyCells = row.reduce((acc, c) => acc + (String(c ?? "").trim() ? 1 : 0), 0);
        if (semantic > bestSemantic) {
          bestSemantic = semantic;
          bestNonEmpty = nonEmptyCells;
          bestIdx = i;
          continue;
        }
        if (semantic === bestSemantic && semantic > 0 && nonEmptyCells > bestNonEmpty) {
          bestNonEmpty = nonEmptyCells;
          bestIdx = i;
        }
      }

      // If no semantic header was detected, assume first non-empty row is header.
      if (bestSemantic <= 0) {
        bestIdx = 0;
      }

      // Guard against trailing-header picks that would produce no data rows.
      if (bestIdx >= usableRows.length - 1 && usableRows.length > 1) {
        const altIdx = usableRows.findIndex((r, i) => i < usableRows.length - 1 && rowHasAnyValue(r));
        if (altIdx >= 0) {
          bestIdx = altIdx;
        }
      }

      const headerRow = usableRows[bestIdx] || [];
      const seen = {};
      const headers = headerRow.map((h, i) => {
        const mapped = String(headerMapper(h) || "").trim() || `col${i + 1}`;
        seen[mapped] = (seen[mapped] || 0) + 1;
        return seen[mapped] > 1 ? `${mapped}_${seen[mapped]}` : mapped;
      });

      const dataRows = usableRows.slice(bestIdx + 1).filter(r => rowHasAnyValue(r));
      return dataRows.map(cols => {
        const obj = {};
        headers.forEach((h, i) => {
          obj[h] = cols[i] ?? "";
        });
        return obj;
      });
    }

    function expandSingleColumnDelimitedMatrix(matrix) {
      if (!Array.isArray(matrix) || !matrix.length) return matrix;
      const widths = matrix.map(r => Array.isArray(r) ? r.length : 0);
      const maxWidth = widths.length ? Math.max(...widths) : 0;
      if (maxWidth > 1) return matrix;

      const lines = matrix
        .map(r => Array.isArray(r) ? String(r[0] ?? "") : "")
        .filter(s => s.trim());
      if (lines.length < 2) return matrix;

      const delimiter = detectDelimiter(lines[0]);
      const splitHead = parseDelimitedLine(lines[0], delimiter);
      if (splitHead.length <= 1) return matrix;
      return lines.map(line => parseDelimitedLine(line, delimiter));
    }

    function worksheetToRawMatrix(ws) {
      if (!ws || typeof XLSX === "undefined" || !XLSX.utils || !XLSX.utils.decode_cell) return [];
      const cellAddrs = Object.keys(ws).filter(k => !k.startsWith("!"));
      if (!cellAddrs.length) return [];

      let minR = Infinity;
      let minC = Infinity;
      let maxR = -1;
      let maxC = -1;

      cellAddrs.forEach(addr => {
        const p = XLSX.utils.decode_cell(addr);
        if (p.r < minR) minR = p.r;
        if (p.c < minC) minC = p.c;
        if (p.r > maxR) maxR = p.r;
        if (p.c > maxC) maxC = p.c;
      });

      if (!Number.isFinite(minR) || !Number.isFinite(minC) || maxR < minR || maxC < minC) return [];

      const rows = [];
      for (let r = minR; r <= maxR; r += 1) {
        const row = [];
        for (let c = minC; c <= maxC; c += 1) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr];
          row.push(cell ? (cell.w ?? cell.v ?? cell.f ?? "") : "");
        }
        rows.push(row);
      }
      return rows;
    }

    function readHistoricalObjectsFromWorksheet(ws) {
      if (!ws) return [];
      const matrixPrimary = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: false });
      const normalizedPrimary = expandSingleColumnDelimitedMatrix(matrixPrimary);
      const byPrimary = buildObjectsFromTabularMatrix(normalizedPrimary, normalizeHistoricalProductionHeader);
      if (byPrimary.length) return byPrimary;

      const rawMatrix = worksheetToRawMatrix(ws);
      const normalizedRaw = expandSingleColumnDelimitedMatrix(rawMatrix);
      const byRaw = buildObjectsFromTabularMatrix(normalizedRaw, normalizeHistoricalProductionHeader);
      if (byRaw.length) return byRaw;

      const csvText = XLSX.utils.sheet_to_csv(ws, { FS: "," });
      const csvMatrix = parseCsvLikeToMatrix(csvText);
      return buildObjectsFromTabularMatrix(csvMatrix, normalizeHistoricalProductionHeader);
    }

    function readHistoricalObjectsFromWorksheetObjectMode(ws) {
      if (!ws) return [];
      try {
        const json = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
        if (!Array.isArray(json) || !json.length) return [];
        return json.map(row => {
          const normalized = {};
          Object.keys(row || {}).forEach(k => {
            normalized[normalizeHistoricalProductionHeader(k)] = row[k];
          });
          return normalized;
        });
      } catch {
        return [];
      }
    }

    function parseCsvLikeToMatrix(text) {
      const lines = String(text || "").split(/\r?\n/).filter(r => r.trim());
      if (!lines.length) return [];
      const delimiter = detectDelimiter(lines[0]);
      return lines.map(line => parseDelimitedLine(line, delimiter));
    }

    function uint8ToBinaryString(uint8) {
      let out = "";
      const chunk = 0x8000;
      for (let i = 0; i < uint8.length; i += chunk) {
        const sub = uint8.subarray(i, Math.min(i + chunk, uint8.length));
        out += String.fromCharCode.apply(null, sub);
      }
      return out;
    }

    function selectBestHistoricalRowsFromWorkbook(wb, modeLabel = "array") {
      const sheetNames = Array.isArray(wb?.SheetNames) ? wb.SheetNames : [];
      if (!sheetNames.length) {
        return { rows: [], details: `${modeLabel}: sin hojas` };
      }

      let bestRows = [];
      let bestScore = -1;
      const diagnostics = [];

      sheetNames.forEach(name => {
        const ws = wb.Sheets[name];
        let rows = readHistoricalObjectsFromWorksheet(ws);
        const matrixCount = rows.length;
        if (!rows.length) {
          rows = readHistoricalObjectsFromWorksheetObjectMode(ws);
        }
        const objectCount = rows.length;

        const sampleScore = rows.slice(0, 50).reduce((acc, row) => {
          const product = hasValue(row.productName) ? 1 : 0;
          const units = hasValue(row.units) ? 1 : 0;
          const invoice = hasValue(row.invoiceNumber) ? 1 : 0;
          return acc + product + units + invoice;
        }, 0);
        const score = (rows.length * 100) + sampleScore;
        diagnostics.push(`${name}: matrix=${matrixCount}, object=${objectCount}, score=${score}`);
        if (score > bestScore) {
          bestScore = score;
          bestRows = rows;
        }
      });

      return { rows: bestRows, details: `${modeLabel}: ${diagnostics.join(" | ")}` };
    }

    async function readHistoricalRowsFromFile(file) {
      const lower = String(file?.name || "").toLowerCase();

      if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
        if (typeof XLSX === "undefined") {
          throw new Error("No se pudo cargar el lector de Excel. Revisa tu conexiÃ³n a internet.");
        }
        const arr = await file.arrayBuffer();
        const uint8 = new Uint8Array(arr);
        const attempts = [];

        try {
          const wbA = XLSX.read(arr, { type: "array" });
          attempts.push(selectBestHistoricalRowsFromWorkbook(wbA, "array"));
        } catch {
          attempts.push({ rows: [], details: "array: fallo de lectura" });
        }

        try {
          const wbDense = XLSX.read(arr, { type: "array", dense: true, cellFormula: true, cellText: true, WTF: true });
          attempts.push(selectBestHistoricalRowsFromWorkbook(wbDense, "array+dense"));
        } catch {
          attempts.push({ rows: [], details: "array+dense: fallo de lectura" });
        }

        try {
          const bin = uint8ToBinaryString(uint8);
          const wbBin = XLSX.read(bin, { type: "binary", dense: true, cellFormula: true, cellText: true, WTF: true, PRN: true });
          attempts.push(selectBestHistoricalRowsFromWorkbook(wbBin, "binary+prn"));
        } catch {
          attempts.push({ rows: [], details: "binary+prn: fallo de lectura" });
        }

        let winner = { rows: [], details: "" };
        attempts.forEach(a => {
          if ((a.rows?.length || 0) > (winner.rows?.length || 0)) winner = a;
        });
        if (winner.rows?.length) return winner.rows;

        // Final fallback for files that are text/tabular but mis-labeled as Excel.
        try {
          const raw = await file.text();
          const matrix = parseCsvLikeToMatrix(raw);
          const rows = buildObjectsFromTabularMatrix(matrix, normalizeHistoricalProductionHeader);
          if (rows.length) return rows;
        } catch {
          // ignore final text fallback error
        }

        const details = attempts.map(a => a.details).join(" || ");
        throw new Error(`No se pudo detectar tabla en ninguna hoja. DiagnÃ³stico: ${details || "sin datos"}`);
      }

      const raw = await file.text();
      const matrix = parseCsvLikeToMatrix(raw);
      return buildObjectsFromTabularMatrix(matrix, normalizeHistoricalProductionHeader);
    }

    function hasValue(v) {
      return !(v === null || v === undefined || String(v).trim() === "");
    }

    function pickHistoricalField(row, canonical, aliases = [], partialTokens = []) {
      if (hasValue(row[canonical])) return row[canonical];

      for (const alias of aliases) {
        if (hasValue(row[alias])) return row[alias];
      }

      const keys = Object.keys(row || {});
      for (const k of keys) {
        if (!hasValue(row[k])) continue;
        const normalizedKey = String(k).toLowerCase();
        if (partialTokens.some(t => normalizedKey.includes(String(t).toLowerCase()))) return row[k];
      }

      return "";
    }

    function parseHistoricalDate(value) {
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
      if (typeof value === "number" && Number.isFinite(value) && value > 20000) {
        const excelEpochMs = Date.UTC(1899, 11, 30);
        const ms = excelEpochMs + Math.round(value * 86400000);
        const d = new Date(ms);
        if (!Number.isNaN(d.getTime())) return d;
      }
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? new Date() : d;
    }

    function normalizeHistoricalRowInput(row) {
      const invoiceNumber = pickHistoricalField(
        row,
        "invoiceNumber",
        ["nofactura", "numerofactura"],
        ["factura", "documento"]
      );
      const invoiceDate = pickHistoricalField(
        row,
        "invoiceDate",
        ["fechafactura", "fecha"],
        ["fecha"]
      );
      const productName = pickHistoricalField(
        row,
        "productName",
        ["producto", "product", "nombreproducto", "nombre"],
        ["producto", "product", "nombre"]
      );
      const itemCode = pickHistoricalField(
        row,
        "itemCode",
        ["codigo", "codigoproducto", "itemnumber", "upc"],
        ["codigo", "item", "upc"]
      );
      const units = pickHistoricalField(
        row,
        "units",
        ["unidades", "cantidad", "qty", "quantity", "unidad", "unid"],
        ["units", "unidades", "cantidad", "qty", "quantity", "unidad", "unid"]
      );

      return {
        invoiceNumber,
        invoiceDate,
        productName: String(productName || "").trim() || String(itemCode || "").trim(),
        itemCode,
        units
      };
    }

    function buildHistoryExternalKey(row) {
      const d = getDayKey(row.invoiceDate || new Date());
      const invoice = String(row.invoiceNumber || "SINFACTURA").trim();
      const code = String(row.itemCode || "SINCODIGO").trim();
      const product = normalizeNameForMatch(row.productName || "SINPRODUCTO");
      const lot = String(row.lot || "SINLOTE").trim();
      const units = Number(row.units || 0).toFixed(4);
      return `${invoice}|${d}|${code}|${product}|${lot}|${units}`;
    }

    function resolveHistoricalLineTotal(row) {
      const units = Math.max(0, Number(parseLocaleNumber(row.units) || 0));
      const unitPrice = Math.max(0, Number(parseLocaleNumber(row.unitPrice) || 0));
      const lineTotal = parseLocaleNumber(row.lineTotal);
      const subTotal = parseLocaleNumber(row.subTotal);
      const discPct = parseLocaleNumber(row.lineDiscountPct);
      const discAmt = parseLocaleNumber(row.lineDiscountAmount);

      if (Number.isFinite(lineTotal)) return Math.max(0, Number(lineTotal));
      if (Number.isFinite(subTotal)) {
        if (Number.isFinite(discAmt)) return Math.max(0, Number(subTotal) - Number(discAmt));
        if (Number.isFinite(discPct)) return Math.max(0, Number(subTotal) * (1 - (Number(discPct) / 100)));
        return Math.max(0, Number(subTotal));
      }
      return Math.max(0, units * unitPrice);
    }

    async function importProductionHistoryFile(file) {
      if (!file) return;
      let rows = [];
      try {
        rows = await readHistoricalRowsFromFile(file);
      } catch (err) {
        alert(String(err?.message || "No se pudo leer el archivo histÃ³rico."));
        return;
      }

      if (!rows.length) {
        alert("No se encontraron filas tabulares en el archivo histÃ³rico. Verifica que la hoja con datos tenga encabezados y registros visibles.");
        return;
      }

      state.productionHistoryRaw = Array.isArray(state.productionHistoryRaw) ? state.productionHistoryRaw : [];
      state.productionReports = Array.isArray(state.productionReports) ? state.productionReports : [];

      const existingRawKeys = new Set(state.productionHistoryRaw.map(r => String(r.externalKey || "")));
      const existingProdKeys = new Set(state.productionReports.map(r => String(r.externalKey || "")));

      const staged = [];
      const rejectedRows = [];
      let rejectedMissingProduct = 0;
      let rejectedMissingUnits = 0;
      let rejectedDuplicate = 0;
      let fallbackProductFromCode = 0;
      let fallbackProductSynthetic = 0;
      let fallbackDateToday = 0;
      rows.forEach((r, idx) => {
        const canonical = normalizeHistoricalRowInput(r);
        const itemCode = String(canonical.itemCode || "").trim();
        let productName = String(canonical.productName || "").trim();
        if (!productName && itemCode) {
          productName = itemCode;
          fallbackProductFromCode += 1;
        }
        if (!productName) {
          const inv = String(canonical.invoiceNumber || "SINFACTURA").trim();
          productName = `ITEM-SIN-NOMBRE-${inv}-${idx + 1}`;
          fallbackProductSynthetic += 1;
        }
        let units = Math.max(0, Number(parseLocaleNumber(canonical.units) || 0));

        if (!(units > 0)) {
          rejectedMissingUnits += 1;
          rejectedRows.push({
            row: idx + 2,
            reason: "Sin unidades vÃ¡lidas",
            productName,
            itemCode,
            unitsRaw: canonical.units,
            unitsParsed: units,
            unitPriceRaw: "",
            lineTotalRaw: "",
            invoiceNumber: String(canonical.invoiceNumber || "").trim()
          });
          return;
        }

        const hasDate = hasValue(canonical.invoiceDate);
        const invoiceDate = parseHistoricalDate(canonical.invoiceDate);
        if (!hasDate) fallbackDateToday += 1;
        const dayKey = getDayKey(invoiceDate);
        const externalKey = buildHistoryExternalKey({ ...canonical, units, invoiceDate, productName });
        if (existingRawKeys.has(externalKey)) {
          rejectedDuplicate += 1;
          rejectedRows.push({
            row: idx + 2,
            reason: "Duplicada",
            productName,
            itemCode,
            unitsRaw: canonical.units,
            unitsParsed: units,
            unitPriceRaw: "",
            lineTotalRaw: "",
            invoiceNumber: String(canonical.invoiceNumber || "").trim()
          });
          return;
        }

        const lineTotal = 0;
        const unitPrice = 0;
        const byCode = itemCode
          ? state.recetas.find(x => normalizeNameForMatch(x.codigo || x.itemCode || x.sku || x.codigoInterno || "") === normalizeNameForMatch(itemCode))
          : null;
        const byName = state.recetas.find(x => normalizeNameForMatch(x.nombre || "") === normalizeNameForMatch(productName));
        const recipe = byCode || byName || null;

        staged.push({
          invoiceNumber: String(canonical.invoiceNumber || "").trim(),
          invoiceDate: new Date(invoiceDate).toISOString(),
          dayKey,
          productName,
          itemCode,
          units,
          unitPrice,
          lineTotal,
          recipeId: recipe?.id || null,
          recipeName: recipe?.nombre || null,
          externalKey,
          sourceFile: file.name,
          importedAt: new Date().toISOString()
        });
      });

      const qtyByDayAndRecipe = {};
      staged.forEach(r => {
        if (!r.recipeId) return;
        const day = r.dayKey;
        qtyByDayAndRecipe[day] = qtyByDayAndRecipe[day] || {};
        qtyByDayAndRecipe[day][r.recipeId] = (qtyByDayAndRecipe[day][r.recipeId] || 0) + r.units;
      });

      let rawAdded = 0;
      let prodAdded = 0;
      let unmapped = 0;

      staged.forEach(r => {
        if (existingRawKeys.has(r.externalKey)) return;
        existingRawKeys.add(r.externalKey);
        state.productionHistoryRaw.push(r);
        rawAdded += 1;

        if (!r.recipeId) {
          unmapped += 1;
          return;
        }
        if (existingProdKeys.has(r.externalKey)) return;
        existingProdKeys.add(r.externalKey);

        const recipe = state.recetas.find(x => x.id === r.recipeId);
        if (!recipe) {
          unmapped += 1;
          return;
        }

        const cfResolved = resolveCfForProduction(recipe, r.dayKey, qtyByDayAndRecipe[r.dayKey] || null);
        const cs = ensureCostStructure(recipe);
        const totals = computeCostStructureTotals({ ...cs, cargaFabril: Number(cfResolved.cfUnit || 0) });
        const inferredUnit = Math.max(0, Number(totals.pcUnitario || 0));
        const inferredTotal = Math.max(0, r.units * inferredUnit);
        const unitsPerPack = Math.max(1, Number(cs.unidadesPorEmpaque || 1));

        state.productionReports.unshift({
          id: uid(),
          fecha: r.invoiceDate,
          recipeId: recipe.id,
          recipeName: recipe.nombre || "Sin nombre",
          requestedQty: r.units,
          factor: 1,
          requirements: [],
          estimatedCost: inferredTotal,
          existingPt: 0,
          warehouseMpId: state.warehouses[0]?.id || null,
          warehousePtId: state.warehouses[0]?.id || null,
          unitCost: inferredUnit,
          baseUnitCostNoCf: Math.max(0, inferredUnit - Number(cfResolved.cfUnit || 0)),
          packedQty: r.units / unitsPerPack,
          cfUnitCost: Number(cfResolved.cfUnit || 0),
          cfSharePct: Number(cfResolved.cfSharePct || 0),
          energiaPct: Number(cfResolved.energiaPct || 0),
          infraPct: Number(cfResolved.infraPct || 0),
          cfSource: cfResolved.source || "historico",
          totalConsumedCost: inferredTotal,
          costSourceType: "import_historico_mapeado",
          costSourceLabel: getCostSourceLabel("import_historico_mapeado"),
          externalKey: r.externalKey,
          invoiceNumber: r.invoiceNumber,
          itemCode: r.itemCode
        });
        prodAdded += 1;
      });

      const affectedDays = Object.keys(qtyByDayAndRecipe || {});
      affectedDays.forEach(day => rebalanceProductionDay(day));

      logSystem("produccion", "import", "production_history_excel", { rawAdded, prodAdded, unmapped });
      lastHistoryImportMeta = {
        read: rows.length,
        rawAdded,
        prodAdded,
        unmapped,
        rejectedMissingProduct,
        rejectedMissingUnits,
        rejectedDuplicate,
        fallbackProductFromCode,
        fallbackProductSynthetic,
        fallbackDateToday,
        at: new Date().toISOString()
      };
      lastHistoryImportRejectedRows = rejectedRows.slice(0, 2000);
      saveState();
      renderAll();
      alert(`HistÃ³rico importado. LeÃ­das: ${rows.length}. BD histÃ³rica nuevas: ${rawAdded}. ProducciÃ³n mapeada: ${prodAdded}. Sin mapear: ${unmapped}. Rechazadas (sin producto): ${rejectedMissingProduct}. Rechazadas (sin unidades): ${rejectedMissingUnits}. Duplicadas: ${rejectedDuplicate}. Fallback producto por cÃ³digo: ${fallbackProductFromCode}. Fallback nombre sintÃ©tico: ${fallbackProductSynthetic}. Fecha faltante (usÃ³ hoy): ${fallbackDateToday}.`);
    }

    async function importProductionCsv(file) {
      if (!file) return;

      const fileName = String(file.name || "").toLowerCase();
      let rows = [];

      if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
        if (typeof XLSX === "undefined") {
          alert("No se pudo cargar el lector de Excel. Revisa tu conexiÃ³n a internet.");
          return;
        }
        const arr = await file.arrayBuffer();
        const wb = XLSX.read(arr, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
        rows = json.map(row => {
          const normalized = {};
          Object.keys(row).forEach(k => {
            normalized[normalizeProductionHeader(k)] = row[k];
          });
          return normalized;
        });
      } else {
        const raw = await file.text();
        rows = parseSimpleCsvObjects(raw).map(r => {
          const normalized = {};
          Object.keys(r).forEach(k => {
            normalized[normalizeProductionHeader(k)] = r[k];
          });
          return normalized;
        });
      }

      state.productionReports = Array.isArray(state.productionReports) ? state.productionReports : [];
      let added = 0;
      const today = new Date().toISOString();
      const dayKey = getDayKey(today);

      const validRows = [];
      rows.forEach(r => {
        const productName = String(r.nombreProducto || "").trim();
        if (!productName) return;

        const recipe = state.recetas.find(x => normalizeNameForMatch(x.nombre) === normalizeNameForMatch(productName));
        if (!recipe) return;

        const qtyRaw = parseLocaleNumber(r.cantidadProducida);
        const qty = Math.max(0, Number.isFinite(qtyRaw) ? qtyRaw : 0);
        if (!(qty > 0)) return;

        validRows.push({ recipe, qty });
      });

      const extraQtyByRecipe = validRows.reduce((acc, row) => {
        const id = row.recipe.id;
        acc[id] = (acc[id] || 0) + row.qty;
        return acc;
      }, {});

      validRows.forEach(({ recipe, qty }) => {
        const cfResolved = resolveCfForProduction(recipe, dayKey, extraQtyByRecipe);
        const cs = ensureCostStructure(recipe);
        const totals = computeCostStructureTotals({ ...cs, cargaFabril: Number(cfResolved.cfUnit || 0) });
        const unit = Number(totals.pcUnitario || 0);
        const total = qty * unit;
        const unitsPerPack = Math.max(1, Number(cs.unidadesPorEmpaque || 1));
        const packedQty = qty / unitsPerPack;

        state.productionReports.unshift({
          id: uid(),
          fecha: today,
          recipeId: recipe.id,
          recipeName: recipe.nombre || "Sin nombre",
          requestedQty: qty,
          factor: 1,
          requirements: [],
          estimatedCost: total,
          existingPt: 0,
          warehouseMpId: state.warehouses[0]?.id || null,
          warehousePtId: state.warehouses[0]?.id || null,
          unitCost: unit,
          baseUnitCostNoCf: Math.max(0, unit - Number(cfResolved.cfUnit || 0)),
          packedQty,
          cfUnitCost: Number(cfResolved.cfUnit || 0),
          cfSharePct: Number(cfResolved.cfSharePct || 0),
          energiaPct: Number(cfResolved.energiaPct || 0),
          infraPct: Number(cfResolved.infraPct || 0),
          cfSource: cfResolved.source || "generico",
          totalConsumedCost: total,
          costSourceType: "import_csv_produccion",
          costSourceLabel: getCostSourceLabel("import_csv_produccion")
        });
        added += 1;
      });

      rebalanceProductionDay(dayKey);

      logSystem("produccion", "import", "production_csv", { added });
      saveState();
      renderAll();
      alert(`ProducciÃ³n del dÃ­a cargada: ${added} registros.`);
    }

    function exportProductionSummaryCsv() {
      const rows = getProductionSummaryRows();
      if (!rows.length) return alert("No hay datos para exportar.");
      downloadCsv("resumen_produccion_costos.csv", ["producto", "cantidad", "costoTotal", "costoRealUnitario", "cfSharePctPromedio", "origenDominante"], rows.map(r => [r.recipeName, r.qty.toFixed(4), r.totalCost.toFixed(4), r.realUnitCost.toFixed(4), Number(r.cfSharePctAvg || 0).toFixed(2), r.dominantSourceLabel || "Sin traza"]));
    }

    function clearProductionHistory() {
      const reportsCount = Array.isArray(state.productionReports) ? state.productionReports.length : 0;
      const rawCount = Array.isArray(state.productionHistoryRaw) ? state.productionHistoryRaw.length : 0;
      if (!(reportsCount > 0 || rawCount > 0)) {
        alert("No hay histÃ³rico para borrar.");
        return;
      }

      const firstConfirm = confirm(`Se borrarÃ¡ el histÃ³rico de producciÃ³n. Registros producciÃ³n: ${reportsCount}. Registros BD histÃ³rica: ${rawCount}. Â¿Deseas continuar?`);
      if (!firstConfirm) return;
      const secondConfirm = confirm("Esta acciÃ³n no se puede deshacer. Â¿Confirmas BORRAR HISTÃ“RICO?");
      if (!secondConfirm) return;

      state.productionReports = [];
      state.productionHistoryRaw = [];
      pendingProductionNeeds = null;
      lastHistoryImportMeta = null;
      lastHistoryImportRejectedRows = [];

      logSystem("produccion", "delete", "historico", { reportsRemoved: reportsCount, historyRowsRemoved: rawCount });
      saveState();
      renderAll();
      alert("HistÃ³rico de producciÃ³n eliminado correctamente.");
    }

    function renderLogsView() {
      const monthInput = document.getElementById("logMonth");
      if (monthInput && !monthInput.value) monthInput.value = getMonthKey();
    }

    function viewLogs() {
      const monthKey = document.getElementById("logMonth")?.value || getMonthKey();
      const moduleFilter = document.getElementById("logModule")?.value || "all";
      const out = document.getElementById("logOutput");
      const monthRows = (state.logsByMonth && Array.isArray(state.logsByMonth[monthKey])) ? state.logsByMonth[monthKey] : [];
      const rows = moduleFilter === "all" ? monthRows : monthRows.filter(r => String(r.module) === moduleFilter);
      out.value = rows.length
        ? rows.map(r => `[${new Date(r.ts).toLocaleString()}] [${r.module}] ${r.action} ${r.entity} ${JSON.stringify(r.detail || {})}`).join("\n")
        : "Sin logs para el filtro seleccionado.";
    }

    function exportLogsCsv() {
      const monthKey = document.getElementById("logMonth")?.value || getMonthKey();
      const moduleFilter = document.getElementById("logModule")?.value || "all";
      const monthRows = (state.logsByMonth && Array.isArray(state.logsByMonth[monthKey])) ? state.logsByMonth[monthKey] : [];
      const rows = moduleFilter === "all" ? monthRows : monthRows.filter(r => String(r.module) === moduleFilter);
      if (!rows.length) return alert("No hay logs para exportar.");
      downloadCsv(`logs_${monthKey}.csv`, ["timestamp", "modulo", "accion", "entidad", "detalle"], rows.map(r => [r.ts, r.module, r.action, r.entity, JSON.stringify(r.detail || {})]));
    }

    function normalizeUnitKey(unit) {
      return String(unit || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
    }

    function getMassUnitFactor(unit) {
      const u = normalizeUnitKey(unit);
      if (!u) return 1;
      if (["g", "gr", "gramo", "gramos"].includes(u)) return 1;
      if (["kg", "kilo", "kilos", "kilogramo", "kilogramos"].includes(u)) return 1000;
      return null;
    }

    function toGrams(value, unit) {
      const n = Number(value || 0);
      if (!Number.isFinite(n)) return null;
      const factor = getMassUnitFactor(unit);
      if (!Number.isFinite(factor)) return null;
      return n * factor;
    }

    function getIngredientGramEquivalent(ingredient) {
      const eq = Number(ingredient?.gramosEquivalencia || 0);
      return Number.isFinite(eq) && eq > 0 ? eq : null;
    }

    function toIngredientGrams(ingredient, mp = null) {
      const qty = Number(ingredient?.cantidad || 0);
      if (!Number.isFinite(qty)) return null;
      const unit = ingredient?.unidad || mp?.unidadBase || "";
      const massQty = toGrams(qty, unit);
      if (Number.isFinite(massQty)) return massQty;
      const eq = getIngredientGramEquivalent(ingredient);
      if (Number.isFinite(eq)) return qty * eq;
      return null;
    }

    function areUnitsCostCompatible(unitA, unitB) {
      const a = normalizeUnitKey(unitA);
      const b = normalizeUnitKey(unitB);
      if (a === b) return true;
      const aMass = getMassUnitFactor(a);
      const bMass = getMassUnitFactor(b);
      return Number.isFinite(aMass) && Number.isFinite(bMass);
    }

    function computeRecipe(recipe) {
      const produccion = Number(recipe.produccion || 1) || 1;
      let costoBase = 0;

      (recipe.ingredientes || []).forEach(i => {
        const costoDirecto = Number(i.costoReceta);
        if (Number.isFinite(costoDirecto) && costoDirecto >= 0) {
          costoBase += costoDirecto;
          return;
        }

        const mp = state.materiasPrimas.find(x => x.id === i.mpId);
        if (!mp) return;
        const ingUnit = i.unidad || mp.unidadBase || "";
        const mpUnit = mp.unidadBase || "";
        const ingQtyMass = toIngredientGrams(i, mp);
        const mpPackMass = toGrams(mp.cantidadEmpaque || 0, mpUnit);
        const sameFamily = areUnitsCostCompatible(ingUnit, mpUnit);
        const gramBridge = Number.isFinite(ingQtyMass) && Number.isFinite(mpPackMass);
        if (!(sameFamily || gramBridge)) return;

        const qtyForCost = sameFamily
          ? (Number.isFinite(ingQtyMass) ? ingQtyMass : Number(i.cantidad || 0))
          : ingQtyMass;
        const packForCost = sameFamily
          ? (Number.isFinite(mpPackMass) ? mpPackMass : Number(mp.cantidadEmpaque || 0))
          : mpPackMass;
        const cantEmp = Number(mp.cantidadEmpaque || 0);
        const precioEmp = Number(mp.precioEmpaque || 0);
        const costoUnitario = packForCost > 0 ? (precioEmp / packForCost) : (cantEmp > 0 ? (precioEmp / cantEmp) : 0);
        costoBase += costoUnitario * Math.max(0, Number(qtyForCost || 0));
      });

      const costoUnidad = costoBase / produccion;
      const precio = costoUnidad / 0.55;
      return { costoBase, precio };
    }

    function ensureCostStructure(recipe) {
      if (!recipe) return null;
      const calc = computeRecipe(recipe);
      const produccion = Math.max(1, Number(recipe.produccion || 1));
      const costoRecetaUnit = calc.costoBase / produccion;

      if (!recipe.costStructure) {
        const costoReceta = Number(costoRecetaUnit.toFixed(4));
        const cargaFabril = Number((costoReceta * 0.33).toFixed(4));
        const materialEmpaque = 0.03;
        const pcUnit = costoReceta + cargaFabril + materialEmpaque;
        recipe.costStructure = {
          unidadesPorEmpaque: 24,
          empaques: 1,
          costoReceta,
          allowManualCostoRecetaEdit: false,
          cargaFabril,
          materialEmpaque,
          transporte: 0,
          costosOperativos: 0,
          pvLockMode: "manual",
          pvUnitario: Number((pcUnit / 0.65).toFixed(4)),
          pvCaja: Number(((pcUnit * 24) / 0.65).toFixed(4)),
          cfCalc: {
            modo: "etapas",
            unidadesLote: Math.max(1, Number(recipe.produccion || 1)),
            salarioBase: 630.24,
            riesgoPct: 2,
            personas: 3,
            diasProduccion: 26,
            horasDia: 24,
            capacidadInstalada: 1200,
            unidadesHoraEmpaque: 300,
            horasEmpaque: 2,
            energiaGlobal: 2000,
            energiaAsignacionPct: 100,
            infraGlobal: 5500,
            infraAsignacionPct: 100,
            etapasPanaderia: { mezcladoMin: 20, laminadoMin: 15, formadoMin: 15, fermentadoMin: 45, horneadoMin: 20 },
            etapasPasteleria: { mezcladoMin: 18, laminadoMin: 0, formadoMin: 12, fermentadoMin: 0, horneadoMin: 35 }
          }
        };
      }

      if (!(Number(recipe.costStructure.costoReceta) > 0)) {
        recipe.costStructure.costoReceta = Number(costoRecetaUnit.toFixed(4));
      }

      if (typeof recipe.costStructure.allowManualCostoRecetaEdit !== "boolean") {
        recipe.costStructure.allowManualCostoRecetaEdit = false;
      }

      if (!recipe.costStructure.pvLockMode) {
        recipe.costStructure.pvLockMode = "manual";
      }

      if (!recipe.costStructure.cfCalc) {
        recipe.costStructure.cfCalc = {
          modo: "etapas",
          unidadesLote: Math.max(1, Number(recipe.produccion || 1)),
          salarioBase: 630.24,
          riesgoPct: 2,
          personas: 3,
          diasProduccion: 26,
          horasDia: 24,
          capacidadInstalada: 1200,
          unidadesHoraEmpaque: 300,
          horasEmpaque: 2,
          energiaGlobal: 2000,
          energiaAsignacionPct: 100,
          infraGlobal: 5500,
          infraAsignacionPct: 100,
          etapasPanaderia: { mezcladoMin: 20, laminadoMin: 15, formadoMin: 15, fermentadoMin: 45, horneadoMin: 20 },
          etapasPasteleria: { mezcladoMin: 18, laminadoMin: 0, formadoMin: 12, fermentadoMin: 0, horneadoMin: 35 }
        };
      }
      return recipe.costStructure;
    }

    function computeCostStructureTotals(cs) {
      const costoReceta = Number(cs.costoReceta || 0);
      const cargaFabril = Number(cs.cargaFabril || 0);
      const materialEmpaque = Number(cs.materialEmpaque || 0);
      const pvUnitario = Number(cs.pvUnitario || 0);
      const unidadesPorEmpaque = Math.max(1, Number(cs.unidadesPorEmpaque || 1));
      const empaques = Math.max(1, Number(cs.empaques || 1));
      const transporte = Number(cs.transporte || 0);
      const costosOperativos = Number(cs.costosOperativos || 0);
      const pvCaja = Number(cs.pvCaja || 0);

      const totalCostoUnidad = costoReceta + cargaFabril;
      const totalCostoUnitario = totalCostoUnidad + materialEmpaque;
      const pcUnitario = totalCostoUnitario;
      const mbUnitario = pvUnitario - pcUnitario;
      const mbUnitPct = pvUnitario > 0 ? (mbUnitario / pvUnitario) * 100 : 0;

      const totalCostoEmpaque = totalCostoUnitario * unidadesPorEmpaque * empaques;
      const totalCostos = totalCostoEmpaque + transporte + costosOperativos;
      const pcCaja = totalCostos;
      const mbCaja = pvCaja - pcCaja;
      const mbCajaPct = pvCaja > 0 ? (mbCaja / pvCaja) * 100 : 0;

      return {
        costoReceta,
        cargaFabril,
        materialEmpaque,
        pvUnitario,
        transporte,
        costosOperativos,
        pvCaja,
        totalCostoUnidad,
        totalCostoUnitario,
        pcUnitario,
        mbUnitario,
        mbUnitPct,
        totalCostoEmpaque,
        totalCostos,
        pcCaja,
        mbCaja,
        mbCajaPct
      };
    }

    function calculateCfFromConfig(cs, recipeType = "panaderia") {
      const cfg = cs.cfCalc || {};
      const unidadesLote = Math.max(1, Number(cfg.unidadesLote || 1));

      const salarioBase = Math.max(0, Number(cfg.salarioBase || 0));
      const riesgoPct = Math.max(0, Number(cfg.riesgoPct || 0));
      const css = salarioBase * 0.1325;
      const seguroEducativo = salarioBase * 0.015;
      const riesgoProfesional = salarioBase * (riesgoPct / 100);
      const cargasPatronales = css + seguroEducativo + riesgoProfesional;

      const decimo = salarioBase * 0.0833;
      const vacaciones = salarioBase * 0.0909;
      const primaAntiguedad = salarioBase * 0.0192;
      const cesantia = salarioBase * 0.055;
      const prestaciones = decimo + vacaciones + primaAntiguedad + cesantia;

      const personas = Math.max(1, Number(cfg.personas || 1));
      const diasProduccion = Math.max(1, Number(cfg.diasProduccion || 1));
      const horasDia = Math.max(1, Number(cfg.horasDia || 1));
      const capacidadInstalada = Math.max(1, Number(cfg.capacidadInstalada || 1));
      const unidadesHoraEmpaque = Math.max(1, Number(cfg.unidadesHoraEmpaque || 1));
      const horasEmpaque = Math.max(0, Number(cfg.horasEmpaque || 0));

      const energiaGlobal = Math.max(0, Number(cfg.energiaGlobal || 0));
      const energiaAsignacionPct = Math.max(0, Number(cfg.energiaAsignacionPct || 0));
      const infraGlobal = Math.max(0, Number(cfg.infraGlobal || 0));
      const infraAsignacionPct = Math.max(0, Number(cfg.infraAsignacionPct || 0));

      const costoTotalReal = salarioBase + cargasPatronales + prestaciones;
      const salarioIntegralMes = costoTotalReal * personas;
      const salarioDia = salarioIntegralMes / diasProduccion;
      const salarioHora = salarioDia / horasDia;
      const valorUnitProduccion = salarioDia / capacidadInstalada;
      const valorUnitEmpaque = (salarioHora * horasEmpaque) / Math.max(1, unidadesHoraEmpaque * Math.max(1, horasEmpaque));

      const unidadesMes = Math.max(1, capacidadInstalada * diasProduccion);
      const energiaAsignada = energiaGlobal * (energiaAsignacionPct / 100);
      const infraAsignada = infraGlobal * (infraAsignacionPct / 100);
      const energiaUnidad = energiaAsignada / unidadesMes;
      const infraUnidad = infraAsignada / unidadesMes;

      const horasMes = Math.max(1, diasProduccion * horasDia);
      const overheadHora = (energiaAsignada + infraAsignada) / horasMes;
      const tasaHora = salarioHora + overheadHora;

      const cfImagen = valorUnitProduccion + valorUnitEmpaque + energiaUnidad + infraUnidad;

      const etapas = normalizeRecipeType(recipeType) === "pasteleria"
        ? (cfg.etapasPasteleria || {})
        : (cfg.etapasPanaderia || {});
      const totalMin = Math.max(0, Number(etapas.mezcladoMin || 0))
        + Math.max(0, Number(etapas.laminadoMin || 0))
        + Math.max(0, Number(etapas.formadoMin || 0))
        + Math.max(0, Number(etapas.fermentadoMin || 0))
        + Math.max(0, Number(etapas.horneadoMin || 0));
      const costoProcesoLote = (totalMin / 60) * tasaHora;
      const cfEtapas = costoProcesoLote / unidadesLote;

      const modo = cfg.modo === "imagen" ? "imagen" : "etapas";
      const cfFinal = modo === "imagen" ? cfImagen : cfEtapas;

      return {
        modo,
        cfFinal,
        cfImagen,
        cfEtapas,
        costoTotalReal,
        salarioIntegralMes,
        salarioDia,
        salarioHora,
        tasaHora,
        cargasPatronales,
        prestaciones,
        valorUnitProduccion,
        valorUnitEmpaque,
        energiaUnidad,
        infraUnidad,
        totalMin,
        costoProcesoLote,
        unidadesLote
      };
    }

    function renderCostStructureView() {
      const select = document.getElementById("csRecetaSelect");
      if (!select) return;

      select.innerHTML = state.recetas.map(r =>
        `<option value="${r.id}">${escapeHtml(r.nombre || "Sin nombre")} (${formatRecipeTypeLabel(r.tipo)})</option>`
      ).join("");

      if (!state.recetas.length) {
        document.getElementById("csRecipeType").textContent = "No hay recetas";
        return;
      }

      const selectedId = state.recetas.some(r => r.id === state.activeRecipeId)
        ? state.activeRecipeId
        : state.recetas[0].id;

      state.activeRecipeId = selectedId;
      select.value = selectedId;

      const receta = currentRecipe();
      if (!receta) return;
      const cs = ensureCostStructure(receta);

      document.getElementById("csRecipeType").textContent = formatRecipeTypeLabel(receta.tipo);
      document.getElementById("csUnidadesEmpaque").value = cs.unidadesPorEmpaque;
      document.getElementById("csEmpaques").value = cs.empaques;
      document.getElementById("csCostoReceta").value = cs.costoReceta;
      const allowCostoEdit = !!cs.allowManualCostoRecetaEdit;
      const costoRecetaInput = document.getElementById("csCostoReceta");
      const allowCostoEditInput = document.getElementById("csAllowCostoRecetaEdit");
      if (allowCostoEditInput) allowCostoEditInput.checked = allowCostoEdit;
      if (costoRecetaInput) costoRecetaInput.readOnly = !allowCostoEdit;
      const realRefEl = document.getElementById("csRealCostReference");
      if (realRefEl) {
        if (Number.isFinite(Number(cs.realUnitCostRef))) {
          const periodLabelMap = { day: "dÃ­a", week: "semana", month: "mes", historico_acumulado: "histÃ³rico acumulado" };
          const periodLabel = periodLabelMap[String(cs.realUnitCostRefPeriod || "")] || String(cs.realUnitCostRefPeriod || "sin periodo");
          const baseLabel = cs.realUnitCostRefBaseDate ? ` | Fecha base: ${cs.realUnitCostRefBaseDate}` : "";
          realRefEl.textContent = `Costo real referencial: B/. ${Number(cs.realUnitCostRef || 0).toFixed(4)} | Periodo: ${periodLabel}${baseLabel}`;
        } else {
          realRefEl.textContent = "Costo real referencial: sin calcular para el periodo actual.";
        }
      }
      const cfResult = calculateCfFromConfig(cs, receta.tipo);
      document.getElementById("csCargaFabril").value = cs.cargaFabril;
      document.getElementById("csMaterialEmpaque").value = cs.materialEmpaque;
      document.getElementById("csTransporte").value = cs.transporte;
      document.getElementById("csCostosOperativos").value = cs.costosOperativos;
      document.getElementById("csPvUnitario").value = cs.pvUnitario;
      document.getElementById("csPvCaja").value = cs.pvCaja;
      document.getElementById("csPvLockMode").value = cs.pvLockMode || "manual";
      const lockPv = (cs.pvLockMode || "manual") === "margen";
      document.getElementById("csPvUnitario").readOnly = lockPv;
      document.getElementById("csPvCaja").readOnly = lockPv;

      const totals = computeCostStructureTotals(cs);
      const costoReceta = totals.costoReceta;
      const cargaFabril = totals.cargaFabril;
      const materialEmpaque = totals.materialEmpaque;
      const pvUnitario = totals.pvUnitario;
      const transporte = totals.transporte;
      const costosOperativos = totals.costosOperativos;
      const pvCaja = totals.pvCaja;
      const totalCostoUnidad = totals.totalCostoUnidad;
      const totalCostoUnitario = totals.totalCostoUnitario;
      const pcUnitario = totals.pcUnitario;
      const mbUnitario = totals.mbUnitario;
      const mbUnitPct = totals.mbUnitPct;
      const totalCostoEmpaque = totals.totalCostoEmpaque;
      const totalCostos = totals.totalCostos;
      const pcCaja = totals.pcCaja;
      const mbCaja = totals.mbCaja;
      const mbCajaPct = totals.mbCajaPct;

      const partBase = totalCostoUnitario > 0 ? totalCostoUnitario : 1;
      const partCostoReceta = (costoReceta / partBase) * 100;
      const partCarga = (cargaFabril / partBase) * 100;
      const partMaterial = (materialEmpaque / partBase) * 100;

      document.getElementById("csPartCostoReceta").textContent = `${partCostoReceta.toFixed(2)}%`;
      document.getElementById("csPartCargaFabril").textContent = `${partCarga.toFixed(2)}%`;
      document.getElementById("csPartMaterial").textContent = `${partMaterial.toFixed(2)}%`;
      document.getElementById("csTotalCostoUnidad").textContent = `B/. ${totalCostoUnidad.toFixed(4)}`;
      document.getElementById("csTotalCostoUnitario").textContent = `B/. ${totalCostoUnitario.toFixed(4)}`;
      document.getElementById("csPcUnitario").textContent = `B/. ${pcUnitario.toFixed(4)}`;
      document.getElementById("csPvUnitarioOut").textContent = `B/. ${pvUnitario.toFixed(4)}`;
      document.getElementById("csMbUnitPct").textContent = `${mbUnitPct.toFixed(2)}%`;
      document.getElementById("csMbUnitario").textContent = `B/. ${mbUnitario.toFixed(4)}`;

      document.getElementById("csTotalCostoEmpaque").textContent = `B/. ${totalCostoEmpaque.toFixed(4)}`;
      document.getElementById("csTransporteOut").textContent = `B/. ${transporte.toFixed(4)}`;
      document.getElementById("csCostosOperativosOut").textContent = `B/. ${costosOperativos.toFixed(4)}`;
      document.getElementById("csTotalCostos").textContent = `B/. ${totalCostos.toFixed(4)}`;
      document.getElementById("csPcCaja").textContent = `B/. ${pcCaja.toFixed(4)}`;
      document.getElementById("csPvCajaOut").textContent = `B/. ${pvCaja.toFixed(4)}`;
      document.getElementById("csMbCajaPct").textContent = `${mbCajaPct.toFixed(2)}%`;
      document.getElementById("csMbCaja").textContent = `B/. ${mbCaja.toFixed(4)}`;

      document.getElementById("csMbUnitPctInput").value = mbUnitPct.toFixed(2);
      document.getElementById("csMbCajaPctInput").value = mbCajaPct.toFixed(2);

      const cfg = cs.cfCalc || {};
      document.getElementById("cfModo").value = cfg.modo || "etapas";
      document.getElementById("cfUnidadesLote").value = cfg.unidadesLote || Math.max(1, Number(receta.produccion || 1));
      document.getElementById("cfSalarioBase").value = cfg.salarioBase ?? 0;
      document.getElementById("cfRiesgoPct").value = cfg.riesgoPct ?? 2;
      document.getElementById("cfCargasPatronales").value = cfResult.cargasPatronales.toFixed(2);
      document.getElementById("cfPrestaciones").value = cfResult.prestaciones.toFixed(2);
      document.getElementById("cfCostoTotalReal").value = cfResult.costoTotalReal.toFixed(2);
      document.getElementById("cfPersonas").value = cfg.personas ?? 1;
      document.getElementById("cfDiasProduccion").value = cfg.diasProduccion ?? 26;
      document.getElementById("cfHorasDia").value = cfg.horasDia ?? 24;
      document.getElementById("cfCapInstalada").value = cfg.capacidadInstalada ?? 1200;
      document.getElementById("cfUnidHoraEmpaque").value = cfg.unidadesHoraEmpaque ?? 300;
      document.getElementById("cfHorasEmpaque").value = cfg.horasEmpaque ?? 2;
      document.getElementById("cfEnergiaGlobal").value = cfg.energiaGlobal ?? 2000;
      document.getElementById("cfEnergiaAsignacionPct").value = cfg.energiaAsignacionPct ?? 100;
      document.getElementById("cfInfraGlobal").value = cfg.infraGlobal ?? 5500;
      document.getElementById("cfInfraAsignacionPct").value = cfg.infraAsignacionPct ?? 100;
      document.getElementById("cfEnergiaUnidad").value = cfResult.energiaUnidad.toFixed(4);
      document.getElementById("cfInfraUnidad").value = cfResult.infraUnidad.toFixed(4);
      document.getElementById("cfTasaHoraLinea").value = cfResult.tasaHora.toFixed(4);
      const etapasActivas = normalizeRecipeType(receta.tipo) === "pasteleria"
        ? (cfg.etapasPasteleria || {})
        : (cfg.etapasPanaderia || {});
      document.getElementById("cfMezcladoMin").value = etapasActivas.mezcladoMin ?? 0;
      document.getElementById("cfLaminadoMin").value = etapasActivas.laminadoMin ?? 0;
      document.getElementById("cfFormadoMin").value = etapasActivas.formadoMin ?? 0;
      document.getElementById("cfFermentadoMin").value = etapasActivas.fermentadoMin ?? 0;
      document.getElementById("cfHorneadoMin").value = etapasActivas.horneadoMin ?? 0;

      document.getElementById("cfCalcSummary").innerHTML = `
        <div class="muted"><strong>Resultado Carga Fabril aplicado:</strong> B/. ${cfResult.cfFinal.toFixed(4)} por unidad (modo: ${cfResult.modo})</div>
        <div class="muted">Modelo Imagen: B/. ${cfResult.cfImagen.toFixed(4)} | Etapas: B/. ${cfResult.cfEtapas.toFixed(4)}</div>
        <div class="muted">Costo total real: B/. ${cfResult.costoTotalReal.toFixed(2)} | Salario integral mes (equipo): B/. ${cfResult.salarioIntegralMes.toFixed(2)}</div>
        <div class="muted">Valor unitario producciÃ³n: B/. ${cfResult.valorUnitProduccion.toFixed(4)} | Valor unitario empacado: B/. ${cfResult.valorUnitEmpaque.toFixed(4)}</div>
        <div class="muted">Tiempo total etapas: ${cfResult.totalMin.toFixed(2)} min | Costo proceso lote: B/. ${cfResult.costoProcesoLote.toFixed(4)} | Unidades lote: ${cfResult.unidadesLote.toFixed(2)}</div>
      `;
    }

    function updateCostStructureFromForm() {
      const receta = currentRecipe();
      if (!receta) return;
      const cs = ensureCostStructure(receta);

      cs.unidadesPorEmpaque = Math.max(1, Number(document.getElementById("csUnidadesEmpaque").value || 1));
      cs.empaques = Math.max(1, Number(document.getElementById("csEmpaques").value || 1));
      cs.allowManualCostoRecetaEdit = !!document.getElementById("csAllowCostoRecetaEdit")?.checked;
      if (cs.allowManualCostoRecetaEdit) {
        cs.costoReceta = Math.max(0, readLocaleInputNumber("csCostoReceta", 0));
      }
      cs.materialEmpaque = Math.max(0, readLocaleInputNumber("csMaterialEmpaque", 0));
      cs.transporte = Math.max(0, readLocaleInputNumber("csTransporte", 0));
      cs.costosOperativos = Math.max(0, readLocaleInputNumber("csCostosOperativos", 0));
      cs.pvLockMode = document.getElementById("csPvLockMode").value === "margen" ? "margen" : "manual";

      if (cs.pvLockMode === "margen") {
        const unitTargetPct = Number(parseLocaleNumber(document.getElementById("csMbUnitPctInput").value) || 0);
        const boxTargetPct = Number(parseLocaleNumber(document.getElementById("csMbCajaPctInput").value) || 0);

        const totals = computeCostStructureTotals(cs);
        if (unitTargetPct >= 0 && unitTargetPct < 100) {
          cs.pvUnitario = Number((totals.pcUnitario / (1 - (unitTargetPct / 100))).toFixed(4));
        }
        if (boxTargetPct >= 0 && boxTargetPct < 100) {
          cs.pvCaja = Number((totals.totalCostos / (1 - (boxTargetPct / 100))).toFixed(4));
        }
      } else {
        const pvUnitarioInput = parseLocaleNumber(document.getElementById("csPvUnitario").value);
        cs.pvUnitario = Math.max(0, Number.isFinite(pvUnitarioInput) ? pvUnitarioInput : 0);
        cs.pvCaja = Math.max(0, readLocaleInputNumber("csPvCaja", 0));
      }

      saveState();
      renderCostStructureView();
    }

    function saveCurrentCostStructure() {
      const receta = currentRecipe();
      if (!receta) {
        alert("Selecciona una receta para guardar su estructura de costos.");
        return;
      }
      updateCostStructureFromForm();
      logSystem("costos", "update", "estructura", { recipeId: receta.id, nombre: receta.nombre || "" });
      alert(`Estructura de costos guardada para: ${receta.nombre || "Receta sin nombre"}.`);
    }

    function updateCfCalculatorFromForm() {
      const receta = currentRecipe();
      if (!receta) return;
      const cs = ensureCostStructure(receta);
      const cfg = cs.cfCalc || {};

      cfg.modo = document.getElementById("cfModo").value === "imagen" ? "imagen" : "etapas";
      cfg.unidadesLote = Math.max(1, Number(document.getElementById("cfUnidadesLote").value || receta.produccion || 1));
      cfg.salarioBase = Math.max(0, readLocaleInputNumber("cfSalarioBase", 0));
      cfg.riesgoPct = Math.max(0, Number(document.getElementById("cfRiesgoPct").value || 0));
      cfg.personas = Math.max(1, Number(document.getElementById("cfPersonas").value || 1));
      cfg.diasProduccion = Math.max(1, Number(document.getElementById("cfDiasProduccion").value || 1));
      cfg.horasDia = Math.max(1, Number(document.getElementById("cfHorasDia").value || 1));
      cfg.capacidadInstalada = Math.max(1, Number(document.getElementById("cfCapInstalada").value || 1));
      cfg.unidadesHoraEmpaque = Math.max(1, Number(document.getElementById("cfUnidHoraEmpaque").value || 1));
      cfg.horasEmpaque = Math.max(0, Number(document.getElementById("cfHorasEmpaque").value || 0));
      cfg.energiaGlobal = Math.max(0, readLocaleInputNumber("cfEnergiaGlobal", 0));
      cfg.energiaAsignacionPct = Math.max(0, Number(document.getElementById("cfEnergiaAsignacionPct").value || 0));
      cfg.infraGlobal = Math.max(0, readLocaleInputNumber("cfInfraGlobal", 0));
      cfg.infraAsignacionPct = Math.max(0, Number(document.getElementById("cfInfraAsignacionPct").value || 0));
      cfg.etapasPanaderia = cfg.etapasPanaderia || {};
      cfg.etapasPasteleria = cfg.etapasPasteleria || {};
      const stageTarget = normalizeRecipeType(receta.tipo) === "pasteleria" ? cfg.etapasPasteleria : cfg.etapasPanaderia;
      stageTarget.mezcladoMin = Math.max(0, Number(document.getElementById("cfMezcladoMin").value || 0));
      stageTarget.laminadoMin = Math.max(0, Number(document.getElementById("cfLaminadoMin").value || 0));
      stageTarget.formadoMin = Math.max(0, Number(document.getElementById("cfFormadoMin").value || 0));
      stageTarget.fermentadoMin = Math.max(0, Number(document.getElementById("cfFermentadoMin").value || 0));
      stageTarget.horneadoMin = Math.max(0, Number(document.getElementById("cfHorneadoMin").value || 0));

      cs.cfCalc = cfg;
      const result = calculateCfFromConfig(cs, receta.tipo);
      cs.cargaFabril = Number(result.cfFinal.toFixed(4));
      saveState();
      renderCostStructureView();
    }

    function toggleCfPanel() {
      const panel = document.getElementById("csCfPanel");
      if (!panel) return;
      panel.classList.toggle("hidden");
    }

    function applyManualUnitMargin() {
      const receta = currentRecipe();
      if (!receta) return;
      const cs = ensureCostStructure(receta);
      const targetPct = Number(parseLocaleNumber(document.getElementById("csMbUnitPctInput").value) || 0);
      const pcUnit = Number(cs.costoReceta || 0) + Number(cs.cargaFabril || 0) + Number(cs.materialEmpaque || 0);
      if (targetPct >= 100) {
        alert("El margen unitario debe ser menor a 100%.");
        return;
      }
      cs.pvUnitario = Number((pcUnit / (1 - (targetPct / 100))).toFixed(4));
      cs.pvLockMode = "margen";
      saveState();
      renderCostStructureView();
    }

    function applyManualBoxMargin() {
      const receta = currentRecipe();
      if (!receta) return;
      const cs = ensureCostStructure(receta);
      const targetPct = Number(parseLocaleNumber(document.getElementById("csMbCajaPctInput").value) || 0);
      if (targetPct >= 100) {
        alert("El margen por caja debe ser menor a 100%.");
        return;
      }

      const pcUnit = Number(cs.costoReceta || 0) + Number(cs.cargaFabril || 0) + Number(cs.materialEmpaque || 0);
      const totalCostoEmpaque = pcUnit * Math.max(1, Number(cs.unidadesPorEmpaque || 1)) * Math.max(1, Number(cs.empaques || 1));
      const totalCostos = totalCostoEmpaque + Number(cs.transporte || 0) + Number(cs.costosOperativos || 0);
      cs.pvCaja = Number((totalCostos / (1 - (targetPct / 100))).toFixed(4));
      cs.pvLockMode = "margen";
      saveState();
      renderCostStructureView();
    }

    function calculateIngredientPercentages(recipe) {
      const ingredientes = Array.isArray(recipe?.ingredientes) ? recipe.ingredientes : [];
      const totalCantidad = ingredientes.reduce((acc, i) => {
        const mp = state.materiasPrimas.find(x => x.id === i.mpId);
        const qGr = toIngredientGrams(i, mp);
        if (Number.isFinite(qGr) && qGr > 0) return acc + qGr;
        const q = Number(i.cantidad || 0);
        return acc + (Number.isFinite(q) && q > 0 ? q : 0);
      }, 0);

      ingredientes.forEach(i => {
        const mp = state.materiasPrimas.find(x => x.id === i.mpId);
        const qGr = toIngredientGrams(i, mp);
        const qComparable = Number.isFinite(qGr) ? qGr : Number(i.cantidad || 0);
        if (totalCantidad > 0 && Number.isFinite(qComparable) && qComparable >= 0) {
          i.porcentaje = (qComparable / totalCantidad) * 100;
        } else {
          i.porcentaje = 0;
        }
      });

      return totalCantidad;
    }

    function normalizeRecipeByUnitWeight(recipe) {
      const ingredientes = Array.isArray(recipe?.ingredientes) ? recipe.ingredientes : [];
      const costeo = recipe?.costeo || {};
      const pesoUnidad = Number(costeo.pesoUnidad || 0);
      const unidades = Number(costeo.unidadesDeseadas || recipe?.produccion || 0);

      if (!(Number.isFinite(pesoUnidad) && pesoUnidad > 0 && Number.isFinite(unidades) && unidades > 0)) {
        return { applied: false, totalTarget: null, totalBefore: null, factor: null };
      }

      const totalTarget = pesoUnidad * unidades;
      const totalBefore = ingredientes.reduce((acc, i) => {
        const q = Number(i.cantidad || 0);
        const mp = state.materiasPrimas.find(x => x.id === i.mpId);
        const qGr = toIngredientGrams(i, mp);
        if (Number.isFinite(qGr) && qGr > 0) return acc + qGr;
        return acc + (Number.isFinite(q) && q > 0 ? q : 0);
      }, 0);

      if (!(Number.isFinite(totalBefore) && totalBefore > 0)) {
        recipe.costeo = {
          ...costeo,
          batchDeseadoGr: Number(totalTarget.toFixed(4))
        };
        return { applied: false, totalTarget, totalBefore, factor: null };
      }

      const factor = totalTarget / totalBefore;
      ingredientes.forEach(i => {
        const cantidad = Number(i.cantidad || 0);
        if (Number.isFinite(cantidad)) {
          i.cantidad = Number((cantidad * factor).toFixed(4));
        }

        const costoReceta = Number(i.costoReceta);
        if (Number.isFinite(costoReceta) && costoReceta >= 0) {
          i.costoReceta = Number((costoReceta * factor).toFixed(4));
        }
      });

      recipe.costeo = {
        ...costeo,
        batchDeseadoGr: Number(totalTarget.toFixed(4))
      };

      calculateIngredientPercentages(recipe);
      return { applied: true, totalTarget, totalBefore, factor };
    }

    function applyRealtimeWeightNormalization(persist = false) {
      const receta = currentRecipe();
      if (!receta) return;

      const version = document.getElementById("costeoVersion")?.value?.trim() || receta.costeo?.version || "";
      const pesoInput = Number(document.getElementById("costeoPesoUnidad")?.value || 0);
      const unidadesInput = Number(document.getElementById("costeoUnidadesDeseadas")?.value || 0);

      const pesoUnidad = Number.isFinite(pesoInput) && pesoInput > 0 ? pesoInput : null;
      const unidadesDeseadas = Number.isFinite(unidadesInput) && unidadesInput > 0
        ? unidadesInput
        : Math.max(1, Number(receta.produccion || receta.costeo?.unidadesDeseadas || 1));

      receta.costeo = {
        ...(receta.costeo || {}),
        version,
        pesoUnidad,
        unidadesDeseadas,
        batchDeseadoGr: (pesoUnidad && unidadesDeseadas) ? Number((pesoUnidad * unidadesDeseadas).toFixed(4)) : null
      };

      receta.produccion = unidadesDeseadas;

      if (pesoUnidad && unidadesDeseadas) {
        normalizeRecipeByUnitWeight(receta);
      } else {
        calculateIngredientPercentages(receta);
      }

      if (persist) saveState();
      renderRecipeEditor();
      renderRecipes();
    }

    function scheduleRealtimeWeightNormalization() {
      if (liveCosteoTimer) clearTimeout(liveCosteoTimer);
      liveCosteoTimer = setTimeout(() => {
        applyRealtimeWeightNormalization(false);
      }, 220);
    }

    function renderRecipeEditor() {
      const receta = currentRecipe();
      document.getElementById("btnEliminarReceta").disabled = !receta;

      if (!receta) {
        document.getElementById("recetaNombre").value = "";
        document.getElementById("recetaProduccion").value = "";
        document.getElementById("recetaTipo").value = "panaderia";
        document.getElementById("recetaDescripcion").value = "";
        document.getElementById("costeoVersion").value = "";
        document.getElementById("costeoPesoUnidad").value = "";
        document.getElementById("costeoUnidadesDeseadas").value = "";
        document.getElementById("costeoBatchDeseado").value = "";
        document.getElementById("batchRefIngredient").innerHTML = "";
        document.getElementById("batchRefAvailable").value = "";
        document.getElementById("txtBatchFactor").textContent = "";
        document.getElementById("tablaIngredientesBody").innerHTML = "<tr><td colspan='7' class='muted'>Selecciona o crea una receta.</td></tr>";
        document.getElementById("tablaTotalCantidad").textContent = "0.00";
        document.getElementById("tablaTotalCosto").textContent = "$0.00";
        document.getElementById("tablaUnidadBase").textContent = "gr";
        document.getElementById("txtCostoBase").textContent = "$0.00";
        document.getElementById("txtPrecio").textContent = "$0.00";
        document.getElementById("txtFormatoReceta").textContent = "";
        document.getElementById("txtBalancePeso").textContent = "";
        return;
      }

      document.getElementById("recetaNombre").value = receta.nombre || "";
      document.getElementById("recetaProduccion").value = receta.produccion || 1;
      document.getElementById("recetaTipo").value = normalizeRecipeType(receta.tipo);
      document.getElementById("recetaDescripcion").value = receta.descripcion || "";

      const costeo = receta.costeo || {};
      const unitsFromProduccion = Number(receta.produccion || 1);
      const pesoUnidad = Number(costeo.pesoUnidad || 0);
      const unidadesDeseadas = Number(costeo.unidadesDeseadas || unitsFromProduccion);
      const batchCalc = (Number.isFinite(pesoUnidad) && Number.isFinite(unidadesDeseadas)) ? (pesoUnidad * unidadesDeseadas) : null;

      document.getElementById("costeoVersion").value = costeo.version || "";
      document.getElementById("costeoPesoUnidad").value = Number.isFinite(pesoUnidad) && pesoUnidad > 0 ? String(pesoUnidad) : "";
      document.getElementById("costeoUnidadesDeseadas").value = Number.isFinite(unidadesDeseadas) && unidadesDeseadas > 0 ? String(unidadesDeseadas) : "";
      document.getElementById("costeoBatchDeseado").value = Number.isFinite(Number(costeo.batchDeseadoGr)) && Number(costeo.batchDeseadoGr) > 0
        ? String(Number(costeo.batchDeseadoGr))
        : (batchCalc && batchCalc > 0 ? String(batchCalc) : "");

      const batchRefSelect = document.getElementById("batchRefIngredient");
      if ((receta.ingredientes || []).length) {
        batchRefSelect.innerHTML = receta.ingredientes.map((i, idx) => {
          const mp = state.materiasPrimas.find(x => x.id === i.mpId);
          const nombre = mp?.nombre || "Ingrediente";
          const unidad = i.unidad || mp?.unidadBase || "un";
          const cantidad = Number(i.cantidad || 0);
          return `<option value="${idx}">${escapeHtml(nombre)} (${cantidad.toFixed(4)} ${escapeHtml(unidad)})</option>`;
        }).join("");
      } else {
        batchRefSelect.innerHTML = "";
      }

      const body = document.getElementById("tablaIngredientesBody");
      let totalCantidadRender = 0;
      if (!(receta.ingredientes || []).length) {
        body.innerHTML = "<tr><td colspan='8' class='muted'>No hay ingredientes.</td></tr>";
        document.getElementById("tablaTotalCantidad").textContent = "0.00";
        document.getElementById("tablaTotalCosto").textContent = "$0.00";
        document.getElementById("tablaUnidadBase").textContent = "gr";
      } else {
        const totalCantidad = calculateIngredientPercentages(receta);
        totalCantidadRender = totalCantidad;
        let totalCosto = 0;

        body.innerHTML = receta.ingredientes.map((i, idx) => {
          const mp = state.materiasPrimas.find(x => x.id === i.mpId);
          const nombre = mp ? mp.nombre : "Insumo eliminado";
          const unidad = i.unidad || mp?.unidadBase || "un";
          const proveedor = i.proveedor || mp?.proveedor || "";
          const gramEq = getIngredientGramEquivalent(i);
          let costoLinea = Number(i.costoReceta);
          if (!(Number.isFinite(costoLinea) && costoLinea >= 0)) {
            const ingQtyMass = toIngredientGrams(i, mp);
            const mpPackMass = toGrams(mp?.cantidadEmpaque || 0, mp?.unidadBase || "");
            const sameFamily = areUnitsCostCompatible(unidad, mp?.unidadBase || "");
            const gramBridge = Number.isFinite(ingQtyMass) && Number.isFinite(mpPackMass);
            if (sameFamily || gramBridge) {
              const qtyForCost = sameFamily
                ? (Number.isFinite(ingQtyMass) ? ingQtyMass : Number(i.cantidad || 0))
                : ingQtyMass;
              const packForCost = sameFamily
                ? (Number.isFinite(mpPackMass) ? mpPackMass : Number(mp?.cantidadEmpaque || 0))
                : mpPackMass;
              const precioEmp = Number(mp?.precioEmpaque || 0);
              const costoUnitario = packForCost > 0 ? (precioEmp / packForCost) : 0;
              costoLinea = costoUnitario * Math.max(0, Number(qtyForCost || 0));
            } else {
              costoLinea = 0;
            }
          }
          totalCosto += Number.isFinite(costoLinea) ? costoLinea : 0;

          return `<tr>
            <td>${Number(i.cantidad || 0).toFixed(2)}</td>
            <td>${escapeHtml(String(unidad))}</td>
            <td>${escapeHtml(String(nombre))}</td>
            <td>${Number(i.porcentaje || 0).toFixed(2)}%</td>
            <td>${escapeHtml(String(proveedor || "-"))}</td>
            <td>${Number.isFinite(gramEq) ? gramEq.toFixed(4) : "-"}</td>
            <td>$${Number(costoLinea || 0).toFixed(2)}</td>
            <td style='display:flex; gap:.35rem; flex-wrap:wrap;'><button class='btn' onclick='editIngredientGramEquivalent(${idx})'>Equiv.</button><button class='btn' onclick='removeIngredient(${idx})'>Quitar</button></td>
          </tr>`;
        }).join("");

        document.getElementById("tablaTotalCantidad").textContent = totalCantidad.toFixed(2);
        const firstUnit = receta.ingredientes[0]?.unidad || state.materiasPrimas.find(x => x.id === receta.ingredientes[0]?.mpId)?.unidadBase || "gr";
        document.getElementById("tablaUnidadBase").textContent = firstUnit;
        document.getElementById("tablaTotalCosto").textContent = `$${totalCosto.toFixed(2)}`;
      }

      const c = computeRecipe(receta);
      document.getElementById("txtCostoBase").textContent = "$" + c.costoBase.toFixed(2);
      document.getElementById("txtPrecio").textContent = "$" + c.precio.toFixed(2);

      const costeoView = receta.costeo || null;
      const formato = document.getElementById("txtFormatoReceta");
      if (!costeoView) {
        formato.textContent = "";
        document.getElementById("txtBalancePeso").textContent = "";
      } else {
        const peso = Number(costeoView.pesoUnidad || 0);
        const unidades = Number(costeoView.unidadesDeseadas || receta.produccion || 1);
        const batchGr = Number(costeoView.batchDeseadoGr || 0);
        formato.textContent = `Formato CSV: peso unidad ${peso || "-"} gr | unidades deseadas ${unidades} | batch ${batchGr || "-"} gr | version ${costeoView.version || "-"}`;

        const objetivo = (Number.isFinite(peso) && peso > 0 && Number.isFinite(unidades) && unidades > 0) ? (peso * unidades) : null;
        if (Number.isFinite(objetivo) && objetivo > 0) {
          const diff = totalCantidadRender - objetivo;
          const pct = objetivo > 0 ? ((diff / objetivo) * 100) : 0;
          document.getElementById("txtBalancePeso").textContent = `Peso total ingredientes: ${totalCantidadRender.toFixed(2)} gr | Objetivo: ${objetivo.toFixed(2)} gr | Diferencia: ${diff.toFixed(2)} gr (${pct.toFixed(2)}%)`;
        } else {
          document.getElementById("txtBalancePeso").textContent = "Define peso unidad y unidades para activar ajuste proporcional de gramaje.";
        }
      }
    }

    function renderAll() {
      ensureWarehouses();
      renderKpis();
      renderRecipes();
      renderDashboardCharts();
      renderInventory();
      renderProductionView();
      renderPlanillaView();
      renderLogsView();
      renderRecipeEditor();
      renderCostStructureView();
    }
    window.renderAll = renderAll;

    function createRecipe() {
      const r = {
        id: uid(),
        nombre: "Nueva receta",
        descripcion: "",
        tipo: dashboardTypeFilter,
        produccion: 1,
        ingredientes: []
      };
      state.recetas.unshift(r);
      state.activeRecipeId = r.id;
      saveState();
      switchView("recetario");
    }

    function openRecipe(id) {
      state.activeRecipeId = id;
      saveState();
      switchView("recetario");
    }

    function deleteRecipe(id) {
      if (!confirm("Eliminar receta?")) return;
      state.recetas = state.recetas.filter(r => r.id !== id);
      if (state.activeRecipeId === id) state.activeRecipeId = state.recetas[0]?.id || null;
      saveState();
      renderAll();
    }

    function saveRecipeChanges() {
      const receta = currentRecipe();
      if (!receta) return;
      receta.nombre = document.getElementById("recetaNombre").value.trim();
      receta.descripcion = document.getElementById("recetaDescripcion").value.trim();
      receta.tipo = normalizeRecipeType(document.getElementById("recetaTipo").value);
      receta.produccion = Math.max(1, Number(document.getElementById("recetaProduccion").value || 1));

      const costeoVersion = document.getElementById("costeoVersion").value.trim();
      const costeoPesoUnidad = Number(document.getElementById("costeoPesoUnidad").value || 0);
      const costeoUnidadesDeseadas = Math.max(1, Number(document.getElementById("costeoUnidadesDeseadas").value || receta.produccion || 1));
      let costeoBatchDeseado = Number(document.getElementById("costeoBatchDeseado").value || 0);
      if (Number.isFinite(costeoPesoUnidad) && costeoPesoUnidad > 0 && Number.isFinite(costeoUnidadesDeseadas) && costeoUnidadesDeseadas > 0) {
        costeoBatchDeseado = (Number.isFinite(costeoPesoUnidad) ? costeoPesoUnidad : 0) * costeoUnidadesDeseadas;
      } else if (!(Number.isFinite(costeoBatchDeseado) && costeoBatchDeseado > 0)) {
        costeoBatchDeseado = 0;
      }

      receta.costeo = {
        version: costeoVersion,
        pesoUnidad: Number.isFinite(costeoPesoUnidad) && costeoPesoUnidad > 0 ? costeoPesoUnidad : null,
        unidadesDeseadas: costeoUnidadesDeseadas,
        batchDeseadoGr: Number.isFinite(costeoBatchDeseado) && costeoBatchDeseado > 0 ? costeoBatchDeseado : null
      };

      receta.produccion = costeoUnidadesDeseadas;

      const scaleInfo = normalizeRecipeByUnitWeight(receta);

      calculateIngredientPercentages(receta);
      logSystem("recetas", "update", "receta", { recipeId: receta.id, nombre: receta.nombre || "" });
      saveState();
      renderAll();
      if (scaleInfo.applied) {
        alert(`Receta guardada. Gramajes ajustados con factor ${scaleInfo.factor.toFixed(4)} para cumplir peso objetivo.`);
      } else {
        alert("Receta guardada en almacenamiento local.");
      }
    }

    function addMp() {
      const nombre = document.getElementById("mpNombre").value.trim();
      if (!nombre) {
        alert("El nombre del insumo es obligatorio.");
        return;
      }
      const unidadRaw = document.getElementById("mpUnidad").value.trim() || "un";
      const cantidadRaw = Math.max(0, Number(parseLocaleNumber(document.getElementById("mpCantidad").value) || 1));
      const factor = getMassUnitFactor(unidadRaw);
      const unidadBase = Number.isFinite(factor) ? "gr" : unidadRaw;
      const cantidadEmpaque = Number.isFinite(factor) ? Number((cantidadRaw * factor).toFixed(6)) : cantidadRaw;

      state.materiasPrimas.push({
        id: uid(),
        nombre,
        proveedor: document.getElementById("mpProveedor").value.trim(),
        unidadBase,
        cantidadEmpaque,
        precioEmpaque: Math.max(0, readLocaleInputNumber("mpPrecio", 0))
      });
      logSystem("inventario", "create", "materia_prima", { nombre });
      saveState();
      renderAll();
      ["mpNombre", "mpProveedor", "mpUnidad", "mpCantidad", "mpPrecio"].forEach(id => document.getElementById(id).value = "");
    }

    function editMp(id) {
      const mp = state.materiasPrimas.find(x => x.id === id);
      if (!mp) return;

      const nombre = prompt("Nombre del producto:", String(mp.nombre || ""));
      if (nombre === null) return;
      const nombreClean = String(nombre || "").trim();
      if (!nombreClean) {
        alert("El nombre del insumo es obligatorio.");
        return;
      }

      const proveedor = prompt("Proveedor:", String(mp.proveedor || ""));
      if (proveedor === null) return;

      const unidad = prompt("Unidad (ej: gr, kg, ml, lt, un):", String(mp.unidadBase || "un"));
      if (unidad === null) return;
      const unidadRaw = String(unidad || "").trim() || "un";

      const cantidadText = prompt("Cantidad por empaque:", String(mp.cantidadEmpaque || 0));
      if (cantidadText === null) return;
      const cantidadRaw = Math.max(0, Number(parseLocaleNumber(cantidadText) || 0));

      const precioText = prompt("Precio por empaque (B/.):", String(mp.precioEmpaque || 0));
      if (precioText === null) return;
      const precioEmpaque = Math.max(0, Number(parseLocaleNumber(precioText) || 0));

      const factor = getMassUnitFactor(unidadRaw);
      const unidadBase = Number.isFinite(factor) ? "gr" : unidadRaw;
      const cantidadEmpaque = Number.isFinite(factor) ? Number((cantidadRaw * factor).toFixed(6)) : cantidadRaw;

      mp.nombre = nombreClean;
      mp.proveedor = String(proveedor || "").trim();
      mp.unidadBase = unidadBase;
      mp.cantidadEmpaque = cantidadEmpaque;
      mp.precioEmpaque = precioEmpaque;

      logSystem("inventario", "update", "materia_prima", { id: mp.id, nombre: mp.nombre });
      saveState();
      renderAll();
      alert("Producto de inventario actualizado.");
    }

    function normalizeHeader(h) {
      const base = String(h || "").trim().toLowerCase();
      const clean = base
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "");

      const map = {
        nombre: "nombre",
        ingrediente: "nombre",
        materiaprima: "nombre",
        proveedor: "proveedor",
        unidad: "unidadBase",
        unidadbase: "unidadBase",
        cantidad: "cantidadEmpaque",
        cantidadempaque: "cantidadEmpaque",
        preciopaque: "precioEmpaque",
        precioempaque: "precioEmpaque",
        precio: "precioEmpaque"
      };
      return map[clean] || clean;
    }

    function parseCsvRows(text) {
      const rows = String(text || "").split(/\r?\n/).filter(r => r.trim());
      if (!rows.length) return [];

      const first = rows[0].split(/[;,\t]/).map(x => x.trim());
      const normalized = first.map(normalizeHeader);
      const hasHeader = normalized.includes("nombre") || normalized.includes("precioEmpaque");
      const dataRows = hasHeader ? rows.slice(1) : rows;

      return dataRows.map(row => {
        const delimiter = row.includes(";") ? ";" : (row.includes("\t") ? "\t" : ",");
        const cols = row.split(delimiter).map(c => c.trim());

        if (hasHeader) {
          const obj = {};
          normalized.forEach((k, i) => { obj[k] = cols[i] || ""; });
          return obj;
        }

        return {
          nombre: cols[0] || "",
          proveedor: cols[1] || "",
          unidadBase: cols[2] || "un",
          cantidadEmpaque: cols[3] || "1",
          precioEmpaque: cols[4] || "0"
        };
      });
    }

    function sanitizeImportedMp(raw) {
      const nombre = String(raw.nombre || "").trim();
      if (!nombre) return null;
      return {
        id: uid(),
        nombre,
        proveedor: String(raw.proveedor || "").trim(),
        unidadBase: String(raw.unidadBase || "un").trim() || "un",
        cantidadEmpaque: Math.max(0, Number(String(raw.cantidadEmpaque || "1").replace(",", ".")) || 1),
        precioEmpaque: Math.max(0, Number(String(raw.precioEmpaque || "0").replace(",", ".")) || 0)
      };
    }

    function upsertMateriaPrima(mp) {
      const idx = state.materiasPrimas.findIndex(x => x.nombre.toLowerCase() === mp.nombre.toLowerCase());
      if (idx === -1) {
        state.materiasPrimas.push(mp);
      } else {
        state.materiasPrimas[idx] = { ...state.materiasPrimas[idx], ...mp, id: state.materiasPrimas[idx].id };
      }
    }

    async function importMassiveIngredients(file) {
      if (!file) return;

      const name = file.name.toLowerCase();
      let rawRows = [];

      if (name.endsWith(".csv")) {
        const text = await file.text();
        rawRows = parseCsvRows(text);
      } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
        if (typeof XLSX === "undefined") {
          alert("No se pudo cargar el lector de Excel. Revisa tu conexiÃ³n a internet.");
          return;
        }
        const arr = await file.arrayBuffer();
        const wb = XLSX.read(arr, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
        rawRows = json.map(row => {
          const normalized = {};
          Object.keys(row).forEach(k => {
            normalized[normalizeHeader(k)] = row[k];
          });
          return normalized;
        });
      } else {
        alert("Formato no soportado. Usa CSV o XLSX.");
        return;
      }

      let processed = 0;
      rawRows.forEach(r => {
        const mp = sanitizeImportedMp(r);
        if (!mp) return;
        upsertMateriaPrima(mp);
        processed += 1;
      });

      logSystem("inventario", "import", "materias_primas", { processed });
      saveState();
      renderAll();
      alert(`Carga masiva finalizada: ${processed} ingredientes procesados.`);
    }

    function deleteMp(id) {
      if (!confirm("Eliminar materia prima?")) return;
      const removed = state.materiasPrimas.find(mp => mp.id === id);
      state.materiasPrimas = state.materiasPrimas.filter(mp => mp.id !== id);
      state.recetas.forEach(r => {
        r.ingredientes = (r.ingredientes || []).filter(i => i.mpId !== id);
      });
      logSystem("inventario", "delete", "materia_prima", { id, nombre: removed?.nombre || "" });
      saveState();
      renderAll();
    }

    function addIngredient() {
      const receta = currentRecipe();
      if (!receta) {
        alert("Primero crea o abre una receta.");
        return;
      }
      const mpId = document.getElementById("ingMp").value;
      const cantidad = Number(document.getElementById("ingCantidad").value || 0);
      if (!mpId || cantidad <= 0) {
        alert("Selecciona insumo y cantidad valida.");
        return;
      }
      const mp = state.materiasPrimas.find(x => x.id === mpId);
      const unidadRaw = mp?.unidadBase || "un";
      const factor = getMassUnitFactor(unidadRaw);
      const unidad = Number.isFinite(factor) ? "gr" : unidadRaw;
      const cantidadNormalizada = Number.isFinite(factor)
        ? Number((cantidad * factor).toFixed(6))
        : cantidad;
      receta.ingredientes.push({
        mpId,
        cantidad: cantidadNormalizada,
        unidad,
        porcentaje: null,
        proveedor: mp?.proveedor || "",
        costoReceta: null
      });
      document.getElementById("ingCantidad").value = "";
      saveState();
      renderRecipeEditor();
      renderRecipes();
    }

    function parseLocaleNumber(value) {
      if (value === null || value === undefined) return null;
      let s = String(value).trim();
      if (!s) return null;

      s = s.replace(/b\/.?/ig, "").replace(/\$/g, "").replace(/%/g, "").replace(/\s+/g, "");

      const comma = s.lastIndexOf(",");
      const dot = s.lastIndexOf(".");

      if (comma !== -1 && dot !== -1) {
        if (comma > dot) {
          s = s.replace(/\./g, "").replace(",", ".");
        } else {
          s = s.replace(/,/g, "");
        }
      } else if (comma !== -1) {
        s = s.replace(",", ".");
      }

      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }

    function readLocaleInputNumber(inputId, fallback = 0) {
      const el = document.getElementById(inputId);
      const parsed = parseLocaleNumber(el?.value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    function toMoneyInputString(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "";
      return n.toFixed(4).replace(/\.?0+$/, "");
    }

    function setupMoneyInputs() {
      const moneyInputIds = [
        "mpPrecio",
        "empSalario",
        "csCostoReceta",
        "csMaterialEmpaque",
        "csTransporte",
        "csCostosOperativos",
        "csPvUnitario",
        "csPvCaja",
        "cfSalarioBase",
        "cfEnergiaGlobal",
        "cfInfraGlobal"
      ];

      moneyInputIds.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        // Text mode lets users enter values like "B/. 0.00" or "0,75" consistently.
        el.type = "text";
        el.inputMode = "decimal";
        if (!el.placeholder) el.placeholder = "B/. 0.00";
        el.addEventListener("blur", () => {
          const parsed = parseLocaleNumber(el.value);
          if (Number.isFinite(parsed)) el.value = toMoneyInputString(Math.max(0, parsed));
        });
      });
    }

    function parseDelimitedLine(line, delimiter) {
      const out = [];
      let cur = "";
      let inQuotes = false;

      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') {
            cur += '"';
            i += 1;
          } else {
            inQuotes = !inQuotes;
          }
          continue;
        }
        if (ch === delimiter && !inQuotes) {
          out.push(cur.trim());
          cur = "";
          continue;
        }
        cur += ch;
      }
      out.push(cur.trim());
      return out;
    }

    function normalizeRecipeHeader(raw) {
      const k = String(raw || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "")
        .replace(/[^a-z0-9]/g, "");

      const map = {
        receta: "receta",
        nombrereceta: "receta",
        producto: "receta",
        descripcionreceta: "receta",
        tipodereceta: "tipo",
        tiporeceta: "tipo",
        tipo: "tipo",
        version: "version",
        pesounidad: "pesoUnidad",
        pesounidadgr: "pesoUnidad",
        unidadesdeseadas: "unidadesDeseadas",
        unidades: "unidadesDeseadas",
        batchdeseadog: "batchDeseadoGr",
        batchg: "batchDeseadoGr",
        batchdeseado: "batchDeseadoGr",
        cantidad: "cantidad",
        unidad: "unidad",
        descripcion: "descripcion",
        ingrediente: "descripcion",
        porcentaje: "porcentaje",
        proveedor: "proveedor",
        equivalenciagr: "gramosEquivalencia",
        equivalenciagramos: "gramosEquivalencia",
        gramosporunidad: "gramosEquivalencia",
        grporunidad: "gramosEquivalencia",
        costoenreceta: "costoReceta",
        costoreceta: "costoReceta",
        costo: "costoReceta"
      };
      return map[k] || k;
    }

    function parseRecipesCsvText(text) {
      const rows = String(text || "").split(/\r?\n/).filter(r => r.trim());
      if (!rows.length) return [];

      const headLine = rows[0];
      const delimiter = (headLine.match(/;/g) || []).length > (headLine.match(/,/g) || []).length ? ";" : ",";
      const rawHeaders = parseDelimitedLine(headLine, delimiter);
      const headers = rawHeaders.map(normalizeRecipeHeader);

      return rows.slice(1).map(line => {
        const cols = parseDelimitedLine(line, delimiter);
        const obj = {};
        headers.forEach((h, i) => {
          obj[h || `col${i + 1}`] = cols[i] || "";
        });
        return obj;
      });
    }

    function createOrUpdateMpFromRecipeRow(row) {
      const nombre = String(row.descripcion || "").trim();
      if (!nombre) return null;

      const proveedor = String(row.proveedor || "").trim();
      const unidadRaw = String(row.unidad || "gr").trim() || "gr";
      const unidadFactor = getMassUnitFactor(unidadRaw);
      const unidad = Number.isFinite(unidadFactor) ? "gr" : unidadRaw;
      const cantidad = parseLocaleNumber(row.cantidad);
      const cantidadNormalizada = Number.isFinite(cantidad) && Number.isFinite(unidadFactor)
        ? Number((cantidad * unidadFactor).toFixed(6))
        : cantidad;
      const costoReceta = parseLocaleNumber(row.costoReceta);

      let mp = state.materiasPrimas.find(x => x.nombre.toLowerCase() === nombre.toLowerCase());
      if (!mp) {
        mp = {
          id: uid(),
          nombre,
          proveedor,
          unidadBase: unidad,
          cantidadEmpaque: 1,
          precioEmpaque: 0
        };
        state.materiasPrimas.push(mp);
      }

      if (proveedor && !mp.proveedor) mp.proveedor = proveedor;
      if (unidad && !mp.unidadBase) mp.unidadBase = unidad;

      if (Number.isFinite(cantidadNormalizada) && Number.isFinite(costoReceta) && cantidadNormalizada > 0 && !mp.precioEmpaque) {
        mp.cantidadEmpaque = 1;
        mp.precioEmpaque = costoReceta / cantidadNormalizada;
      }

      return mp;
    }

    function importMassiveRecipesFromCsv(file) {
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = String(reader.result || "");
          const rows = parseRecipesCsvText(text);
          if (!rows.length) {
            alert("El CSV no contiene filas de recetas.");
            return;
          }

          const groups = new Map();
          rows.forEach((row, idx) => {
            const recetaNombre = String(row.receta || "").trim() || `Receta CSV ${idx + 1}`;
            const version = String(row.version || "").trim();
            const key = `${recetaNombre}__${version}`;

            if (!groups.has(key)) {
              const pesoUnidad = parseLocaleNumber(row.pesoUnidad);
              const unidadesDeseadas = parseLocaleNumber(row.unidadesDeseadas);
              const batchDeseadoGr = parseLocaleNumber(row.batchDeseadoGr);
              const tipo = normalizeRecipeType(row.tipo);
              groups.set(key, {
                nombre: recetaNombre,
                tipo,
                version,
                pesoUnidad,
                unidadesDeseadas,
                batchDeseadoGr,
                rows: []
              });
            }
            groups.get(key).rows.push(row);
          });

          let imported = 0;

          groups.forEach(g => {
            const produccion = Number.isFinite(g.unidadesDeseadas) && g.unidadesDeseadas > 0 ? g.unidadesDeseadas : 1;
            const receta = {
              id: uid(),
              nombre: g.nombre,
              descripcion: g.version ? `Version ${g.version}` : "Importada desde CSV",
              tipo: normalizeRecipeType(g.tipo),
              produccion,
              ingredientes: [],
              costeo: {
                version: g.version || "",
                pesoUnidad: Number.isFinite(g.pesoUnidad) ? g.pesoUnidad : null,
                unidadesDeseadas: Number.isFinite(g.unidadesDeseadas) ? g.unidadesDeseadas : produccion,
                batchDeseadoGr: Number.isFinite(g.batchDeseadoGr) ? g.batchDeseadoGr : null
              }
            };

            g.rows.forEach(row => {
              const mp = createOrUpdateMpFromRecipeRow(row);
              if (!mp) return;

              const cantidad = parseLocaleNumber(row.cantidad);
              const unidadRaw = String(row.unidad || mp.unidadBase || "gr").trim() || "gr";
              const unitFactor = getMassUnitFactor(unidadRaw);
              const unidad = Number.isFinite(unitFactor) ? "gr" : unidadRaw;
              const cantidadNormalizada = Number.isFinite(cantidad) && Number.isFinite(unitFactor)
                ? Number((cantidad * unitFactor).toFixed(6))
                : (Number.isFinite(cantidad) ? cantidad : 0);
              const porcentaje = parseLocaleNumber(row.porcentaje);
              const gramosEquivalencia = parseLocaleNumber(row.gramosEquivalencia);
              const costoReceta = parseLocaleNumber(row.costoReceta);

              receta.ingredientes.push({
                mpId: mp.id,
                cantidad: cantidadNormalizada,
                unidad,
                porcentaje: Number.isFinite(porcentaje) ? porcentaje : null,
                proveedor: String(row.proveedor || mp.proveedor || "").trim(),
                gramosEquivalencia: Number.isFinite(gramosEquivalencia) && gramosEquivalencia > 0 ? Number(gramosEquivalencia.toFixed(6)) : null,
                costoReceta: Number.isFinite(costoReceta) ? costoReceta : null
              });
            });

            if (!receta.ingredientes.length) return;
            normalizeRecipeByUnitWeight(receta);
            state.recetas.unshift(receta);
            imported += 1;
          });

          if (!imported) {
            alert("No se pudieron importar recetas desde el CSV. Revisa columnas y contenido.");
            return;
          }

          state.activeRecipeId = state.recetas[0].id;
          logSystem("recetas", "import", "recetas_csv", { imported });
          saveState();
          renderAll();
          switchView("recetario");
          alert(`Carga masiva de recetas completada: ${imported} recetas importadas.`);
        } catch {
          alert("No se pudo procesar el CSV de recetas.");
        }
      };

      reader.readAsText(file);
    }

    function normalizeCostStructureHeader(raw) {
      const k = String(raw || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "")
        .replace(/[^a-z0-9]/g, "");

      const map = {
        producto: "producto",
        costoreceta: "costoReceta",
        cargafabril: "cargaFabril",
        totalcostounidad: "totalCostoUnidad",
        unidadesempaque: "unidadesEmpaque",
        costomaterialempaque: "costoMaterialEmpaque",
        totalcostoempaque: "totalCostoEmpaque",
        transporte: "transporte",
        costosoperativos: "costosOperativos",
        totalcostosacumulados: "totalCostosAcumulados",
        precioventapv: "pv",
        precioventa: "pv",
        precioventaunitariopvu: "pvu",
        precioventaunitario: "pvu",
        pvu: "pvu",
        preciocostounitariopcu: "pcu",
        preciocostounitario: "pcu",
        pcu: "pcu"
      };
      return map[k] || k;
    }

    function normalizeNameForMatch(value) {
      return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ");
    }

    function detectDelimiter(line) {
      const semicolons = (line.match(/;/g) || []).length;
      const commas = (line.match(/,/g) || []).length;
      const tabs = (line.match(/\t/g) || []).length;
      if (tabs >= semicolons && tabs >= commas) return "\t";
      if (semicolons >= commas) return ";";
      return ",";
    }

    function importCostStructuresFromCsv(file) {
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = String(reader.result || "");
          const rows = text.split(/\r?\n/).filter(r => r.trim());
          if (rows.length < 2) {
            alert("El CSV no contiene filas para importar estructura de costos.");
            return;
          }

          const delimiter = detectDelimiter(rows[0]);
          const rawHeaders = parseDelimitedLine(rows[0], delimiter);
          const headers = rawHeaders.map(normalizeCostStructureHeader);
          if (!headers.includes("producto")) {
            alert("El CSV debe incluir la columna Producto.");
            return;
          }

          let updated = 0;
          let notFound = 0;
          let invalid = 0;

          rows.slice(1).forEach(line => {
            const cols = parseDelimitedLine(line, delimiter);
            const row = {};
            headers.forEach((h, i) => {
              row[h || `col${i + 1}`] = cols[i] || "";
            });

            const producto = String(row.producto || "").trim();
            if (!producto) return;

            const productKey = normalizeNameForMatch(producto);
            const receta = state.recetas.find(r => normalizeNameForMatch(r.nombre) === productKey);
            if (!receta) {
              notFound += 1;
              return;
            }

            const cs = ensureCostStructure(receta);
            const draft = {
              costoReceta: Number(cs.costoReceta || 0),
              cargaFabril: Number(cs.cargaFabril || 0),
              unidadesPorEmpaque: Math.max(1, Number(cs.unidadesPorEmpaque || 1)),
              materialEmpaque: Number(cs.materialEmpaque || 0),
              transporte: Number(cs.transporte || 0),
              costosOperativos: Number(cs.costosOperativos || 0),
              pvCaja: Number(cs.pvCaja || 0),
              pvUnitario: Number(cs.pvUnitario || 0)
            };

            const costoReceta = parseLocaleNumber(row.costoReceta);
            const cargaFabril = parseLocaleNumber(row.cargaFabril);
            const totalCostoUnidad = parseLocaleNumber(row.totalCostoUnidad);
            const unidadesEmpaque = parseLocaleNumber(row.unidadesEmpaque);
            const costoMaterialEmpaque = parseLocaleNumber(row.costoMaterialEmpaque);
            const transporte = parseLocaleNumber(row.transporte);
            const costosOperativos = parseLocaleNumber(row.costosOperativos);
            const totalCostosAcumulados = parseLocaleNumber(row.totalCostosAcumulados);
            const pv = parseLocaleNumber(row.pv);
            const pvu = parseLocaleNumber(row.pvu);
            const pcu = parseLocaleNumber(row.pcu);

            if (Number.isFinite(costoReceta) && costoReceta >= 0) draft.costoReceta = costoReceta;
            if (Number.isFinite(cargaFabril) && cargaFabril >= 0) draft.cargaFabril = cargaFabril;
            if (Number.isFinite(unidadesEmpaque) && unidadesEmpaque >= 1) draft.unidadesPorEmpaque = unidadesEmpaque;
            if (Number.isFinite(costoMaterialEmpaque) && costoMaterialEmpaque >= 0) draft.materialEmpaque = costoMaterialEmpaque;
            if (Number.isFinite(transporte) && transporte >= 0) draft.transporte = transporte;
            if (Number.isFinite(costosOperativos) && costosOperativos >= 0) draft.costosOperativos = costosOperativos;
            if (Number.isFinite(pv) && pv >= 0) draft.pvCaja = pv;
            if (Number.isFinite(pvu) && pvu >= 0) draft.pvUnitario = pvu;

            if (Number.isFinite(pcu) && pcu >= 0 && !Number.isFinite(costoReceta)) {
              const maybeCostoReceta = pcu - draft.cargaFabril - draft.materialEmpaque;
              if (maybeCostoReceta >= 0) draft.costoReceta = maybeCostoReceta;
            }

            const computedTotalCostoUnidad = draft.costoReceta + draft.cargaFabril;
            const computedPcu = draft.costoReceta + draft.cargaFabril + draft.materialEmpaque;
            const computedTotalEmpaque = computedPcu * Math.max(1, Number(draft.unidadesPorEmpaque || 1)) * Math.max(1, Number(cs.empaques || 1));
            const computedTotalAcumulado = computedTotalEmpaque + draft.transporte + draft.costosOperativos;

            const invalidRow =
              (Number.isFinite(totalCostoUnidad) && Math.abs(totalCostoUnidad - computedTotalCostoUnidad) > 0.1) ||
              (Number.isFinite(pcu) && Math.abs(pcu - computedPcu) > 0.1) ||
              (Number.isFinite(totalCostosAcumulados) && Math.abs(totalCostosAcumulados - computedTotalAcumulado) > 0.2);

            if (invalidRow) {
              invalid += 1;
              return;
            }

            cs.costoReceta = Number(draft.costoReceta.toFixed(4));
            cs.cargaFabril = Number(draft.cargaFabril.toFixed(4));
            cs.unidadesPorEmpaque = Math.max(1, Number(draft.unidadesPorEmpaque.toFixed(4)));
            cs.materialEmpaque = Number(draft.materialEmpaque.toFixed(4));
            cs.transporte = Number(draft.transporte.toFixed(4));
            cs.costosOperativos = Number(draft.costosOperativos.toFixed(4));
            cs.pvCaja = Number(draft.pvCaja.toFixed(4));
            cs.pvUnitario = Number(draft.pvUnitario.toFixed(4));
            cs.pvLockMode = "manual";
            updated += 1;
          });

          logSystem("costos", "import", "estructura_costos_csv", { updated, notFound, invalid });
          saveState();
          renderAll();
          alert(`Importacion de estructura de costos completada. Actualizados: ${updated}. No encontrados: ${notFound}. Filas invalidas: ${invalid}.`);
        } catch {
          alert("No se pudo procesar el CSV de estructura de costos.");
        }
      };

      reader.readAsText(file);
    }

    function removeIngredient(index) {
      const receta = currentRecipe();
      if (!receta) return;
      receta.ingredientes.splice(index, 1);
      saveState();
      renderRecipeEditor();
      renderRecipes();
    }

    function editIngredientGramEquivalent(index) {
      const receta = currentRecipe();
      if (!receta) return;
      const ing = Array.isArray(receta.ingredientes) ? receta.ingredientes[index] : null;
      if (!ing) return;
      const mp = state.materiasPrimas.find(x => x.id === ing.mpId);
      const unit = ing.unidad || mp?.unidadBase || "un";
      if (Number.isFinite(getMassUnitFactor(unit))) {
        alert("Este ingrediente ya usa unidad de masa (gr/kg). No necesita equivalencia manual.");
        return;
      }

      const current = getIngredientGramEquivalent(ing);
      const raw = prompt(`Equivalencia para ${mp?.nombre || "ingrediente"}:\nÂ¿CuÃ¡ntos gramos representa 1 ${unit}?\nDeja vacÃ­o para borrar equivalencia.`, Number.isFinite(current) ? String(current) : "");
      if (raw === null) return;

      const parsed = parseLocaleNumber(raw);
      if (raw.trim() === "" || !Number.isFinite(parsed) || parsed <= 0) {
        delete ing.gramosEquivalencia;
      } else {
        ing.gramosEquivalencia = Number(parsed.toFixed(6));
      }

      calculateIngredientPercentages(receta);
      saveState();
      renderRecipeEditor();
      renderRecipes();
    }

    function deleteCurrentRecipe() {
      const receta = currentRecipe();
      if (!receta) return;
      deleteRecipe(receta.id);
    }

    function exportJson() {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "quantum-cost-control-data.json";
      a.click();
      URL.revokeObjectURL(url);
    }

    function computeAllCostsSnapshot() {
      return state.recetas.map(r => {
        const calc = computeRecipe(r);
        return {
          recipeId: r.id,
          nombre: r.nombre || "Sin nombre",
          costoBase: Number(calc.costoBase.toFixed(2)),
          costoUnidad: Number((calc.costoBase / Math.max(1, Number(r.produccion || 1))).toFixed(2)),
          precioSugerido: Number(calc.precio.toFixed(2))
        };
      });
    }

    function buildEncryptedDbPayload() {
      return {
        schema: "qcc-encrypted-db-v1",
        generatedAt: new Date().toISOString(),
        state,
        costos: computeAllCostsSnapshot()
      };
    }

    function downloadTextFile(content, fileName, mimeType = "application/octet-stream") {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    }

    function saveEncryptedDatabaseFile() {
      if (typeof CryptoJS === "undefined") {
        alert("No se pudo cargar modulo de cifrado.");
        return;
      }

      const pass = prompt("Clave para cifrar base de datos segura (.qccdb):");
      if (!pass || pass.length < 6) {
        alert("Debes ingresar una clave de al menos 6 caracteres.");
        return;
      }

      const payload = buildEncryptedDbPayload();
      const encrypted = CryptoJS.AES.encrypt(JSON.stringify(payload), pass).toString();
      const wrapper = {
        format: "QCC-ENC-V1",
        algorithm: "AES",
        payload: encrypted
      };

      downloadTextFile(JSON.stringify(wrapper, null, 2), "quantum_cost_control_secure.qccdb", "application/json");
      alert("Base de datos segura exportada.");
    }

    async function writeLinkedSecureSystemFile() {
      if (!linkedSecureAutoSaveEnabled || !linkedSecureFileHandle || !linkedSecurePassphrase) return;
      if (typeof CryptoJS === "undefined") return;

      try {
        const permission = await linkedSecureFileHandle.queryPermission({ mode: "readwrite" });
        if (permission !== "granted") {
          const req = await linkedSecureFileHandle.requestPermission({ mode: "readwrite" });
          if (req !== "granted") return;
        }

        const payload = buildEncryptedDbPayload();
        const encrypted = CryptoJS.AES.encrypt(JSON.stringify(payload), linkedSecurePassphrase).toString();
        const wrapper = {
          format: "QCC-ENC-V1",
          algorithm: "AES",
          generatedAt: new Date().toISOString(),
          payload: encrypted
        };

        const writable = await linkedSecureFileHandle.createWritable();
        await writable.write(JSON.stringify(wrapper, null, 2));
        await writable.close();
      } catch {
        console.warn("No se pudo actualizar el archivo cifrado enlazado.");
      }
    }

    function scheduleSecureSystemAutoSave() {
      if (!linkedSecureAutoSaveEnabled) return;
      if (secureAutoSaveTimer) clearTimeout(secureAutoSaveTimer);
      secureAutoSaveTimer = setTimeout(() => {
        writeLinkedSecureSystemFile();
      }, 280);
    }

    async function configureLinkedSecureAutoSave() {
      if (!window.showSaveFilePicker) {
        alert("Tu navegador no permite escritura directa de archivos locales. Se usara exportacion manual.");
        saveEncryptedDatabaseFile();
        return;
      }

      if (!linkedSecurePassphrase) {
        const pass = prompt("Define la clave para cifrar el archivo local del sistema (.qccdb):");
        if (!pass || pass.length < 6) {
          alert("Debes ingresar una clave de al menos 6 caracteres.");
          return;
        }
        linkedSecurePassphrase = pass;
      }

      if (!linkedSecureFileHandle) {
        try {
          linkedSecureFileHandle = await window.showSaveFilePicker({
            suggestedName: "quantum_cost_control_system.qccdb",
            types: [{
              description: "Base de datos segura Quantum",
              accept: { "application/json": [".qccdb"] }
            }]
          });
        } catch {
          alert("No se selecciono archivo para enlazar guardado automatico.");
          return;
        }
      }

      linkedSecureAutoSaveEnabled = true;
      await writeLinkedSecureSystemFile();
      alert("Archivo local cifrado enlazado. A partir de ahora se actualiza automaticamente en cada guardado.");
    }

    function restoreStateFromImported(importedState) {
      state = {
        materiasPrimas: Array.isArray(importedState.materiasPrimas) ? importedState.materiasPrimas : [],
        recetas: Array.isArray(importedState.recetas) ? importedState.recetas : [],
        activeRecipeId: importedState.activeRecipeId || null,
        warehouses: Array.isArray(importedState.warehouses) ? importedState.warehouses : [],
        payrollInfo: importedState.payrollInfo && typeof importedState.payrollInfo === "object" ? importedState.payrollInfo : {},
        productionReports: Array.isArray(importedState.productionReports) ? importedState.productionReports : [],
        productionHistoryRaw: Array.isArray(importedState.productionHistoryRaw) ? importedState.productionHistoryRaw : [],
        employees: Array.isArray(importedState.employees) ? importedState.employees : [],
        logsByMonth: importedState.logsByMonth && typeof importedState.logsByMonth === "object" ? importedState.logsByMonth : {}
      };
      saveState();
      renderAll();
      renderAiRecipePreview();
    }

    function loadEncryptedDatabaseFile(file) {
      if (!file) return;
      if (typeof CryptoJS === "undefined") {
        alert("No se pudo cargar modulo de cifrado.");
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        try {
          const obj = JSON.parse(String(reader.result || "{}"));
          if (obj.format !== "QCC-ENC-V1" || !obj.payload) {
            alert("El archivo no tiene formato de base de datos segura valido.");
            return;
          }

          const pass = prompt("Ingresa clave para descifrar la base de datos:");
          if (!pass) return;

          const decrypted = CryptoJS.AES.decrypt(obj.payload, pass).toString(CryptoJS.enc.Utf8);
          if (!decrypted) {
            alert("Clave incorrecta o archivo daÃ±ado.");
            return;
          }

          const payload = JSON.parse(decrypted);
          if (!payload || !payload.state) {
            alert("Contenido descifrado invalido.");
            return;
          }

          restoreStateFromImported(payload.state);
          alert("Base de datos segura cargada correctamente.");
        } catch {
          alert("No se pudo cargar la base de datos segura.");
        }
      };
      reader.readAsText(file);
    }

    function buildHistoryDbPayload() {
      return {
        format: "QCC-HISTORY-DB-V1",
        generatedAt: new Date().toISOString(),
        rows: Array.isArray(state.productionHistoryRaw) ? state.productionHistoryRaw : []
      };
    }

    function exportHistoryDbFile() {
      const payload = buildHistoryDbPayload();
      downloadTextFile(JSON.stringify(payload, null, 2), "production_history.qcchdb", "application/json");
      alert("BD histÃ³rica exportada.");
    }

    async function writeLinkedHistoryDbFile() {
      if (!historyDbAutoSaveEnabled || !linkedHistoryDbFileHandle) return;
      try {
        const permission = await linkedHistoryDbFileHandle.queryPermission({ mode: "readwrite" });
        if (permission !== "granted") {
          const req = await linkedHistoryDbFileHandle.requestPermission({ mode: "readwrite" });
          if (req !== "granted") return;
        }

        const payload = buildHistoryDbPayload();
        const writable = await linkedHistoryDbFileHandle.createWritable();
        await writable.write(JSON.stringify(payload, null, 2));
        await writable.close();
      } catch {
        console.warn("No se pudo actualizar la BD histÃ³rica enlazada.");
      }
    }

    function scheduleHistoryDbAutoSave() {
      if (!historyDbAutoSaveEnabled) return;
      if (historyDbAutoSaveTimer) clearTimeout(historyDbAutoSaveTimer);
      historyDbAutoSaveTimer = setTimeout(() => {
        writeLinkedHistoryDbFile();
      }, 320);
    }

    async function configureLinkedHistoryDb() {
      if (!window.showSaveFilePicker) {
        alert("Tu navegador no permite escritura directa local. Usa Exportar BD HistÃ³rica.");
        return;
      }
      if (!linkedHistoryDbFileHandle) {
        try {
          linkedHistoryDbFileHandle = await window.showSaveFilePicker({
            suggestedName: "production_history.qcchdb",
            types: [{ description: "BD histÃ³rica de producciÃ³n", accept: { "application/json": [".qcchdb", ".json"] } }]
          });
        } catch {
          alert("No se seleccionÃ³ archivo para BD histÃ³rica.");
          return;
        }
      }
      historyDbAutoSaveEnabled = true;
      await writeLinkedHistoryDbFile();
      alert("BD histÃ³rica enlazada. Se actualizarÃ¡ automÃ¡ticamente con cada importaciÃ³n histÃ³rica.");
    }

    function loadHistoryDbFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const raw = JSON.parse(String(reader.result || "{}"));
          const rows = Array.isArray(raw?.rows) ? raw.rows : [];
          if (!rows.length) {
            alert("La BD histÃ³rica no contiene registros.");
            return;
          }

          state.productionHistoryRaw = Array.isArray(state.productionHistoryRaw) ? state.productionHistoryRaw : [];
          state.productionReports = Array.isArray(state.productionReports) ? state.productionReports : [];
          const known = new Set(state.productionHistoryRaw.map(r => String(r.externalKey || "")));
          const knownProd = new Set(state.productionReports.map(r => String(r.externalKey || "")));
          const newlyAdded = [];
          let added = 0;
          let prodAdded = 0;
          rows.forEach(r => {
            const key = String(r.externalKey || "").trim();
            if (!key || known.has(key)) return;
            known.add(key);
            state.productionHistoryRaw.push(r);
            newlyAdded.push(r);
            added += 1;
          });

          const qtyByDayAndRecipe = {};
          newlyAdded.forEach(r => {
            if (!r.recipeId) return;
            const day = String(r.dayKey || getDayKey(r.invoiceDate || new Date()));
            qtyByDayAndRecipe[day] = qtyByDayAndRecipe[day] || {};
            qtyByDayAndRecipe[day][r.recipeId] = (qtyByDayAndRecipe[day][r.recipeId] || 0) + Math.max(0, Number(r.units || 0));
          });

          newlyAdded.forEach(r => {
            if (!r.recipeId || knownProd.has(r.externalKey)) return;
            const recipe = state.recetas.find(x => x.id === r.recipeId);
            if (!recipe) return;
            knownProd.add(r.externalKey);

            const dayKey = String(r.dayKey || getDayKey(r.invoiceDate || new Date()));
            const cfResolved = resolveCfForProduction(recipe, dayKey, qtyByDayAndRecipe[dayKey] || null);
            const cs = ensureCostStructure(recipe);
            const unitsPerPack = Math.max(1, Number(cs.unidadesPorEmpaque || 1));
            const qty = Math.max(0, Number(r.units || 0));
            const total = Math.max(0, Number(r.lineTotal || 0));
            const unit = qty > 0 ? (total / qty) : Math.max(0, Number(r.unitPrice || 0));

            state.productionReports.unshift({
              id: uid(),
              fecha: r.invoiceDate || new Date().toISOString(),
              recipeId: recipe.id,
              recipeName: recipe.nombre || "Sin nombre",
              requestedQty: qty,
              factor: 1,
              requirements: [],
              estimatedCost: total,
              existingPt: 0,
              warehouseMpId: state.warehouses[0]?.id || null,
              warehousePtId: state.warehouses[0]?.id || null,
              unitCost: unit,
              baseUnitCostNoCf: Math.max(0, unit - Number(cfResolved.cfUnit || 0)),
              packedQty: qty / unitsPerPack,
              cfUnitCost: Number(cfResolved.cfUnit || 0),
              cfSharePct: Number(cfResolved.cfSharePct || 0),
              energiaPct: Number(cfResolved.energiaPct || 0),
              infraPct: Number(cfResolved.infraPct || 0),
              cfSource: cfResolved.source || "historico",
              totalConsumedCost: total,
              costSourceType: "load_bd_historica",
              costSourceLabel: getCostSourceLabel("load_bd_historica"),
              externalKey: r.externalKey,
              invoiceNumber: r.invoiceNumber || "",
              lot: r.lot || "",
              itemCode: r.itemCode || "",
              warehouseName: r.warehouse || ""
            });
            prodAdded += 1;
          });

          const affectedDays = Object.keys(qtyByDayAndRecipe || {});
          affectedDays.forEach(day => rebalanceProductionDay(day));

          saveState();
          renderAll();
          alert(`BD histÃ³rica cargada. Registros nuevos: ${added}. ProducciÃ³n mapeada: ${prodAdded}.`);
        } catch {
          alert("No se pudo cargar la BD histÃ³rica.");
        }
      };
      reader.readAsText(file);
    }

    function importJson(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = JSON.parse(String(reader.result || "{}"));
          restoreStateFromImported(imported);
          alert("Archivo importado correctamente.");
        } catch {
          alert("El archivo no tiene un formato JSON valido.");
        }
      };
      reader.readAsText(file);
    }

    function sanitizeFileName(name) {
      return String(name || "ficha_tecnica")
        .trim()
        .replace(/[^a-z0-9\-_\s]/gi, "")
        .replace(/\s+/g, "_")
        .toLowerCase() || "ficha_tecnica";
    }

    function formatNumberUi(value, decimals = 4) {
      const n = Number(value || 0);
      return n.toLocaleString("es-PA", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      });
    }

    function formatPercentUi(value, decimals = 2) {
      return `${formatNumberUi(value, decimals)}%`;
    }

    function formatCurrencyUi(value, decimals = 2) {
      return `B/. ${formatNumberUi(value, decimals)}`;
    }

    function getRecipeById(id) {
      return state.recetas.find(r => r.id === id) || null;
    }

    function previewPdfDocument(doc, fileName, askDownload = false) {
      const url = doc.output("bloburl");
      const win = window.open(url, "_blank", "noopener,noreferrer");
      if (!win) {
        alert("No se pudo abrir la vista previa. Verifica que tu navegador permita ventanas emergentes.");
        if (askDownload) doc.save(fileName);
        return;
      }

      if (askDownload) {
        const shouldDownload = confirm("Se abriÃ³ la vista previa del PDF. Â¿Deseas descargarlo ahora?");
        if (shouldDownload) doc.save(fileName);
      }
    }

    function addProjectFooterToPdf(doc) {
      if (!doc) return;
      const footerText = "Desarrollado por: Ibrahim Ojeda | Sistema de Costeo OrgÃ¡nico";
      const totalPages = Number(doc.internal?.getNumberOfPages?.() || 0);
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      for (let page = 1; page <= totalPages; page += 1) {
        doc.setPage(page);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(120);
        doc.text(footerText, pageW / 2, pageH - 14, { align: "center" });
      }
      doc.setTextColor(0);
    }

    function openReportOptionsModal() {
      if (!reportSelectedRecipeIds.size) {
        state.recetas.forEach(r => reportSelectedRecipeIds.add(r.id));
      }
      renderReportRecipeSelector();
      document.getElementById("reportOptionsModal").classList.remove("hidden");
    }

    function closeReportOptionsModal() {
      document.getElementById("reportOptionsModal").classList.add("hidden");
    }

    function generateSystemReportFromOptions() {
      const selectedRecipes = state.recetas.filter(r => reportSelectedRecipeIds.has(r.id));
      const opts = {
        includeHeader: document.getElementById("reportOptHeader").checked,
        includeInventory: document.getElementById("reportOptInventory").checked,
        includeRecipeSummary: document.getElementById("reportOptRecipeSummary").checked,
        includeIngredients: document.getElementById("reportOptIngredients").checked,
        includeCfDetails: document.getElementById("reportOptCf").checked,
        includeChartPie: document.getElementById("reportOptChartPie").checked,
        includeChartCompare: document.getElementById("reportOptChartCompare").checked,
        compareChartType: (["bar", "line", "radar"].includes(document.getElementById("reportCompareChartType").value)
          ? document.getElementById("reportCompareChartType").value
          : "bar"),
        recipeIds: selectedRecipes.map(r => r.id),
        previewBeforeDownload: document.getElementById("reportOptPreview").checked
      };

      if (!opts.includeHeader && !opts.includeInventory && !opts.includeRecipeSummary && !opts.includeIngredients && !opts.includeCfDetails && !opts.includeChartPie && !opts.includeChartCompare) {
        alert("Selecciona al menos una seccion para el reporte.");
        return;
      }

      const needsRecipes = opts.includeRecipeSummary || opts.includeIngredients || opts.includeCfDetails || opts.includeChartPie || opts.includeChartCompare;
      if (needsRecipes && !selectedRecipes.length) {
        alert("Selecciona al menos una receta para el reporte.");
        return;
      }

      if (opts.includeChartCompare && ["line", "radar"].includes(opts.compareChartType) && selectedRecipes.length <= 2) {
        alert("Para insertar grÃ¡fico de lÃ­neas o radar en el reporte debes seleccionar mas de 2 recetas.");
        return;
      }

      closeReportOptionsModal();
      generateSystemReportPdf(opts);
    }

    function renderReportRecipeSelector() {
      const cont = document.getElementById("reportRecipeSelector");
      if (!cont) return;

      const validIds = new Set(state.recetas.map(r => r.id));
      reportSelectedRecipeIds.forEach(id => {
        if (!validIds.has(id)) reportSelectedRecipeIds.delete(id);
      });
      if (!reportSelectedRecipeIds.size && state.recetas.length) {
        state.recetas.forEach(r => reportSelectedRecipeIds.add(r.id));
      }

      if (!state.recetas.length) {
        cont.innerHTML = "<div class='muted'>No hay recetas disponibles.</div>";
        return;
      }

      cont.innerHTML = state.recetas.map(r => {
        const checked = reportSelectedRecipeIds.has(r.id) ? "checked" : "";
        return `<label class='option-row' style='padding:.35rem .45rem;'>
          <input type='checkbox' data-report-recipe-id='${r.id}' ${checked}>
          <span>${escapeHtml(r.nombre || "Sin nombre")} (${formatRecipeTypeLabel(r.tipo)})</span>
        </label>`;
      }).join("");

      cont.querySelectorAll("input[data-report-recipe-id]").forEach(el => {
        el.addEventListener("change", () => {
          const id = el.dataset.reportRecipeId;
          if (!id) return;
          if (el.checked) reportSelectedRecipeIds.add(id);
          else reportSelectedRecipeIds.delete(id);
        });
      });
    }

    function selectAllReportRecipes() {
      reportSelectedRecipeIds = new Set(state.recetas.map(r => r.id));
      renderReportRecipeSelector();
    }

    function selectFirstReportRecipeOnly() {
      if (!state.recetas.length) {
        reportSelectedRecipeIds = new Set();
        renderReportRecipeSelector();
        return;
      }
      reportSelectedRecipeIds = new Set([state.recetas[0].id]);
      renderReportRecipeSelector();
    }

    function buildReportChartDataUrl(config, width = 760, height = 340) {
      if (typeof Chart === "undefined") return null;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      const chart = new Chart(ctx, {
        ...config,
        options: {
          responsive: false,
          animation: false,
          maintainAspectRatio: false,
          ...(config.options || {})
        }
      });
      chart.update();
      const dataUrl = canvas.toDataURL("image/png", 1);
      chart.destroy();
      return dataUrl;
    }

    function generateRecipePdf(recipe) {
      if (!recipe) {
        alert("Selecciona una receta para generar PDF.");
        return;
      }

      if (!window.jspdf || !window.jspdf.jsPDF) {
        alert("No se pudo cargar el generador PDF. Revisa tu conexiÃ³n.");
        return;
      }

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const calc = computeRecipe(recipe);
      const produccion = Math.max(1, Number(recipe.produccion || 1));
      const costoUnidad = calc.costoBase / produccion;
      calculateIngredientPercentages(recipe);
      const cs = ensureCostStructure(recipe);
      const cfResult = calculateCfFromConfig(cs, recipe.tipo);
      const totals = computeCostStructureTotals(cs);

      const costeo = recipe.costeo || {};
      const pesoUnidad = Number(costeo.pesoUnidad || 0);
      const unidadesDeseadas = Number(costeo.unidadesDeseadas || produccion);
      const batchDeseadoGr = Number(costeo.batchDeseadoGr || (pesoUnidad * unidadesDeseadas) || 0);

      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 22;
      const contentW = pageW - (margin * 2);
      const productCode = sanitizeFileName(recipe.nombre).toUpperCase();
      const productName = String(recipe.nombre || "SIN NOMBRE").toUpperCase();

      const sortedIngredientes = [...(recipe.ingredientes || [])]
        .map(i => {
          const mp = state.materiasPrimas.find(x => x.id === i.mpId);
          return {
            nombre: mp?.nombre || "Insumo",
            cantidad: Number(i.cantidad || 0),
            porcentaje: Number(i.porcentaje || 0)
          };
        })
        .sort((a, b) => b.cantidad - a.cantidad);

      const composicion = sortedIngredientes
        .map(i => `${i.nombre} ${i.porcentaje.toFixed(2)}%`)
        .join(" | ") || "-";

      const alergenos = (() => {
        const n = sortedIngredientes.map(i => i.nombre.toLowerCase()).join(" ");
        const tags = [];
        if (/(harina|trigo|gluten)/.test(n)) tags.push("Gluten de trigo");
        if (/(leche|mantequilla|queso|lact)/.test(n)) tags.push("Lacteos");
        if (/(huevo)/.test(n)) tags.push("Huevo");
        if (/(soya|soja)/.test(n)) tags.push("Soya");
        return tags.length ? tags.join(", ") : "No identificado";
      })();

      doc.setLineWidth(0.8);
      doc.rect(margin, margin, contentW, pageH - (margin * 2));

      let y = margin;
      const metaX = margin + contentW - 195;
      const leftW = contentW - 195;

      doc.setFillColor(242, 242, 242);
      doc.rect(margin, y, contentW, 54, "F");
      doc.rect(margin, y, leftW, 54);
      doc.rect(metaX, y, 195, 54);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.text("FICHA TECNICA", margin + 8, y + 16);
      doc.setFontSize(10);
      doc.text(productName, margin + 8, y + 32);

      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.text(`Codigo: ${productCode}`, metaX + 8, y + 14);
      doc.text(`Version: ${String(costeo.version || "1")}`, metaX + 8, y + 26);
      doc.text(`Fecha de aprobacion: ${new Date().toLocaleDateString()}`, metaX + 8, y + 38);
      doc.text("Pag. 1 de 1", metaX + 8, y + 50);
      y += 54;

      doc.rect(margin, y, leftW, 86);
      doc.rect(metaX, y, 195, 86);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.text("NOMBRE DEL PRODUCTO", margin + 6, y + 10);
      doc.setFont("helvetica", "normal");
      doc.text(`${productName}`, margin + 6, y + 22);
      doc.text(`Tipo: ${formatRecipeTypeLabel(recipe.tipo)}`, margin + 6, y + 34);
      doc.text(`Produccion: ${produccion} unidades`, margin + 6, y + 46);
      doc.text(`Peso unitario: ${pesoUnidad > 0 ? `${pesoUnidad} gr` : "-"}`, margin + 6, y + 58);
      doc.text(`Batch objetivo: ${batchDeseadoGr > 0 ? `${batchDeseadoGr} gr` : "-"}`, margin + 6, y + 70);

      doc.setFillColor(250, 250, 250);
      doc.rect(metaX + 8, y + 8, 179, 70, "F");
      doc.rect(metaX + 8, y + 8, 179, 70);
      doc.setFont("helvetica", "italic");
      doc.setFontSize(8);
      doc.text("IMAGEN DEL PRODUCTO", metaX + 54, y + 44);
      y += 86;

      const rowHeaderH = 13;
      const rowLineH = 12;
      const section = (title, lines, multiLine = false) => {
        doc.setFillColor(230, 230, 230);
        doc.rect(margin, y, contentW, rowHeaderH, "F");
        doc.rect(margin, y, contentW, rowHeaderH);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(7.6);
        doc.text(title, margin + 5, y + 9);
        y += rowHeaderH;

        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.2);

        if (multiLine) {
          const text = doc.splitTextToSize(lines.join("\n"), contentW - 10);
          const blockH = Math.max(rowLineH * 2, text.length * 9 + 4);
          doc.rect(margin, y, contentW, blockH);
          doc.text(text, margin + 5, y + 8);
          y += blockH;
          return;
        }

        lines.forEach(line => {
          doc.rect(margin, y, contentW, rowLineH);
          doc.text(line, margin + 5, y + 8);
          y += rowLineH;
        });
      };

      section("COMPOSICION DEL PRODUCTO EN ORDEN DECRECIENTE", [composicion], true);
      section("PESOS Y DESVIOS", [
        `Peso: ${pesoUnidad > 0 ? `${pesoUnidad} gr` : "-"}`,
        `Costo unitario base: B/. ${costoUnidad.toFixed(4)}`
      ]);
      section("ALERGENOS", [`${alergenos}`]);
      section("ESPECIFICACIONES MICROBIOLOGICAS", ["Conforme a parametros internos de inocuidad alimentaria."]);
      section("CARACTERISTICAS ORGANOLEPTICAS", [
        "Color: Marron dorado",
        "Olor: Tipico a pan fermentado",
        "Sabor: Suave, propio de la formulacion",
        "Aspecto: Uniforme"
      ]);
      section("PRESENTACIONES COMERCIALES", [`Caja de ${Math.max(1, Number(cs.unidadesPorEmpaque || 1))} unidades`]);
      section("TIPO DE ENVASE", ["Bolsa de plastico"]);
      section("MATERIAL DE ENVASE", ["Plastico"]);
      section("CONDICIONES DE CONSERVACION", [
        "Congelado: 180 dias",
        "Ambiente: 5 dias",
        "Refrigerado: 30 dias"
      ]);
      section("TIPO DE TRATAMIENTO (PROCESO DE ELABORACION)", ["Segun receta y secuencia de etapas configuradas."], true);
      section("VIDA UTIL ESTIMADA", ["Ver condiciones de conservacion."], true);
      section("PORCION RECOMENDADA", ["1 unidad"], true);
      section("GRUPO POBLACIONAL", ["Poblacion general"], true);
      doc.setFillColor(230, 230, 230);
      doc.rect(margin, y, contentW, rowHeaderH, "F");
      doc.rect(margin, y, contentW, rowHeaderH);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.6);
      doc.text("FIRMA DE FICHA TECNICA", margin + 5, y + 9);
      y += rowHeaderH;
      doc.rect(margin, y, contentW, 36);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.2);
      doc.line(margin + 85, y + 24, margin + 245, y + 24);
      doc.text("Nombre del responsable", margin + 5, y + 31);
      doc.line(margin + 305, y + 24, margin + 450, y + 24);
      doc.text("Firma", margin + 270, y + 31);

      addProjectFooterToPdf(doc);
      previewPdfDocument(doc, `ficha_tecnica_${sanitizeFileName(recipe.nombre)}.pdf`, true);
    }

    function generateSystemReportPdf(options = {}) {
      if (!window.jspdf || !window.jspdf.jsPDF) {
        alert("No se pudo cargar el generador PDF. Revisa tu conexiÃ³n.");
        return;
      }

      const cfg = {
        includeHeader: true,
        includeInventory: true,
        includeRecipeSummary: true,
        includeIngredients: true,
        includeCfDetails: true,
        includeChartPie: true,
        includeChartCompare: true,
        compareChartType: "bar",
        recipeIds: state.recetas.map(r => r.id),
        previewBeforeDownload: true,
        ...options
      };

      const selectedRecipes = state.recetas.filter(r => cfg.recipeIds.includes(r.id));

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const topMargin = 40;
      const bottomMargin = 40;
      let y = 44;

      function ensurePageSpace(currentY, requiredHeight) {
        if (currentY + requiredHeight > (pageH - bottomMargin)) {
          doc.addPage();
          return topMargin;
        }
        return currentY;
      }

      if (cfg.includeHeader) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(16);
        doc.text("REPORTE COMPLETO DEL SISTEMA", 40, y);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        y += 18;
        doc.text(`Generado: ${new Date().toLocaleString()}`, 40, y);
        doc.text(`Total recetas: ${selectedRecipes.length}`, 300, y);
        y += 22;
      }

      if (cfg.includeInventory && doc.autoTable) {
        const invRows = state.materiasPrimas.map(mp => [
          mp.nombre || "",
          mp.proveedor || "",
          mp.unidadBase || "",
          Number(mp.cantidadEmpaque || 0).toFixed(4),
          `B/. ${Number(mp.precioEmpaque || 0).toFixed(4)}`
        ]);

        doc.autoTable({
          startY: y,
          head: [["INVENTARIO", "Proveedor", "Unidad", "Cantidad Empaque", "Precio Empaque"]],
          body: invRows.length ? invRows : [["Sin datos", "-", "-", "-", "-"]],
          theme: "grid",
          headStyles: { fillColor: [22, 101, 52] },
          styles: { fontSize: 8 }
        });

        y = (doc.lastAutoTable?.finalY || y) + 18;
      }

      if ((cfg.includeChartPie || cfg.includeChartCompare) && selectedRecipes.length) {
        y = ensurePageSpace(y, 30);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("GRAFICOS", 40, y);
        y += 14;

        const bothCharts = cfg.includeChartPie && cfg.includeChartCompare;
        const chartGap = 12;
        const chartWidth = bothCharts ? ((pageW - 80 - chartGap) / 2) : (pageW - 80);
        const chartHeight = bothCharts ? 185 : 230;
        let pieImg = null;
        let compareImg = null;

        if (cfg.includeChartPie) {
          const totalsByRecipe = selectedRecipes.map(r => computeCostStructureTotals(ensureCostStructure(r)));
          const sumCostoReceta = totalsByRecipe.reduce((acc, t) => acc + Number(t.costoReceta || 0), 0);
          const sumCargaFabril = totalsByRecipe.reduce((acc, t) => acc + Number(t.cargaFabril || 0), 0);
          const sumMaterialEmpaque = totalsByRecipe.reduce((acc, t) => acc + Number(t.materialEmpaque || 0), 0);
          const sumTransporte = totalsByRecipe.reduce((acc, t) => acc + Number(t.transporte || 0), 0);
          const sumCostosOperativos = totalsByRecipe.reduce((acc, t) => acc + Number(t.costosOperativos || 0), 0);
          pieImg = buildReportChartDataUrl({
            type: "pie",
            data: {
              labels: ["Costo Receta", "Carga Fabril", "Material Empaque", "Transporte", "Costos Operativos"],
              datasets: [{
                data: [sumCostoReceta, sumCargaFabril, sumMaterialEmpaque, sumTransporte, sumCostosOperativos],
                backgroundColor: ["#16a34a", "#f59e0b", "#2563eb", "#8b5cf6", "#0ea5e9"]
              }]
            },
            options: { plugins: { legend: { position: "bottom" } } }
          }, bothCharts ? 520 : 640, bothCharts ? 280 : 320);
        }

        if (cfg.includeChartCompare) {
          const totalsByRecipe = selectedRecipes.map(r => computeCostStructureTotals(ensureCostStructure(r)));
          const chartLabels = selectedRecipes.map(r => r.nombre || "Sin nombre");
          const datasets = [
            { label: "Utilidad %", data: totalsByRecipe.map(t => Number(t.mbUnitPct || 0)), borderColor: "#ef4444", backgroundColor: "rgba(239,68,68,0.35)", yAxisID: "yPercent" },
            { label: "PV Unitario", data: totalsByRecipe.map(t => Number(t.pvUnitario || 0)), borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,0.3)", yAxisID: "yMoney" },
            { label: "PC Unitario", data: totalsByRecipe.map(t => Number(t.pcUnitario || 0)), borderColor: "#059669", backgroundColor: "rgba(5,150,105,0.3)", yAxisID: "yMoney" }
          ];

          compareImg = buildReportChartDataUrl({
            type: cfg.compareChartType,
            data: { labels: chartLabels, datasets },
            options: {
              scales: {
                yPercent: { type: "linear", position: "left", beginAtZero: true, ticks: { callback: (value) => `${value}%` }, grid: { drawOnChartArea: false } },
                yMoney: { type: "linear", position: "right", beginAtZero: true, grid: { drawOnChartArea: true } }
              }
            }
          }, bothCharts ? 600 : 760, bothCharts ? 280 : 340);
        }

        if (bothCharts && pieImg && compareImg) {
          y = ensurePageSpace(y, chartHeight + 36);
          doc.setFont("helvetica", "normal");
          doc.setFontSize(10);
          const leftX = 40;
          const rightX = 40 + chartWidth + chartGap;
          doc.text("Distribucion de Costos", leftX, y);
          doc.text(`Comparador (${cfg.compareChartType.toUpperCase()})`, rightX, y);
          y += 10;
          doc.addImage(pieImg, "PNG", leftX, y, chartWidth, chartHeight);
          doc.addImage(compareImg, "PNG", rightX, y, chartWidth, chartHeight);
          y += chartHeight + 10;
        } else {
          if (pieImg) {
            y = ensurePageSpace(y, chartHeight + 36);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(10);
            doc.text("Distribucion de Costos (recetas seleccionadas)", 40, y);
            y += 10;
            doc.addImage(pieImg, "PNG", 40, y, chartWidth, chartHeight);
            y += chartHeight + 10;
          }
          if (compareImg) {
            y = ensurePageSpace(y, chartHeight + 36);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(10);
            doc.text(`Comparador de Productos (${cfg.compareChartType.toUpperCase()})`, 40, y);
            y += 10;
            doc.addImage(compareImg, "PNG", 40, y, chartWidth, chartHeight);
            y += chartHeight + 10;
          }
        }

        y += 6;
      }

      const includeRecipePages = cfg.includeRecipeSummary || cfg.includeIngredients || cfg.includeCfDetails;
      if (!includeRecipePages) {
        addProjectFooterToPdf(doc);
        previewPdfDocument(doc, "reporte_completo_sistema.pdf", !cfg.previewBeforeDownload);
        return;
      }

      selectedRecipes.forEach((recipe, idx) => {
        y = ensurePageSpace(y, 70);
        let ry = y;
        const calc = computeRecipe(recipe);
        const produccion = Math.max(1, Number(recipe.produccion || 1));
        const cs = ensureCostStructure(recipe);
        const cfResult = calculateCfFromConfig(cs, recipe.tipo);
        const totals = computeCostStructureTotals(cs);

        doc.setFont("helvetica", "bold");
        doc.setFontSize(13);
        doc.text(`RECETA: ${String(recipe.nombre || "Sin nombre").toUpperCase()}`, 40, ry);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        ry += 16;
        if (cfg.includeRecipeSummary) {
          doc.text(`Tipo: ${formatRecipeTypeLabel(recipe.tipo)} | Produccion: ${produccion}`, 40, ry);
          ry += 14;
          doc.text(`Descripcion: ${String(recipe.descripcion || "-")}`, 40, ry);
          ry += 10;

          if (doc.autoTable) {
            const totalDistribucion = Number(totals.totalCostoUnitario || 0);
            const partPct = (value) => totalDistribucion > 0 ? ((Number(value || 0) / totalDistribucion) * 100).toFixed(2) : "0.00";
            doc.autoTable({
              startY: ry,
              head: [["RESUMEN DE COSTOS", "Valor", "Part %"]],
              body: [
                ["Costo Receta", `B/. ${Number(totals.costoReceta || 0).toFixed(4)}`, `${partPct(totals.costoReceta)}%`],
                ["Carga fabril", `B/. ${Number(totals.cargaFabril || 0).toFixed(4)}`, `${partPct(totals.cargaFabril)}%`],
                ["TOTAL COSTO x UNIDAD", `B/. ${Number(totals.totalCostoUnidad || 0).toFixed(4)}`, ""],
                ["Material de empaque", `B/. ${Number(totals.materialEmpaque || 0).toFixed(4)}`, `${partPct(totals.materialEmpaque)}%`],
                ["TOTAL COSTO UNITARIO", `B/. ${Number(totals.totalCostoUnitario || 0).toFixed(4)}`, ""],
                ["PV UNITARIO", `B/. ${Number(totals.pvUnitario || 0).toFixed(4)}`, ""],
                ["MB UNIT %", `${Number(totals.mbUnitPct || 0).toFixed(2)}%`, ""]
              ],
              theme: "grid",
              headStyles: { fillColor: [90, 90, 90] },
              styles: { fontSize: 8 }
            });
            ry = (doc.lastAutoTable?.finalY || ry) + 12;
          } else {
            doc.text(`Costo base receta: B/. ${calc.costoBase.toFixed(4)} | Costo unitario base: B/. ${(calc.costoBase / produccion).toFixed(4)}`, 40, ry);
            ry += 14;
            doc.text(`PC unitario: B/. ${totals.pcUnitario.toFixed(4)} | PV unitario: B/. ${totals.pvUnitario.toFixed(4)} | MB: ${totals.mbUnitPct.toFixed(2)}%`, 40, ry);
            ry += 14;
            doc.text(`PC caja: B/. ${totals.pcCaja.toFixed(4)} | PV caja: B/. ${totals.pvCaja.toFixed(4)} | MB caja: ${totals.mbCajaPct.toFixed(2)}%`, 40, ry);
            ry += 18;
          }
        }

        const rows = (recipe.ingredientes || []).map(i => {
          const mp = state.materiasPrimas.find(x => x.id === i.mpId);
          const nombre = mp?.nombre || "Insumo no encontrado";
          const unidad = i.unidad || mp?.unidadBase || "un";
          const cantidad = Number(i.cantidad || 0);
          const costoLinea = Number.isFinite(Number(i.costoReceta))
            ? Number(i.costoReceta)
            : (() => {
              const cantEmp = Number(mp?.cantidadEmpaque || 0);
              const precioEmp = Number(mp?.precioEmpaque || 0);
              const costoUnit = cantEmp > 0 ? (precioEmp / cantEmp) : 0;
              return costoUnit * cantidad;
            })();
          return [
            nombre,
            cantidad.toFixed(4),
            unidad,
            `${Number(i.porcentaje || 0).toFixed(2)}%`,
            `B/. ${costoLinea.toFixed(4)}`
          ];
        });

        if (cfg.includeIngredients && doc.autoTable) {
          doc.autoTable({
            startY: ry,
            head: [["Ingrediente", "Cantidad", "Unidad", "%", "Costo en receta"]],
            body: rows.length ? rows : [["Sin ingredientes", "0", "-", "0.00%", "B/. 0.0000"]],
            theme: "grid",
            headStyles: { fillColor: [90, 90, 90] },
            styles: { fontSize: 8 }
          });

          ry = (doc.lastAutoTable?.finalY || ry) + 14;
        }

        if (cfg.includeCfDetails) {
          ry = ensurePageSpace(ry, 32);
          doc.setFontSize(9);
          doc.text(`Carga fabril aplicada (${cfResult.modo}): B/. ${totals.cargaFabril.toFixed(4)}`, 40, ry);
          ry += 12;
          doc.text(`Tasa horaria linea: B/. ${cfResult.tasaHora.toFixed(4)} | Energia unidad: B/. ${cfResult.energiaUnidad.toFixed(4)} | Infra unidad: B/. ${cfResult.infraUnidad.toFixed(4)}`, 40, ry);
          ry += 14;
        }

        y = ry + 8;
        y = ensurePageSpace(y, 14);
        doc.setDrawColor(210);
        doc.line(40, y, pageW - 40, y);
        y += 14;
      });

      addProjectFooterToPdf(doc);
      previewPdfDocument(doc, "reporte_completo_sistema.pdf", !cfg.previewBeforeDownload);
    }

    function generateCurrentRecipePdf() {
      generateRecipePdf(currentRecipe());
    }

    function downloadRecipePdfById(recipeId) {
      generateRecipePdf(getRecipeById(recipeId));
    }

    function downloadMassiveTemplate() {
      const csv = [
        "nombre,proveedor,unidad,cantidadEmpaque,precioEmpaque",
        "Harina 000,Molinos Andinos,kg,25,38000",
        "Azucar,Distribuidora Centro,kg,10,14500",
        "Levadura Seca,Panifresh,g,500,8900",
        "Sal Fina,Salina del Sur,kg,1,1200",
        "Aceite Girasol,Mayorista Norte,lt,5,28500",
        "Huevos Granja,Avicola San Jose,un,30,9600"
      ].join("\n");

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "plantilla_ingredientes.csv";
      a.click();
      URL.revokeObjectURL(url);
    }

    function downloadRecipeTemplateCsv() {
      downloadCsv(
        "plantilla_recetas.csv",
        ["nombre", "descripcion", "tipo", "produccion", "ingrediente", "cantidad", "unidad", "gramosEquivalencia"],
        [["Pan Integrado", "Receta base", "panaderia", "100", "Harina 000", "60", "kg", ""]]
      );
    }

    function downloadCostStructureTemplateCsv() {
      downloadCsv(
        "plantilla_costos.csv",
        ["Producto", "Costo receta", "Carga fabril", "Unidades empaque", "Costo material empaque", "Transporte", "Costos operativos", "PV", "PVU", "PCU"],
        [["Pan Integrado", "1.25", "0.35", "24", "0.03", "0.05", "0.07", "40", "2.1", "1.63"]]
      );
    }

    function setAiPrompt(type) {
      const prompts = {
        "crear-receta": "Crea una receta de budin de naranja para 20 porciones. Incluye materias primas sugeridas con proveedor, unidad, cantidadEmpaque y precioEmpaque. Devuelve JSON utilizable por el sistema.",
        "optimizar-costo": "Analiza la receta actual y reduce el costo total al menos 12%. Propone reemplazos de insumos y ajustes de cantidades manteniendo calidad. Devuelve JSON aplicable.",
        "escalar-produccion": "Escala la receta actual de 20 a 120 unidades. Ajusta ingredientes y agrega tareas de preparacion por etapa. Devuelve JSON con receta actualizada.",
        "checklist-operativo": "Genera checklist operativo para produccion diaria: control de inventario, mise en place, elaboracion, empaque, limpieza y control final. Incluye tareas concretas.",
        "carga-recetas-archivo": "Lee el archivo cargado, identifica patrones de columnas y crea recetas estructuradas con ingredientes. Prioriza recetas realistas, consolida datos inconsistentes y devuelve solo JSON listo para confirmacion de usuario."
      };
      const area = document.getElementById("aiPrompt");
      area.value = prompts[type] || "";
      area.focus();
    }

    function buildAiInstruction(userPrompt, fileContext = "") {
      return `Eres un asistente para un sistema de costeo gastronomico.\n` +
        `Devuelve SOLO JSON valido con esta estructura:\n` +
        `{\n` +
        `  "materiasPrimas": [{"nombre":"","proveedor":"","unidadBase":"","cantidadEmpaque":0,"precioEmpaque":0}],\n` +
        `  "recetas": [{"nombre":"","descripcion":"","produccion":1,"ingredientes":[{"nombre":"","cantidad":0}],"materiasPrimas":[{"nombre":"","proveedor":"","unidadBase":"","cantidadEmpaque":0,"precioEmpaque":0}]}],\n` +
        `  "receta": {"nombre":"","descripcion":"","produccion":1,"ingredientes":[{"nombre":"","cantidad":0}]},\n` +
        `  "tareas": ["..."]\n` +
        `}\n` +
        `Si no aplica una parte, deja arreglo vacio o null.\n` +
        `Si llega un archivo, primero identifica patrones (columnas, agrupaciones, nombres repetidos) y luego arma recetas coherentes.\n` +
        `${fileContext ? `Contexto de archivo:\n${fileContext}\n` : ""}` +
        `Solicitud del usuario: ${userPrompt}`;
    }

    function getManualAiPrompt() {
      return buildAiInstruction(document.getElementById("aiPrompt").value.trim());
    }

    function normalizeGenericHeader(h) {
      return String(h || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "")
        .replace(/[^a-z0-9_]/g, "");
    }

    function parseDelimitedObjects(text) {
      const rows = String(text || "").split(/\r?\n/).filter(r => r.trim());
      if (!rows.length) return [];
      const delimiter = rows[0].includes(";") ? ";" : (rows[0].includes("\t") ? "\t" : ",");
      const headers = rows[0].split(delimiter).map(h => normalizeGenericHeader(h));
      return rows.slice(1).map(r => {
        const cols = r.split(delimiter).map(c => c.trim());
        const obj = {};
        headers.forEach((h, i) => { obj[h || `col${i + 1}`] = cols[i] || ""; });
        return obj;
      });
    }

    async function readAiSourceFile(file) {
      if (!file) return { rows: [], summary: "Sin archivo." };

      const lower = file.name.toLowerCase();
      let rows = [];

      if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
        const text = await file.text();
        rows = parseDelimitedObjects(text);
      } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
        if (typeof XLSX === "undefined") {
          throw new Error("No se pudo cargar la libreria XLSX.");
        }
        const arr = await file.arrayBuffer();
        const wb = XLSX.read(arr, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
        rows = json.map(row => {
          const normalized = {};
          Object.keys(row).forEach(k => {
            normalized[normalizeGenericHeader(k)] = row[k];
          });
          return normalized;
        });
      } else if (lower.endsWith(".json")) {
        const raw = JSON.parse(await file.text());
        if (Array.isArray(raw)) rows = raw;
        else if (raw && Array.isArray(raw.rows)) rows = raw.rows;
        else if (raw && Array.isArray(raw.data)) rows = raw.data;
        else rows = [raw];
      } else {
        throw new Error("Formato no soportado para IA.");
      }

      const sample = rows.slice(0, 120);
      const keys = [...new Set(sample.flatMap(r => Object.keys(r || {})))];
      const summary = [
        `archivo: ${file.name}`,
        `filas: ${rows.length}`,
        `columnas_detectadas: ${keys.join(", ") || "sin columnas"}`,
        `muestra_json: ${JSON.stringify(sample).slice(0, 12000)}`
      ].join("\n");

      return { rows, summary };
    }

    function extractRecipesFromAiPayload(parsed) {
      const recipes = [];
      if (Array.isArray(parsed.recetas)) {
        parsed.recetas.forEach(r => recipes.push(r));
      }
      if (parsed.receta && typeof parsed.receta === "object") {
        recipes.push(parsed.receta);
      }
      return recipes;
    }

    function renderAiRecipePreview() {
      const cont = document.getElementById("aiRecipePreview");
      if (!aiPendingRecipes.length) {
        cont.innerHTML = "<div class='list-item'>Todavia no hay recetas sugeridas por IA.</div>";
        return;
      }

      cont.innerHTML = aiPendingRecipes.map((r, idx) => {
        const ingredientes = Array.isArray(r.ingredientes) ? r.ingredientes.length : 0;
        const mps = Array.isArray(r.materiasPrimas) ? r.materiasPrimas.length : 0;
        return `<div class='list-item' style='align-items:flex-start;'>
          <div style='display:flex; gap:.6rem; width:100%;'>
            <input type='checkbox' class='ai-recipe-check' data-idx='${idx}' checked>
            <div>
              <div><strong>${escapeHtml(String(r.nombre || `Receta IA ${idx + 1}`))}</strong></div>
              <div class='muted'>Produccion: ${Number(r.produccion || 1)} | Ingredientes: ${ingredientes} | Materias primas sugeridas: ${mps}</div>
              <div class='muted'>${escapeHtml(String(r.descripcion || "Sin descripcion"))}</div>
            </div>
          </div>
        </div>`;
      }).join("");
    }

    async function callGemini(prompt, apiKey) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 }
      };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Gemini fallo (${res.status}): ${txt}`);
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
      if (!text) throw new Error("Gemini no devolvio contenido.");
      return text;
    }

    function cleanJsonFromAi(text) {
      const raw = String(text || "").trim();
      const noFence = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
      const start = noFence.indexOf("{");
      const end = noFence.lastIndexOf("}");
      if (start === -1 || end === -1 || end <= start) return noFence;
      return noFence.slice(start, end + 1);
    }

    function ensureMateriaPrimaByName(mpName, extra = {}) {
      let mp = state.materiasPrimas.find(x => x.nombre.toLowerCase() === String(mpName).toLowerCase());
      if (!mp) {
        mp = {
          id: uid(),
          nombre: String(mpName).trim(),
          proveedor: "",
          unidadBase: "un",
          cantidadEmpaque: 1,
          precioEmpaque: 0
        };
        state.materiasPrimas.push(mp);
      }
      mp = { ...mp, ...extra, id: mp.id, nombre: mp.nombre };
      const idx = state.materiasPrimas.findIndex(x => x.id === mp.id);
      state.materiasPrimas[idx] = mp;
      return mp;
    }

    function appendRecipeFromAi(recipeRaw) {
      const rec = {
        id: uid(),
        nombre: String(recipeRaw.nombre || "Receta IA").trim() || "Receta IA",
        descripcion: String(recipeRaw.descripcion || "").trim(),
        tipo: normalizeRecipeType(recipeRaw.tipo),
        produccion: Math.max(1, Number(recipeRaw.produccion || 1) || 1),
        ingredientes: []
      };

      const localMps = Array.isArray(recipeRaw.materiasPrimas) ? recipeRaw.materiasPrimas : [];
      localMps.forEach(mpRaw => {
        const mp = sanitizeImportedMp(mpRaw);
        if (!mp) return;
        upsertMateriaPrima(mp);
      });

      const ings = Array.isArray(recipeRaw.ingredientes) ? recipeRaw.ingredientes : [];
      ings.forEach(ing => {
        const mpName = String(ing.nombre || ing.materiaPrima || "").trim();
        const qty = Number(ing.cantidad || 0);
        if (!mpName || qty <= 0) return;
        const mp = ensureMateriaPrimaByName(mpName);
        rec.ingredientes.push({ mpId: mp.id, cantidad: qty });
      });

      state.recetas.unshift(rec);
      state.activeRecipeId = rec.id;
    }

    function applyAiJsonToSystem(parsed) {
      const mps = Array.isArray(parsed.materiasPrimas) ? parsed.materiasPrimas : [];
      mps.forEach(mpRaw => {
        const mp = sanitizeImportedMp(mpRaw);
        if (!mp) return;
        upsertMateriaPrima(mp);
      });

      const recipes = extractRecipesFromAiPayload(parsed);
      recipes.forEach(r => appendRecipeFromAi(r));

      saveState();
      renderAll();
    }

    async function executeAi() {
      const provider = document.getElementById("aiProvider").value;
      const userPrompt = document.getElementById("aiPrompt").value.trim();
      const output = document.getElementById("aiOutput");
      const file = document.getElementById("aiRecipeFile").files[0];

      if (!userPrompt) {
        alert("Escribe una solicitud para la IA.");
        return;
      }

      let fileContext = "";
      if (file) {
        try {
          const { summary } = await readAiSourceFile(file);
          fileContext = summary;
          document.getElementById("aiFileInfo").textContent = `Archivo cargado: ${file.name}`;
        } catch (err) {
          alert(`No se pudo leer el archivo: ${String(err.message || err)}`);
          return;
        }
      }

      const fullPrompt = buildAiInstruction(userPrompt, fileContext);

      if (provider === "manual") {
        output.value = fullPrompt;
        alert("Prompt listo. Pegalo en ChatGPT/Gemini web y luego pega la respuesta JSON aqui.");
        return;
      }

      const apiKey = document.getElementById("aiApiKey").value.trim();
      if (!apiKey) {
        alert("Para Gemini debes ingresar API key.");
        return;
      }

      output.value = "Consultando Gemini...";
      try {
        const resText = await callGemini(fullPrompt, apiKey);
        output.value = resText;
      } catch (err) {
        output.value = String(err.message || err);
        alert("No se pudo ejecutar Gemini. Revisa API key, cupo y conexion.");
      }
    }

    function applyAiOutput() {
      const raw = document.getElementById("aiOutput").value;
      if (!raw.trim()) {
        alert("No hay salida IA para aplicar.");
        return;
      }

      try {
        const parsed = JSON.parse(cleanJsonFromAi(raw));
        aiPendingRecipes = extractRecipesFromAiPayload(parsed);
        aiPendingTasks = Array.isArray(parsed.tareas) ? parsed.tareas : [];
        if (!aiPendingRecipes.length) {
          alert("La IA no devolvio recetas. Revisa el prompt o el archivo de entrada.");
          return;
        }
        renderAiRecipePreview();
        const tasksMsg = aiPendingTasks.length ? `\nTareas sugeridas:\n- ${aiPendingTasks.join("\n- ")}` : "";
        alert(`Se prepararon ${aiPendingRecipes.length} recetas para confirmacion.` + tasksMsg);
      } catch {
        alert("La salida IA no es JSON valido con el formato esperado.");
      }
    }

    function confirmAiSelection() {
      if (!aiPendingRecipes.length) {
        alert("No hay recetas pendientes para confirmar.");
        return;
      }

      const checks = Array.from(document.querySelectorAll(".ai-recipe-check"));
      const selected = checks
        .filter(ch => ch.checked)
        .map(ch => aiPendingRecipes[Number(ch.dataset.idx)]);

      if (!selected.length) {
        alert("Selecciona al menos una receta para importar.");
        return;
      }

      selected.forEach(r => appendRecipeFromAi(r));
      saveState();
      renderAll();
      aiPendingRecipes = [];
      aiPendingTasks = [];
      renderAiRecipePreview();
      alert(`Importacion completada: ${selected.length} recetas confirmadas por usuario.`);
      switchView("recetario");
    }

    async function copyAiPrompt() {
      const prompt = getManualAiPrompt();
      try {
        await navigator.clipboard.writeText(prompt);
        alert("Prompt copiado. Pegalo en ChatGPT o Gemini web.");
      } catch {
        alert("No se pudo copiar automaticamente. Copialo desde la caja de salida IA.");
      }
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    document.querySelectorAll(".nav-btn").forEach(btn => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    document.getElementById("btnNuevaReceta").addEventListener("click", createRecipe);
    document.getElementById("btnAgregarMP").addEventListener("click", addMp);
    document.getElementById("inventarioSearch").addEventListener("input", renderInventory);
    document.getElementById("btnAgregarIng").addEventListener("click", addIngredient);
    document.getElementById("btnGuardarReceta").addEventListener("click", saveRecipeChanges);
    document.getElementById("btnEliminarReceta").addEventListener("click", deleteCurrentRecipe);
    document.getElementById("inputCargaRecetasCsv").addEventListener("change", (e) => importMassiveRecipesFromCsv(e.target.files[0]));
    document.getElementById("inputCargaCostosCsv").addEventListener("change", (e) => importCostStructuresFromCsv(e.target.files[0]));
    document.getElementById("btnDescargarPlantillaRecetas").addEventListener("click", downloadRecipeTemplateCsv);
    document.getElementById("btnDescargarPlantillaCostos").addEventListener("click", downloadCostStructureTemplateCsv);
    document.getElementById("btnFichaPdf").addEventListener("click", generateCurrentRecipePdf);
    document.getElementById("btnReporteSistemaPdf").addEventListener("click", openReportOptionsModal);
    document.getElementById("btnExportar").addEventListener("click", exportJson);
    document.getElementById("inputImportar").addEventListener("change", (e) => importJson(e.target.files[0]));
    document.getElementById("btnGuardarDbSegura").addEventListener("click", configureLinkedSecureAutoSave);
    document.getElementById("inputCargarDbSegura").addEventListener("change", (e) => loadEncryptedDatabaseFile(e.target.files[0]));
    document.getElementById("inputCargaMasiva").addEventListener("change", (e) => importMassiveIngredients(e.target.files[0]));
    document.getElementById("btnDescargarPlantilla").addEventListener("click", downloadMassiveTemplate);
    document.getElementById("btnAiEjecutar").addEventListener("click", executeAi);
    document.getElementById("btnAiAplicar").addEventListener("click", applyAiOutput);
    document.getElementById("btnAiConfirmar").addEventListener("click", confirmAiSelection);
    document.getElementById("btnAiCopiarPrompt").addEventListener("click", copyAiPrompt);
    document.getElementById("btnBatchAdjustByIngredient").addEventListener("click", applyBatchAdjustmentByIngredient);
    document.getElementById("dashChartMode").addEventListener("change", renderDashboardCharts);
    document.getElementById("dashPieRecipe").addEventListener("change", renderDashboardCharts);
    document.getElementById("dashCompareChartType").addEventListener("change", renderDashboardCharts);
    document.getElementById("btnDashCompareSelectAll").addEventListener("click", selectAllDashboardCompareRecipes);
    document.getElementById("btnDashCompareSelectFirst").addEventListener("click", selectFirstDashboardCompareRecipeOnly);
    document.getElementById("btnReportSelectAllRecipes").addEventListener("click", selectAllReportRecipes);
    document.getElementById("btnReportSelectFirstRecipe").addEventListener("click", selectFirstReportRecipeOnly);
    document.getElementById("btnAddWarehouse").addEventListener("click", addWarehouse);
    document.getElementById("btnApplyMpMovement").addEventListener("click", applyMpMovement);
    document.getElementById("btnApplyPtMovement").addEventListener("click", applyPtMovement);
    document.getElementById("btnCalcProductionNeeds").addEventListener("click", calculateProductionNeeds);
    document.getElementById("btnRegisterProduction").addEventListener("click", registerProductionFromNeeds);
    document.getElementById("inputImportProduccionCsv").addEventListener("change", (e) => importProductionCsv(e.target.files[0]));
    document.getElementById("inputImportProduccionHistorica").addEventListener("change", (e) => importProductionHistoryFile(e.target.files[0]));
    document.getElementById("btnDownloadProductionTemplate").addEventListener("click", downloadProductionTemplate);
    document.getElementById("btnLinkHistoryDb").addEventListener("click", configureLinkedHistoryDb);
    document.getElementById("btnDownloadHistoryDb").addEventListener("click", exportHistoryDbFile);
    document.getElementById("inputLoadHistoryDb").addEventListener("change", (e) => loadHistoryDbFile(e.target.files[0]));
    document.getElementById("btnClearProductionHistory").addEventListener("click", clearProductionHistory);
    document.getElementById("btnAssociateUnmappedHistory").addEventListener("click", associateUnmappedHistoryInBatch);
    document.getElementById("prodUnmappedHistoryFilter").addEventListener("input", renderUnmappedHistoryView);
    document.getElementById("prodMappedHistoryFilter").addEventListener("input", renderMappedHistoryView);
    document.getElementById("btnApplyPayrollToCf").addEventListener("click", applyPayrollToCf);
    document.getElementById("btnAddEmployee").addEventListener("click", addEmployee);
    document.getElementById("inputImportPlanillaCsv").addEventListener("change", (e) => importPlanillaCsv(e.target.files[0]));
    document.getElementById("btnDownloadPlanillaTemplate").addEventListener("click", downloadPlanillaTemplate);
    document.getElementById("btnGenerateProductionReport").addEventListener("click", generateProductionConsumptionReport);
    document.getElementById("btnApplyRealCosts").addEventListener("click", applyRealCostsToProducts);
    document.getElementById("btnExportProductionReportCsv").addEventListener("click", exportProductionSummaryCsv);
    document.getElementById("btnShowCostTrend").addEventListener("click", renderProductionCostTrendChart);
    document.getElementById("btnExportProductionAnalysisPdf").addEventListener("click", exportProductionAnalysisPdf);
    document.getElementById("btnShowVolumeTrend").addEventListener("click", renderProductionVolumeChart);
    document.getElementById("prodTrendRecipeFilter").addEventListener("change", renderProductionCostTrendChart);
    document.getElementById("prodTrendRecipeFilter").addEventListener("change", renderProductionVolumeChart);
    document.getElementById("prodTrendRecipeFilter").addEventListener("change", applyTrendRecipeSearchFilter);
    document.getElementById("prodTrendRecipeSearch").addEventListener("input", applyTrendRecipeSearchFilter);
    document.getElementById("prodTrendCostMetric").addEventListener("change", renderProductionCostTrendChart);
    document.getElementById("prodTrendDateMode").addEventListener("change", () => {
      refreshTrendDateInputsState();
      renderProductionCostTrendChart();
      renderProductionVolumeChart();
    });
    document.getElementById("prodTrendDay").addEventListener("change", renderProductionCostTrendChart);
    document.getElementById("prodTrendDay").addEventListener("change", renderProductionVolumeChart);
    document.getElementById("prodTrendDateFrom").addEventListener("change", renderProductionCostTrendChart);
    document.getElementById("prodTrendDateFrom").addEventListener("change", renderProductionVolumeChart);
    document.getElementById("prodTrendDateTo").addEventListener("change", renderProductionCostTrendChart);
    document.getElementById("prodTrendDateTo").addEventListener("change", renderProductionVolumeChart);
    document.getElementById("btnProdTrendSelectAll").addEventListener("click", selectAllTrendRecipes);
    document.getElementById("btnProdTrendSelectFiltered").addEventListener("click", selectFilteredTrendRecipes);
    document.getElementById("btnProdTrendClearSelection").addEventListener("click", clearTrendRecipeSelection);
    document.getElementById("prodVolumeMetric").addEventListener("change", renderProductionVolumeChart);
    document.getElementById("prodVolumeGroupBy").addEventListener("change", renderProductionVolumeChart);
    document.getElementById("btnViewLogs").addEventListener("click", viewLogs);
    document.getElementById("btnExportLogsCsv").addEventListener("click", exportLogsCsv);
    ["payrollDias", "payrollHorasDia"].forEach((id) => {
      document.getElementById(id).addEventListener("input", renderPayrollSummary);
    });
    document.querySelectorAll("input[data-line-metric]").forEach(el => {
      el.addEventListener("change", renderDashboardCharts);
    });
    document.getElementById("btnReportOptionsCancel").addEventListener("click", closeReportOptionsModal);
    document.getElementById("btnReportOptionsGenerate").addEventListener("click", generateSystemReportFromOptions);
    document.getElementById("reportOptionsModal").addEventListener("click", (e) => {
      if (e.target && e.target.id === "reportOptionsModal") closeReportOptionsModal();
    });
    document.getElementById("csRecetaSelect").addEventListener("change", (e) => {
      state.activeRecipeId = e.target.value;
      saveState();
      renderAll();
    });

    ["csUnidadesEmpaque", "csEmpaques"].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener("input", updateCostStructureFromForm);
      el.addEventListener("change", updateCostStructureFromForm);
    });

    [
      "csCostoReceta",
      "csMaterialEmpaque",
      "csTransporte",
      "csCostosOperativos",
      "csPvUnitario",
      "csPvCaja"
    ].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener("change", updateCostStructureFromForm);
      el.addEventListener("blur", updateCostStructureFromForm);
    });

    document.getElementById("csAllowCostoRecetaEdit").addEventListener("change", () => {
      const receta = currentRecipe();
      if (!receta) return;
      const cs = ensureCostStructure(receta);
      cs.allowManualCostoRecetaEdit = !!document.getElementById("csAllowCostoRecetaEdit")?.checked;
      const costoRecetaInput = document.getElementById("csCostoReceta");
      if (costoRecetaInput) costoRecetaInput.readOnly = !cs.allowManualCostoRecetaEdit;
      saveState();
    });

    document.getElementById("btnAplicarMbUnit").addEventListener("click", applyManualUnitMargin);
    document.getElementById("btnAplicarMbCaja").addEventListener("click", applyManualBoxMargin);
    document.getElementById("btnGuardarEstructuraCostos").addEventListener("click", saveCurrentCostStructure);
    document.getElementById("btnToggleCfCalc").addEventListener("click", toggleCfPanel);
    document.getElementById("csPvLockMode").addEventListener("change", updateCostStructureFromForm);

    ["csMbUnitPctInput", "csMbCajaPctInput"].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener("input", () => {
        const receta = currentRecipe();
        if (!receta) return;
        const cs = ensureCostStructure(receta);
        if ((cs.pvLockMode || "manual") === "margen") updateCostStructureFromForm();
      });
      el.addEventListener("change", () => {
        const receta = currentRecipe();
        if (!receta) return;
        const cs = ensureCostStructure(receta);
        if ((cs.pvLockMode || "manual") === "margen") updateCostStructureFromForm();
      });
    });

    [
      "cfModo",
      "cfUnidadesLote",
      "cfRiesgoPct",
      "cfPersonas",
      "cfDiasProduccion",
      "cfHorasDia",
      "cfCapInstalada",
      "cfUnidHoraEmpaque",
      "cfHorasEmpaque",
      "cfEnergiaAsignacionPct",
      "cfInfraAsignacionPct",
      "cfMezcladoMin",
      "cfLaminadoMin",
      "cfFormadoMin",
      "cfFermentadoMin",
      "cfHorneadoMin"
    ].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener("input", updateCfCalculatorFromForm);
      el.addEventListener("change", updateCfCalculatorFromForm);
    });

    ["cfSalarioBase", "cfEnergiaGlobal", "cfInfraGlobal"].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener("change", updateCfCalculatorFromForm);
      el.addEventListener("blur", updateCfCalculatorFromForm);
    });

    document.querySelectorAll(".dashboard-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        dashboardTypeFilter = btn.dataset.type === "pasteleria" ? "pasteleria" : "panaderia";
        document.querySelectorAll(".dashboard-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        renderRecipes();
      });
    });
    document.getElementById("aiRecipeFile").addEventListener("change", (e) => {
      const f = e.target.files[0];
      document.getElementById("aiFileInfo").textContent = f ? `Archivo seleccionado: ${f.name}` : "Sin archivo cargado.";
    });

    document.getElementById("costeoPesoUnidad").addEventListener("input", scheduleRealtimeWeightNormalization);
    document.getElementById("costeoUnidadesDeseadas").addEventListener("input", scheduleRealtimeWeightNormalization);
    document.getElementById("costeoVersion").addEventListener("change", () => applyRealtimeWeightNormalization(true));
    document.getElementById("costeoPesoUnidad").addEventListener("change", () => applyRealtimeWeightNormalization(true));
    document.getElementById("costeoUnidadesDeseadas").addEventListener("change", () => applyRealtimeWeightNormalization(true));

    setupMoneyInputs();
    loadState();
    renderAll();
    renderAiRecipePreview();
    tryAutoBridgeFromFileOrigin();
    tryAutoImportRecoveryStateOnHttp();
  
