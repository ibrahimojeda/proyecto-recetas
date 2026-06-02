const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
  const errors = [];
  const logs = [];
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    page.on('console', msg => logs.push(msg.text()));
    page.on('pageerror', err => errors.push(err.message));

    page.on('dialog', async dialog => {
      // respond to prompts
      await dialog.accept('Receta Automatica');
    });

    await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle2', timeout: 60000 });
    // wait until app exposes renderAll and UI ready
    await page.waitForFunction(() => !!(window && window.renderAll), { timeout: 30000 });
    await page.waitForSelector('#btnNuevaReceta', { timeout: 30000 });
    // diagnostic: check if recetaNombre element exists
    const exists = await page.evaluate(() => !!document.getElementById('recetaNombre'));
    console.log('diagnostic: recetaNombre exists?', exists);
    if (!exists) {
      const bodyHtml = await page.evaluate(() => document.body.innerHTML.slice(0, 1200));
      console.log('body snapshot:', bodyHtml);
    }
    // Create a recipe directly to avoid prompt dialog (headless)
    await page.evaluate(() => {
      const name = 'Receta Automatica';
      const r = { id: uid(), nombre: name, descripcion: '', tipo: 'panaderia', produccion:1, ingredientes: [] };
      state.recetas.unshift(r);
      state.activeRecipeId = r.id;
      saveState();
      switchView('recetario');
      renderAll();
    });
    // wait the editor to render and the field to be populated
    await page.waitForFunction(() => {
      const vr = document.getElementById('view-recetario');
      const rn = document.getElementById('recetaNombre');
      return vr && !vr.classList.contains('hidden') && rn && rn.value && rn.value.trim().length > 0;
    }, { timeout: 10000 });
    const nombre = await page.$eval('#recetaNombre', el => el.value);
    console.log('nombre:', nombre);

    // generate code
    await page.click('#btnGenerarCodigoFicha');
    await page.waitForFunction(() => document.getElementById('recetaFichaCodigo') && document.getElementById('recetaFichaCodigo').value.trim().length > 0, { timeout: 5000 });
    const code = await page.$eval('#recetaFichaCodigo', el => el.value);
    console.log('codigo generado:', code);

    // create a small PNG image file programmatically
    const imgDir = path.join(__dirname, 'fixtures');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    const imgPath = path.join(imgDir, 'test-image.png');
    // 1x1 red pixel PNG
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';
    fs.writeFileSync(imgPath, Buffer.from(base64, 'base64'));

    const input = await page.$('#recetaFichaImageInput');
    await input.uploadFile(imgPath);

    // wait for preview to show
    await page.waitForSelector('#recetaFichaImagePreview[src]', { visible: true, timeout: 5000 });
    const src = await page.$eval('#recetaFichaImagePreview', img => img.src);
    console.log('image src length:', src ? src.length : 0);

    // save recipe
    await page.click('#btnGuardarReceta');
    await new Promise(r => setTimeout(r, 500));

    // open PDF preview
    const [popupPromise] = await Promise.all([
      new Promise(resolve => page.browser().once('targetcreated', t => resolve(t))),
      page.click('#btnFichaPdf')
    ]);
    // give some time for PDF window
    await new Promise(r => setTimeout(r, 1500));

    if (errors.length) {
      console.error('Errors during run:', errors);
      process.exit(2);
    }

    console.log('Logs:', logs.slice(-20));
    console.log('Test completed successfully.');
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('Test failed:', err);
    await browser.close();
    process.exit(3);
  }
})();
