import {
  App,
  Editor,
  normalizePath,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";

// ── settings ──────────────────────────────────────────────────────────────────

interface BitmapDrawingSettings {
  drawingsFolder: string;
  colorPicker: boolean;
  uncappedPenSizes: boolean;
}

const DEFAULT_SETTINGS: BitmapDrawingSettings = {
  drawingsFolder: "doodles",
  colorPicker: false,
  uncappedPenSizes: false,
};

// ── Flexoki palette ───────────────────────────────────────────────────────────

const FLEXOKI_COLORS = [
  "#100F0F", // black
  "#575653", // base-700
  "#CECDC3", // base-200
  "#FFFCF0", // paper
  "#D14D41", // red-400
  "#DA702C", // orange-400
  "#D0A215", // yellow-400
  "#879A39", // green-400
  "#3AA99F", // cyan-400
  "#4385BE", // blue-400
  "#8B7EC8", // purple-400
  "#CE5D97", // magenta-400
];

const BRUSH_SIZES = [2, 5, 9, 14];
const CANVAS_SIZE = 1024;
const PICKER_W    = 192;
const PICKER_H    = 96;

// ── OKLCH color helpers ─────────────────────────────────────────────────────

function linToSrgb(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function srgbToLin(x: number): number {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function oklchToLinRgb(L: number, C: number, cosH: number, sinH: number): [number, number, number] {
  const a = C * cosH;
  const b = C * sinH;
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function maxChroma(L: number, cosH: number, sinH: number): number {
  if (L <= 0 || L >= 1) return 0;
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) * 0.5;
    const [r, g, b] = oklchToLinRgb(L, mid, cosH, sinH);
    if (r >= -1e-6 && r <= 1 + 1e-6 && g >= -1e-6 && g <= 1 + 1e-6 && b >= -1e-6 && b <= 1 + 1e-6) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function oklchToHex(L: number, C: number, hDeg: number): string {
  const hRad = hDeg * (Math.PI / 180);
  const [rLin, gLin, bLin] = oklchToLinRgb(L, C, Math.cos(hRad), Math.sin(hRad));
  return rgbToHex(toU8(rLin), toU8(gLin), toU8(bLin));
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

function hexToOklch(hex: string): [number, number, number] {
  const rLin = srgbToLin(parseInt(hex.slice(1, 3), 16) / 255);
  const gLin = srgbToLin(parseInt(hex.slice(3, 5), 16) / 255);
  const bLin = srgbToLin(parseInt(hex.slice(5, 7), 16) / 255);
  const l = 0.4122214708 * rLin + 0.5363325363 * gLin + 0.0514459929 * bLin;
  const m = 0.2119034982 * rLin + 0.6806995451 * gLin + 0.1073969566 * bLin;
  const s = 0.0883024619 * rLin + 0.2817188376 * gLin + 0.6299787005 * bLin;
  const lc = Math.cbrt(l);
  const mc = Math.cbrt(m);
  const sc = Math.cbrt(s);
  const L = 0.2104542553 * lc + 0.7936177850 * mc - 0.0040720468 * sc;
  const a = 1.9779984951 * lc - 2.4285922050 * mc + 0.4505937099 * sc;
  const b = 0.0259040371 * lc + 0.7827717662 * mc - 0.8086757660 * sc;
  const C = Math.sqrt(a * a + b * b);
  let H = Math.atan2(b, a) * (180 / Math.PI);
  if (H < 0) H += 360;
  return [L, C, H];
}

function toU8(linVal: number): number {
  return Math.max(0, Math.min(255, Math.round(linToSrgb(Math.max(0, Math.min(1, linVal))) * 255)));
}

function drawColorRect(pCtx: CanvasRenderingContext2D) {
  const w = PICKER_W * 2;
  const h = PICKER_H * 2;
  const imgData = pCtx.createImageData(w, h);
  const data = imgData.data;
  const cosCache = new Float64Array(w);
  const sinCache = new Float64Array(w);

  for (let px = 0; px < w; px++) {
    const hRad = (px / (w - 1)) * 2 * Math.PI;
    cosCache[px] = Math.cos(hRad);
    sinCache[px] = Math.sin(hRad);
  }

  for (let py = 0; py < h; py++) {
    const L = 1 - py / (h - 1);
    for (let px = 0; px < w; px++) {
      const C = maxChroma(L, cosCache[px], sinCache[px]);
      const [rLin, gLin, bLin] = oklchToLinRgb(L, C, cosCache[px], sinCache[px]);
      const idx = (py * w + px) * 4;
      data[idx]     = toU8(rLin);
      data[idx + 1] = toU8(gLin);
      data[idx + 2] = toU8(bLin);
      data[idx + 3] = 255;
    }
  }
  pCtx.putImageData(imgData, 0, 0);
}

function colorAtPosition(nx: number, ny: number): string {
  const hDeg = nx * 360;
  const L = 1 - ny;
  const hRad = hDeg * (Math.PI / 180);
  const C = maxChroma(L, Math.cos(hRad), Math.sin(hRad));
  return oklchToHex(L, C, hDeg);
}

// ── plugin ────────────────────────────────────────────────────────────────────

export default class BitmapDrawingPlugin extends Plugin {
  settings: BitmapDrawingSettings;
  readonly rebuilders = new Set<() => void>();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new BitmapDrawingSettingTab(this.app, this));

    this.addCommand({
      id: "add-drawing",
      name: "Add drawing",
      editorCallback: (editor: Editor) => {
        const folder   = this.settings.drawingsFolder.replace(/\/$/, "");
        const filename = `drawing-${Date.now()}.png`;
        const path     = `${folder}/${filename}`;
        editor.replaceSelection(`\n\`\`\`drawing\n${path}\n\`\`\`\n`);
      },
    });

    this.registerMarkdownCodeBlockProcessor("drawing", (source, el, _ctx) => {
      const path = source.trim();
      if (!path) return;
      renderDrawingBlock(this.app, el, path, this);
    });
  }

  refreshDrawings() {
    this.rebuilders.forEach((fn) => fn());
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (data) {
      if ("colorWheel" in data && !("colorPicker" in data)) {
        this.settings.colorPicker = !!data.colorWheel;
      }
      if (typeof data.colorPicker === "string") {
        this.settings.colorPicker = data.colorPicker !== "off";
      }
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ── renderer ──────────────────────────────────────────────────────────────────

function renderDrawingBlock(app: App, root: HTMLElement, vaultPath: string, plugin: BitmapDrawingPlugin) {
  root.addClass("doodle-root");

  const normalizedPath = normalizePath(vaultPath);

  const container  = root.createDiv({ cls: "bd-container" });
  const wrap       = container.createDiv({ cls: "bd-canvas-wrap" });
  const canvas     = wrap.createEl("canvas", { cls: "bd-canvas" });
  canvas.width  = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;

  const overlay = container.createDiv({ cls: "bd-overlay" });
  overlay.createSpan({ cls: "bd-hint", text: "click to edit" });

  const toolbar = container.createDiv({ cls: "bd-toolbar" });
  const pip     = toolbar.createDiv({ cls: "bd-color-pip", attr: { title: "Color & size" } });
  const popup   = toolbar.createDiv({ cls: "bd-popup" });

  toolbar.createDiv({ cls: "bd-divider" });

  const undoBtn = toolbar.createEl("button", {
    cls: "bd-undo-btn",
    text: "↩",
    attr: { title: "Undo", disabled: "true" },
  });

  const ctx = canvas.getContext("2d")!;
  ctx.globalCompositeOperation = "source-over";
  ctx.lineCap  = "round";
  ctx.lineJoin = "round";

  const isDark     = document.body.classList.contains("theme-dark");
  let currentColor = isDark ? "#FFFCF0" : "#100F0F";
  let brushRadius  = plugin.settings.uncappedPenSizes ? 5 : BRUSH_SIZES[1];
  let isDrawMode   = false;
  let isPainting   = false;
  let lastX = 0, lastY = 0;
  let strokeRect: DOMRect | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let popupOpen    = false;
  let outsideHandler: ((e: PointerEvent) => void) | null = null;
  let keyHandler:     ((e: KeyboardEvent) => void) | null = null;
  const undoStack: ImageData[] = [];

  let sizePreview: HTMLElement;
  let slider: HTMLInputElement;
  let swatchRow: HTMLElement;
  let pickerCursor: HTMLElement | null = null;

  pip.style.background = currentColor;

  function updateSizePreview() {
    const screenDiameter = brushRadius * 2 * (canvas.getBoundingClientRect().width / CANVAS_SIZE);
    sizePreview.style.transform  = `scale(${Math.max(0.05, screenDiameter / 22)})`;
    sizePreview.style.background = currentColor;
  }

  function updatePickerCursor(hex: string) {
    if (!pickerCursor) return;
    const [L, , H] = hexToOklch(hex);
    pickerCursor.style.left = `${(H / 360) * 100}%`;
    pickerCursor.style.top  = `${(1 - L) * 100}%`;
  }

  function applyColor(hex: string) {
    currentColor = hex;
    ctx.strokeStyle = hex;
    ctx.fillStyle   = hex;
    pip.style.background = hex;
    updateSizePreview();
    updatePickerCursor(hex);
  }

  function deselectSwatches() {
    swatchRow.querySelectorAll(".bd-pal-swatch").forEach((s) => s.removeClass("bd-selected"));
  }

  function syncUndoBtn() {
    undoBtn.toggleAttribute("disabled", undoStack.length === 0);
  }

  // ── build / rebuild popup contents ──────────────────────────────────────────

  function buildPopupContents() {
    popup.empty();
    const uncapped = plugin.settings.uncappedPenSizes;

    const sliderRow = popup.createDiv({ cls: "bd-slider-row" });
    sizePreview = sliderRow.createDiv({ cls: "bd-size-preview" });
    slider = sliderRow.createEl("input", { cls: "bd-size-slider" });
    slider.type = "range";
    if (uncapped) {
      slider.min   = "2";
      slider.max   = "14";
      slider.step  = "any";
      slider.value = String(Math.max(2, Math.min(14, brushRadius)));
    } else {
      slider.min   = "1";
      slider.max   = "4";
      slider.step  = "1";
      const nearest = BRUSH_SIZES.reduce((prev, curr) =>
        Math.abs(curr - brushRadius) < Math.abs(prev - brushRadius) ? curr : prev
      );
      brushRadius = nearest;
      slider.value = String(BRUSH_SIZES.indexOf(nearest) + 1);
    }

    slider.addEventListener("input", (e) => {
      e.stopPropagation();
      const val = parseFloat(slider.value);
      brushRadius = uncapped ? val : BRUSH_SIZES[Math.round(val) - 1];
      ctx.lineWidth = brushRadius * 2;
      updateSizePreview();
    });
    slider.addEventListener("pointerdown", (e) => e.stopPropagation());

    swatchRow = popup.createDiv({ cls: "bd-swatch-row" });
    FLEXOKI_COLORS.forEach((hex) => {
      const s = swatchRow.createDiv({
        cls: "bd-pal-swatch",
        attr: { title: hex, "data-color": hex },
      });
      s.style.background = hex;
    });

    swatchRow.querySelector<HTMLElement>(`[data-color="${currentColor}"]`)?.addClass("bd-selected");

    swatchRow.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const swatch = (e.target as HTMLElement).closest<HTMLElement>(".bd-pal-swatch");
      if (!swatch) return;
      applyColor(swatch.dataset.color ?? currentColor);
      deselectSwatches();
      swatch.addClass("bd-selected");
    });

    pickerCursor = null;

    if (plugin.settings.colorPicker) {
      if ("EyeDropper" in window) {
        const dropperBtn = swatchRow.createEl("button", {
          cls: "bd-dropper-btn",
          attr: { title: "Pick from screen" },
        });
        dropperBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3L15 6"/></svg>`;
        dropperBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
        dropperBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const dropper = new (window as any).EyeDropper();
          void (dropper.open() as Promise<{ sRGBHex: string }>).then((result) => {
            applyColor(result.sRGBHex);
            deselectSwatches();
          });
        });
      }

      const pickerPanel = popup.createDiv({ cls: "bd-picker-panel" });
      const pCanvas = pickerPanel.createEl("canvas", { cls: "bd-picker-canvas" });
      pCanvas.width  = PICKER_W * 2;
      pCanvas.height = PICKER_H * 2;
      const pCtx = pCanvas.getContext("2d")!;
      drawColorRect(pCtx);

      pickerCursor = pickerPanel.createDiv({ cls: "bd-picker-cursor" });
      updatePickerCursor(currentColor);

      const pCursor = pickerCursor;

      function pickFromRect(e: PointerEvent) {
        const rect = pCanvas.getBoundingClientRect();
        const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        applyColor(colorAtPosition(nx, ny));
        pCursor.style.left = `${nx * 100}%`;
        pCursor.style.top  = `${ny * 100}%`;
        deselectSwatches();
      }

      let pickerDragging = false;
      pCanvas.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        pickerDragging = true;
        pCanvas.setPointerCapture(e.pointerId);
        pCursor.addClass("bd-no-transition");
        pickFromRect(e);
      });
      pCanvas.addEventListener("pointermove", (e) => {
        if (pickerDragging) pickFromRect(e);
      });
      pCanvas.addEventListener("pointerup", () => {
        pickerDragging = false;
        pCursor.removeClass("bd-no-transition");
      });
      pCanvas.addEventListener("pointercancel", () => {
        pickerDragging = false;
        pCursor.removeClass("bd-no-transition");
      });
    }

    updateSizePreview();
  }

  buildPopupContents();

  const rebuild = () => {
    if (!root.isConnected) {
      plugin.rebuilders.delete(rebuild);
      return;
    }
    buildPopupContents();
  };
  plugin.rebuilders.add(rebuild);

  // ── popup open / close ──────────────────────────────────────────────────────

  function openPopup() {
    popupOpen = true;
    popup.addClass("bd-open");
    updateSizePreview();
  }

  function closePopup() {
    popupOpen = false;
    popup.removeClass("bd-open");
  }

  pip.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (popupOpen) closePopup(); else openPopup();
  });

  // ── load / save ─────────────────────────────────────────────────────────────

  async function loadImage() {
    const exists = await app.vault.adapter.exists(normalizedPath);
    if (!exists) return;
    try {
      const buffer = await app.vault.adapter.readBinary(normalizedPath);
      const blob   = new Blob([buffer], { type: "image/png" });
      const url    = URL.createObjectURL(blob);
      const img    = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
      };
      img.src = url;
    } catch { /* blank canvas */ }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void doSave(); }, 200);
  }

  async function doSave() {
    const folder = normalizedPath.substring(0, normalizedPath.lastIndexOf("/"));
    if (folder) {
      const folderExists = await app.vault.adapter.exists(folder);
      if (!folderExists) {
        try { await app.vault.createFolder(folder); } catch { /* exists */ }
      }
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      void blob.arrayBuffer().then((buf) => app.vault.adapter.writeBinary(normalizedPath, buf));
    }, "image/png");
  }

  // ── undo ────────────────────────────────────────────────────────────────────

  function pushUndo() {
    undoStack.push(ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE));
    if (undoStack.length > 20) undoStack.shift();
    syncUndoBtn();
  }

  function doUndo() {
    const snap = undoStack.pop();
    if (snap) {
      ctx.putImageData(snap, 0, 0);
      scheduleSave();
    }
    syncUndoBtn();
  }

  undoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    doUndo();
  });

  // ── draw mode ───────────────────────────────────────────────────────────────

  function enterDrawMode() {
    if (isDrawMode) return;
    isDrawMode = true;
    overlay.addClass("bd-hidden");
    toolbar.addClass("bd-visible");

    outsideHandler = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popupOpen && !popup.contains(target) && target !== pip) closePopup();
      if (!root.contains(target)) exitDrawMode();
    };
    document.addEventListener("pointerdown", outsideHandler, { capture: true });

    keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (popupOpen) { closePopup(); return; }
        exitDrawMode();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        doUndo();
      }
    };
    document.addEventListener("keydown", keyHandler);
  }

  function exitDrawMode() {
    if (!isDrawMode) return;
    isDrawMode = false;
    isPainting = false;
    overlay.removeClass("bd-hidden");
    toolbar.removeClass("bd-visible");
    closePopup();
    if (outsideHandler) {
      document.removeEventListener("pointerdown", outsideHandler, { capture: true });
      outsideHandler = null;
    }
    if (keyHandler) {
      document.removeEventListener("keydown", keyHandler);
      keyHandler = null;
    }
    scheduleSave();
  }

  // ── stroke handling ─────────────────────────────────────────────────────────

  function pressureRadius(e: PointerEvent): number {
    if (!plugin.settings.uncappedPenSizes) return brushRadius;
    const p = e.pressure > 0 ? e.pressure : 1;
    return Math.max(0.5, brushRadius * p);
  }

  function startStroke(e: PointerEvent) {
    if (!isDrawMode) return;
    e.preventDefault();
    pushUndo();
    canvas.setPointerCapture(e.pointerId);
    isPainting   = true;
    toolbar.addClass("bd-painting");
    strokeRect   = canvas.getBoundingClientRect();
    const r = pressureRadius(e);
    ctx.lineWidth   = r * 2;
    ctx.strokeStyle = currentColor;
    ctx.fillStyle   = currentColor;
    lastX = (e.clientX - strokeRect.left) * (CANVAS_SIZE / strokeRect.width);
    lastY = (e.clientY - strokeRect.top)  * (CANVAS_SIZE / strokeRect.height);
    ctx.beginPath();
    ctx.arc(lastX, lastY, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function continueStroke(e: PointerEvent) {
    if (!isDrawMode || !isPainting || !strokeRect) return;
    e.preventDefault();
    const r = pressureRadius(e);
    ctx.lineWidth = r * 2;
    const x = (e.clientX - strokeRect.left) * (CANVAS_SIZE / strokeRect.width);
    const y = (e.clientY - strokeRect.top)  * (CANVAS_SIZE / strokeRect.height);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();
    lastX = x;
    lastY = y;
  }

  function endStroke() {
    if (!isPainting) return;
    isPainting = false;
    toolbar.removeClass("bd-painting");
    strokeRect = null;
    scheduleSave();
  }

  canvas.addEventListener("pointerdown",   startStroke);
  canvas.addEventListener("pointermove",   continueStroke);
  canvas.addEventListener("pointerup",     endStroke);
  canvas.addEventListener("pointerleave",  endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  overlay.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    enterDrawMode();
  });

  void loadImage();
}

// ── settings tab ──────────────────────────────────────────────────────────────

class BitmapDrawingSettingTab extends PluginSettingTab {
  plugin: BitmapDrawingPlugin;

  constructor(app: App, plugin: BitmapDrawingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Location").setHeading();

    new Setting(containerEl)
      .setName("Doodles folder")
      .setDesc("Relative folder where your doodles are saved.")
      .addText((text) =>
        text
          .setPlaceholder("Doodles")
          .setValue(this.plugin.settings.drawingsFolder)
          .onChange(async (value) => {
            this.plugin.settings.drawingsFolder = value.trim() || "doodles";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Features").setHeading();

    new Setting(containerEl)
      .setName("Color picker")
      .setDesc("Unshackle your restraints. Enables a color picker (OKLab) and dropper tool.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.colorPicker)
          .onChange(async (value) => {
            this.plugin.settings.colorPicker = value;
            await this.plugin.saveSettings();
            this.plugin.refreshDrawings();
          })
      );

    new Setting(containerEl)
      .setName("Pen pressure")
      .setDesc("Show your strength. Enables pen pressure and uncaps pen sizes.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.uncappedPenSizes)
          .onChange(async (value) => {
            this.plugin.settings.uncappedPenSizes = value;
            await this.plugin.saveSettings();
            this.plugin.refreshDrawings();
          })
      );
  }
}
