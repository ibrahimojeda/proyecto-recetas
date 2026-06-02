
    const STORAGE_KEY = "quantum-cost-control-local-v1";

    let state = {
      materiasPrimas: [],
      recetas: [],
      activeRecipeId: null,
      warehouses: [],
      payrollInfo: {},
      productionReports: [],
      employees: [],
      logsByMonth: {}
    };

    let aiPendingRecipes = [];
    let aiPendingTasks = [];
    let liveCosteoTimer = null;
    let dashboardTypeFilter = "panaderia";
    let dashCostPieChart = null;
    let dashCompareChart = null;
    let dashboardCompareSelectedIds = new Set();
    let dashboardCurrentFilteredRecipeIds = [];
    let reportSelectedRecipeIds = new Set();
    let pendingProductionNeeds = null;
    let linkedSecureFileHandle = null;
    let linkedSecurePassphrase = "";
    let linkedSecureAutoSaveEnabled = false;
    let secureAutoSaveTimer = null;

    function normalizeRecipeType(value) {
      return String(value || "").toLowerCase() === "pasteleria" ? "pasteleria" : "panaderia";
    }

    function formatRecipeTypeLabel(value) {
      return normalizeRecipeType(value) === "pasteleria" ? "Pastelería" : "Panadería";
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
            employees: Array.isArray(parsed.employees) ? parsed.employees : [],
            logsByMonth: parsed.logsByMonth && typeof parsed.logsByMonth === "object" ? parsed.logsByMonth : {}
          };
        }
      } catch {
        alert("No se pudo leer el estado local guardado. Se cargará un estado limpio.");
      }
    }

    function saveState() {
      state.warehouses = Array.isArray(state.warehouses) ? state.warehouses : [];
      state.payrollInfo = state.payrollInfo && typeof state.payrollInfo === "object" ? state.payrollInfo : {};
      state.productionReports = Array.isArray(state.productionReports) ? state.productionReports : [];
      state.employees = Array.isArray(state.employees) ? state.employees : [];
      state.logsByMonth = state.logsByMonth && typeof state.logsByMonth === "object" ? state.logsByMonth : {};
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      scheduleSecureSystemAutoSave();
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
          dashCostPieChart = new Chart(pieCanvas.getContext("2d"), {
            type: "pie",
            data: {
              labels: ["Ingredientes", "Carga Fabril"],
              datasets: [{
                data: [Number(totals.costoReceta || 0), Number(totals.cargaFabril || 0)],
                backgroundColor: ["#16a34a", "#f59e0b"]
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { position: "bottom" } }
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

      renderAll();
    }

    function renderKpis() {
      document.getElementById("kpiRecetas").textContent = state.recetas.length;
      document.getElementById("kpiInsumos").textContent = state.materiasPrimas.length;
    }

    function renderRecipes() {
      const cont = document.getElementById("listaRecetas");
      const filtered = state.recetas.filter(r => normalizeRecipeType(r.tipo) === dashboardTypeFilter);

      if (!filtered.length) {
        cont.innerHTML = "<div class='panel'>No hay recetas todavía.</div>";
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
          <p style='color:#64748b; font-size:.9rem;'>${escapeHtml(r.descripcion || "Sin descripción")}</p>
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
      if (!state.materiasPrimas.length) {
        cont.innerHTML = "<div class='list-item'>No hay materias primas cargadas.</div>";
        return;
      }

      cont.innerHTML = state.materiasPrimas.map(mp => {
        const costo = Number(mp.precioEmpaque || 0).toFixed(2);
        const warehouses = ensureWarehouses();
        const stockLine = warehouses
          .map(w => `${w.nombre}: ${getMpStock(mp, w.id).toFixed(2)}`)
          .join(" | ");
        return `<div class='list-item'>
          <div>
            <strong>${escapeHtml(mp.nombre)}</strong>
            <div style='color:#64748b; font-size:.84rem;'>${escapeHtml(mp.proveedor || "Sin proveedor")} | ${escapeHtml(mp.unidadBase || "un")}</div>
            <div class='muted' style='font-size:.8rem;'>Stock por almacén: ${escapeHtml(stockLine || "0")}</div>
          </div>
          <div style='display:flex; align-items:center; gap:.45rem;'>
            <span>$${costo}</span>
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
      if (!nombre) return alert("Ingresa un nombre de almacén.");
      if (ensureWarehouses().some(w => w.nombre.toLowerCase() === nombre.toLowerCase())) return alert("Ese almacén ya existe.");
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
      const salario = Math.max(0, Number(document.getElementById("empSalario")?.value || 0));
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
      if (!warehouseId || !mp || !Number.isFinite(delta) || delta === 0) return alert("Completa almacén, materia prima y cantidad válida.");
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
      if (!warehouseId || !recipe || !Number.isFinite(delta) || delta === 0) return alert("Completa almacén, producto y cantidad válida.");
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
      const totals = computeCostStructureTotals(ensureCostStructure(recipe));
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
        unitCost
      };

      document.getElementById("prodNeedsSummary").textContent = `Producto: ${pendingProductionNeeds.recipeName} | Pedido: ${requestedQty.toFixed(2)} u | Costo estimado: B/. ${pendingProductionNeeds.estimatedCost.toFixed(4)}`;
      document.getElementById("prodNeedsTable").innerHTML = `<table class='tech-table'><thead><tr><th>Materia Prima</th><th>Necesario</th><th>Disponible</th><th>Faltante</th></tr></thead><tbody>${requirements.map(r => `<tr><td>${escapeHtml(r.nombre)}</td><td>${r.neededQty.toFixed(4)} ${escapeHtml(r.unidad)}</td><td>${r.available.toFixed(4)} ${escapeHtml(r.unidad)}</td><td>${r.shortage.toFixed(4)} ${escapeHtml(r.unidad)}</td></tr>`).join("") || "<tr><td colspan='4'>Sin ingredientes</td></tr>"}</tbody></table>`;
      return pendingProductionNeeds;
    }

    function registerProductionFromNeeds() {
      const plan = pendingProductionNeeds || calculateProductionNeeds();
      if (!plan) return;
      if (!plan.warehouseMpId || !plan.warehousePtId) return alert("Selecciona almacén de MP y PT.");

      plan.requirements.forEach(req => {
        const mp = state.materiasPrimas.find(x => x.id === req.mpId);
        if (!mp) return;
        setMpStock(mp, plan.warehouseMpId, getMpStock(mp, plan.warehouseMpId) - req.neededQty);
      });

      const recipe = state.recetas.find(r => r.id === plan.recipeId);
      if (recipe) setFinishedStock(recipe, plan.warehousePtId, getFinishedStock(recipe, plan.warehousePtId) + plan.requestedQty);

      state.productionReports = Array.isArray(state.productionReports) ? state.productionReports : [];
      state.productionReports.unshift({ id: uid(), fecha: new Date().toISOString(), ...plan, totalConsumedCost: plan.estimatedCost });
      logSystem("produccion", "create", "orden", { recipeId: plan.recipeId, requestedQty: plan.requestedQty, totalConsumedCost: plan.estimatedCost });
      saveState();
      renderAll();
      alert("Producción registrada correctamente.");
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
      out.textContent = `Empleados activos: ${p.activos} | Planilla mensual: B/. ${p.totalMensual.toFixed(2)} | Costo/día: B/. ${p.costoDia.toFixed(2)} | Costo/hora: B/. ${p.costoHora.toFixed(4)}`;
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
          byRecipe[r.recipeId] = { recipeId: r.recipeId, recipeName: r.recipeName, qty: 0, totalCost: 0 };
        }
        byRecipe[r.recipeId].qty += Number(r.requestedQty || 0);
        byRecipe[r.recipeId].totalCost += Number(r.totalConsumedCost || 0);
      });

      return Object.values(byRecipe).map(x => ({
        ...x,
        realUnitCost: x.qty > 0 ? (x.totalCost / x.qty) : 0
      }));
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
        table.innerHTML = `<table class='tech-table'><thead><tr><th>Producto</th><th>Cantidad</th><th>Costo Total</th><th>Costo Real Unitario</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escapeHtml(r.recipeName || "Sin nombre")}</td><td>${r.qty.toFixed(4)}</td><td>B/. ${r.totalCost.toFixed(4)}</td><td>B/. ${r.realUnitCost.toFixed(4)}</td></tr>`).join("")}</tbody></table>`;
      }

      const lines = ["RESUMEN DE PRODUCCION Y COSTOS REALES", `Generado: ${new Date().toLocaleString()}`, ""];
      rows.forEach((r, idx) => {
        lines.push(`${idx + 1}. ${r.recipeName} | Cantidad: ${r.qty.toFixed(4)} | Costo total: B/. ${r.totalCost.toFixed(4)} | Costo real unit: B/. ${r.realUnitCost.toFixed(4)}`);
      });
      if (out) out.value = lines.join("\n");
    }

    function applyRealCostsToProducts() {
      const rows = getProductionSummaryRows();
      if (!rows.length) return alert("No hay datos históricos para actualizar costos reales.");
      rows.forEach(r => {
        const recipe = state.recetas.find(x => x.id === r.recipeId);
        if (!recipe) return;
        const cs = ensureCostStructure(recipe);
        cs.costoReceta = Number(r.realUnitCost.toFixed(4));
      });
      logSystem("costos", "update", "real_cost", { products: rows.length });
      saveState();
      renderAll();
      alert("Costo real actualizado en productos del periodo seleccionado.");
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
            salario: Math.max(0, Number(r.salario || 0)),
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
      downloadCsv("plantilla_produccion.csv", ["fecha", "codigoProducto", "nombreProducto", "cantidadProducida", "costoUnitarioReal", "costoTotal", "almacenMP", "almacenPT"], [[new Date().toISOString(), "", "Pan Integral", "100", "1.23", "123.00", "Almacen Principal", "Almacen Principal"]]);
    }

    function importProductionCsv(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const rows = parseSimpleCsvObjects(String(reader.result || ""));
        state.productionReports = Array.isArray(state.productionReports) ? state.productionReports : [];
        let added = 0;
        rows.forEach(r => {
          const recipe = state.recetas.find(x => String(x.nombre || "").toLowerCase() === String(r.nombreProducto || "").toLowerCase());
          if (!recipe) return;
          const qty = Math.max(0, Number(r.cantidadProducida || 0));
          const unit = Math.max(0, Number(r.costoUnitarioReal || 0));
          const total = Number.isFinite(Number(r.costoTotal)) ? Number(r.costoTotal) : (qty * unit);
          state.productionReports.unshift({
            id: uid(),
            fecha: r.fecha || new Date().toISOString(),
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
            totalConsumedCost: total
          });
          added += 1;
        });
        logSystem("produccion", "import", "production_csv", { added });
        saveState();
        renderAll();
        alert(`Producciones importadas: ${added}.`);
      };
      reader.readAsText(file);
    }

    function exportProductionSummaryCsv() {
      const rows = getProductionSummaryRows();
      if (!rows.length) return alert("No hay datos para exportar.");
      downloadCsv("resumen_produccion_costos.csv", ["producto", "cantidad", "costoTotal", "costoRealUnitario"], rows.map(r => [r.recipeName, r.qty.toFixed(4), r.totalCost.toFixed(4), r.realUnitCost.toFixed(4)]));
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

    function computeRecipe(recipe) {

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
        const cantEmp = Number(mp.cantidadEmpaque || 0);
        const precioEmp = Number(mp.precioEmpaque || 0);
        const costoUnitario = cantEmp > 0 ? (precioEmp / cantEmp) : 0;
        costoBase += costoUnitario * Number(i.cantidad || 0);
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
        <div class="muted">Valor unitario producción: B/. ${cfResult.valorUnitProduccion.toFixed(4)} | Valor unitario empacado: B/. ${cfResult.valorUnitEmpaque.toFixed(4)}</div>
        <div class="muted">Tiempo total etapas: ${cfResult.totalMin.toFixed(2)} min | Costo proceso lote: B/. ${cfResult.costoProcesoLote.toFixed(4)} | Unidades lote: ${cfResult.unidadesLote.toFixed(2)}</div>
      `;
    }

    function updateCostStructureFromForm() {
      const receta = currentRecipe();
      if (!receta) return;
      const cs = ensureCostStructure(receta);

      cs.unidadesPorEmpaque = Math.max(1, Number(document.getElementById("csUnidadesEmpaque").value || 1));
      cs.empaques = Math.max(1, Number(document.getElementById("csEmpaques").value || 1));
      cs.costoReceta = Math.max(0, Number(document.getElementById("csCostoReceta").value || 0));
      cs.materialEmpaque = Math.max(0, Number(document.getElementById("csMaterialEmpaque").value || 0));
      cs.transporte = Math.max(0, Number(document.getElementById("csTransporte").value || 0));
      cs.costosOperativos = Math.max(0, Number(document.getElementById("csCostosOperativos").value || 0));
      cs.pvLockMode = document.getElementById("csPvLockMode").value === "margen" ? "margen" : "manual";

      if (cs.pvLockMode === "margen") {
        const unitTargetPct = Number(document.getElementById("csMbUnitPctInput").value || 0);
        const boxTargetPct = Number(document.getElementById("csMbCajaPctInput").value || 0);

        const totals = computeCostStructureTotals(cs);
        if (unitTargetPct >= 0 && unitTargetPct < 100) {
          cs.pvUnitario = Number((totals.pcUnitario / (1 - (unitTargetPct / 100))).toFixed(4));
        }
        if (boxTargetPct >= 0 && boxTargetPct < 100) {
          cs.pvCaja = Number((totals.totalCostos / (1 - (boxTargetPct / 100))).toFixed(4));
        }
      } else {
        cs.pvUnitario = Math.max(0, Number(document.getElementById("csPvUnitario").value || 0));
        cs.pvCaja = Math.max(0, Number(document.getElementById("csPvCaja").value || 0));
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
      cfg.salarioBase = Math.max(0, Number(document.getElementById("cfSalarioBase").value || 0));
      cfg.riesgoPct = Math.max(0, Number(document.getElementById("cfRiesgoPct").value || 0));
      cfg.personas = Math.max(1, Number(document.getElementById("cfPersonas").value || 1));
      cfg.diasProduccion = Math.max(1, Number(document.getElementById("cfDiasProduccion").value || 1));
      cfg.horasDia = Math.max(1, Number(document.getElementById("cfHorasDia").value || 1));
      cfg.capacidadInstalada = Math.max(1, Number(document.getElementById("cfCapInstalada").value || 1));
      cfg.unidadesHoraEmpaque = Math.max(1, Number(document.getElementById("cfUnidHoraEmpaque").value || 1));
      cfg.horasEmpaque = Math.max(0, Number(document.getElementById("cfHorasEmpaque").value || 0));
      cfg.energiaGlobal = Math.max(0, Number(document.getElementById("cfEnergiaGlobal").value || 0));
      cfg.energiaAsignacionPct = Math.max(0, Number(document.getElementById("cfEnergiaAsignacionPct").value || 0));
      cfg.infraGlobal = Math.max(0, Number(document.getElementById("cfInfraGlobal").value || 0));
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
      const targetPct = Number(document.getElementById("csMbUnitPctInput").value || 0);
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
      const targetPct = Number(document.getElementById("csMbCajaPctInput").value || 0);
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
        const q = Number(i.cantidad || 0);
        return acc + (Number.isFinite(q) && q > 0 ? q : 0);
      }, 0);

      ingredientes.forEach(i => {
        const q = Number(i.cantidad || 0);
        if (totalCantidad > 0 && Number.isFinite(q) && q >= 0) {
          i.porcentaje = (q / totalCantidad) * 100;
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
        body.innerHTML = "<tr><td colspan='7' class='muted'>No hay ingredientes.</td></tr>";
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
          let costoLinea = Number(i.costoReceta);
          if (!(Number.isFinite(costoLinea) && costoLinea >= 0)) {
            const cantEmp = Number(mp?.cantidadEmpaque || 0);
            const precioEmp = Number(mp?.precioEmpaque || 0);
            const costoUnitario = cantEmp > 0 ? (precioEmp / cantEmp) : 0;
            costoLinea = costoUnitario * Number(i.cantidad || 0);
          }
          totalCosto += Number.isFinite(costoLinea) ? costoLinea : 0;

          return `<tr>
            <td>${Number(i.cantidad || 0).toFixed(2)}</td>
            <td>${escapeHtml(String(unidad))}</td>
            <td>${escapeHtml(String(nombre))}</td>
            <td>${Number(i.porcentaje || 0).toFixed(2)}%</td>
            <td>${escapeHtml(String(proveedor || "-"))}</td>
            <td>$${Number(costoLinea || 0).toFixed(2)}</td>
            <td><button class='btn' onclick='removeIngredient(${idx})'>Quitar</button></td>
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
      state.materiasPrimas.push({
        id: uid(),
        nombre,
        proveedor: document.getElementById("mpProveedor").value.trim(),
        unidadBase: document.getElementById("mpUnidad").value.trim() || "un",
        cantidadEmpaque: Number(document.getElementById("mpCantidad").value || 1),
        precioEmpaque: Number(document.getElementById("mpPrecio").value || 0)
      });
      logSystem("inventario", "create", "materia_prima", { nombre });
      saveState();
      renderAll();
      ["mpNombre", "mpProveedor", "mpUnidad", "mpCantidad", "mpPrecio"].forEach(id => document.getElementById(id).value = "");
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
          alert("No se pudo cargar el lector de Excel. Revisa tu conexión a internet.");
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
      receta.ingredientes.push({
        mpId,
        cantidad,
        unidad: mp?.unidadBase || "un",
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
      const unidad = String(row.unidad || "gr").trim() || "gr";
      const cantidad = parseLocaleNumber(row.cantidad);
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

      if (Number.isFinite(cantidad) && Number.isFinite(costoReceta) && cantidad > 0 && !mp.precioEmpaque) {
        mp.cantidadEmpaque = 1;
        mp.precioEmpaque = costoReceta / cantidad;
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
              const porcentaje = parseLocaleNumber(row.porcentaje);
              const costoReceta = parseLocaleNumber(row.costoReceta);

              receta.ingredientes.push({
                mpId: mp.id,
                cantidad: Number.isFinite(cantidad) ? cantidad : 0,
                unidad: String(row.unidad || mp.unidadBase || "gr").trim() || "gr",
                porcentaje: Number.isFinite(porcentaje) ? porcentaje : null,
                proveedor: String(row.proveedor || mp.proveedor || "").trim(),
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
            alert("Clave incorrecta o archivo dañado.");
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
        const shouldDownload = confirm("Se abrió la vista previa del PDF. ¿Deseas descargarlo ahora?");
        if (shouldDownload) doc.save(fileName);
      }
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
        alert("Para insertar gráfico de líneas o radar en el reporte debes seleccionar mas de 2 recetas.");
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
        alert("No se pudo cargar el generador PDF. Revisa tu conexión.");
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
      section("RESUMEN DE COSTOS Y PRECIOS", [
        `Costo receta: B/. ${totals.costoReceta.toFixed(4)} | Carga fabril: B/. ${totals.cargaFabril.toFixed(4)} (${cfResult.modo})`,
        `PC unitario: B/. ${totals.pcUnitario.toFixed(4)} | PV unitario: B/. ${totals.pvUnitario.toFixed(4)} | MB: ${totals.mbUnitPct.toFixed(2)}%`
      ], true);

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

      previewPdfDocument(doc, `ficha_tecnica_${sanitizeFileName(recipe.nombre)}.pdf`, true);
    }

    function generateSystemReportPdf(options = {}) {
      if (!window.jspdf || !window.jspdf.jsPDF) {
        alert("No se pudo cargar el generador PDF. Revisa tu conexión.");
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

        if (cfg.includeChartPie) {
          const totalsByRecipe = selectedRecipes.map(r => computeCostStructureTotals(ensureCostStructure(r)));
          const sumCostoReceta = totalsByRecipe.reduce((acc, t) => acc + Number(t.costoReceta || 0), 0);
          const sumCargaFabril = totalsByRecipe.reduce((acc, t) => acc + Number(t.cargaFabril || 0), 0);
          const pieImg = buildReportChartDataUrl({
            type: "pie",
            data: {
              labels: ["Ingredientes", "Carga Fabril"],
              datasets: [{ data: [sumCostoReceta, sumCargaFabril], backgroundColor: ["#16a34a", "#f59e0b"] }]
            },
            options: { plugins: { legend: { position: "bottom" } } }
          }, 640, 320);

          if (pieImg) {
            y = ensurePageSpace(y, 250);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(10);
            doc.text("Distribucion de Costos (recetas seleccionadas)", 40, y);
            y += 10;
            doc.addImage(pieImg, "PNG", 40, y, pageW - 80, 210);
            y += 220;
          }
        }

        if (cfg.includeChartCompare) {
          const totalsByRecipe = selectedRecipes.map(r => computeCostStructureTotals(ensureCostStructure(r)));
          const chartLabels = selectedRecipes.map(r => r.nombre || "Sin nombre");
          const datasets = [
            { label: "Utilidad %", data: totalsByRecipe.map(t => Number(t.mbUnitPct || 0)), borderColor: "#ef4444", backgroundColor: "rgba(239,68,68,0.35)", yAxisID: "yPercent" },
            { label: "PV Unitario", data: totalsByRecipe.map(t => Number(t.pvUnitario || 0)), borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,0.3)", yAxisID: "yMoney" },
            { label: "PC Unitario", data: totalsByRecipe.map(t => Number(t.pcUnitario || 0)), borderColor: "#059669", backgroundColor: "rgba(5,150,105,0.3)", yAxisID: "yMoney" }
          ];

          const compareImg = buildReportChartDataUrl({
            type: cfg.compareChartType,
            data: { labels: chartLabels, datasets },
            options: {
              scales: {
                yPercent: { type: "linear", position: "left", beginAtZero: true, ticks: { callback: (value) => `${value}%` }, grid: { drawOnChartArea: false } },
                yMoney: { type: "linear", position: "right", beginAtZero: true, grid: { drawOnChartArea: true } }
              }
            }
          }, 760, 340);

          if (compareImg) {
            y = ensurePageSpace(y, 270);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(10);
            doc.text(`Comparador de Productos (${cfg.compareChartType.toUpperCase()})`, 40, y);
            y += 10;
            doc.addImage(compareImg, "PNG", 40, y, pageW - 80, 230);
            y += 240;
          }
        }

        y += 6;
      }

      const includeRecipePages = cfg.includeRecipeSummary || cfg.includeIngredients || cfg.includeCfDetails;
      if (!includeRecipePages) {
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
          ry += 14;
          doc.text(`Costo base receta: B/. ${calc.costoBase.toFixed(4)} | Costo unitario base: B/. ${(calc.costoBase / produccion).toFixed(4)}`, 40, ry);
          ry += 14;
          doc.text(`PC unitario: B/. ${totals.pcUnitario.toFixed(4)} | PV unitario: B/. ${totals.pvUnitario.toFixed(4)} | MB: ${totals.mbUnitPct.toFixed(2)}%`, 40, ry);
          ry += 14;
          doc.text(`PC caja: B/. ${totals.pcCaja.toFixed(4)} | PV caja: B/. ${totals.pvCaja.toFixed(4)} | MB caja: ${totals.mbCajaPct.toFixed(2)}%`, 40, ry);
          ry += 18;
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
        ["nombre", "descripcion", "tipo", "produccion", "ingrediente", "cantidad", "unidad"],
        [["Pan Integrado", "Receta base", "panaderia", "100", "Harina 000", "60", "kg"]]
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
    document.getElementById("btnDownloadProductionTemplate").addEventListener("click", downloadProductionTemplate);
    document.getElementById("btnApplyPayrollToCf").addEventListener("click", applyPayrollToCf);
    document.getElementById("btnAddEmployee").addEventListener("click", addEmployee);
    document.getElementById("inputImportPlanillaCsv").addEventListener("change", (e) => importPlanillaCsv(e.target.files[0]));
    document.getElementById("btnDownloadPlanillaTemplate").addEventListener("click", downloadPlanillaTemplate);
    document.getElementById("btnGenerateProductionReport").addEventListener("click", generateProductionConsumptionReport);
    document.getElementById("btnApplyRealCosts").addEventListener("click", applyRealCostsToProducts);
    document.getElementById("btnExportProductionReportCsv").addEventListener("click", exportProductionSummaryCsv);
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

    [
      "csUnidadesEmpaque",
      "csEmpaques",
      "csCostoReceta",
      "csMaterialEmpaque",
      "csTransporte",
      "csCostosOperativos",
      "csPvUnitario",
      "csPvCaja"
    ].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener("input", updateCostStructureFromForm);
      el.addEventListener("change", updateCostStructureFromForm);
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
      "cfSalarioBase",
      "cfRiesgoPct",
      "cfPersonas",
      "cfDiasProduccion",
      "cfHorasDia",
      "cfCapInstalada",
      "cfUnidHoraEmpaque",
      "cfHorasEmpaque",
      "cfEnergiaGlobal",
      "cfEnergiaAsignacionPct",
      "cfInfraGlobal",
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

    loadState();
    renderAll();
    renderAiRecipePreview();
  

}
