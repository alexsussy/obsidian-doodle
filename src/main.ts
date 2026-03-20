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
}

const DEFAULT_SETTINGS: BitmapDrawingSettings = {
  drawingsFolder: "doodles",
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

// ── plugin ────────────────────────────────────────────────────────────────────

export default class BitmapDrawingPlugin extends Plugin {
  settings: BitmapDrawingSettings;

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
      renderDrawingBlock(this.app, el, path);
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ── renderer ──────────────────────────────────────────────────────────────────

function renderDrawingBlock(app: App, root: HTMLElement, vaultPath: string) {
  root.addClass("doodle-root");

  const normalizedPath = normalizePath(vaultPath);

  const container  = root.createDiv({ cls: "bd-container" });
  const wrap       = container.createDiv({ cls: "bd-canvas-wrap" });
  const canvas     = wrap.createEl("canvas", { cls: "bd-canvas" }) as HTMLCanvasElement;
  canvas.width  = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;

  const overlay = container.createDiv({ cls: "bd-overlay" });
  overlay.createSpan({ cls: "bd-hint", text: "click to edit" });

  const toolbar = container.createDiv({ cls: "bd-toolbar" });
  const pip     = toolbar.createDiv({ cls: "bd-color-pip", attr: { title: "Color & size" } });
  const popup   = toolbar.createDiv({ cls: "bd-popup" });

  const sliderRow   = popup.createDiv({ cls: "bd-slider-row" });
  const sizePreview = sliderRow.createDiv({ cls: "bd-size-preview" });
  const slider      = sliderRow.createEl("input", { cls: "bd-size-slider" }) as HTMLInputElement;
  slider.type  = "range";
  slider.min   = "1";
  slider.max   = "4";
  slider.step  = "1";
  slider.value = "2";

  const swatchRow = popup.createDiv({ cls: "bd-swatch-row" });
  FLEXOKI_COLORS.forEach((hex) => {
    const s = swatchRow.createDiv({
      cls: "bd-pal-swatch",
      attr: { title: hex, "data-color": hex },
    });
    s.style.background = hex;
  });

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
  let brushRadius  = BRUSH_SIZES[1];
  let isDrawMode   = false;
  let isPainting   = false;
  let lastX = 0, lastY = 0;
  let strokeRect: DOMRect | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let popupOpen    = false;
  let outsideHandler: ((e: PointerEvent) => void) | null = null;
  let keyHandler:     ((e: KeyboardEvent) => void) | null = null;
  const undoStack: ImageData[] = [];

  pip.style.background = currentColor;
  swatchRow.querySelector<HTMLElement>(`[data-color="${currentColor}"]`)?.addClass("bd-selected");

  function updateSizePreview() {
    const screenDiameter = brushRadius * 2 * (canvas.getBoundingClientRect().width / CANVAS_SIZE);
    sizePreview.style.transform  = `scale(${Math.max(0.05, screenDiameter / 22)})`;
    sizePreview.style.background = currentColor;
  }
  updateSizePreview();

  function syncUndoBtn() {
    undoBtn.toggleAttribute("disabled", undoStack.length === 0);
  }

  slider.addEventListener("input", (e) => {
    e.stopPropagation();
    brushRadius = BRUSH_SIZES[parseInt(slider.value, 10) - 1];
    ctx.lineWidth = brushRadius * 2;
    updateSizePreview();
  });

  slider.addEventListener("pointerdown", (e) => e.stopPropagation());

  function openPopup() {
    popupOpen = true;
    popup.addClass("bd-open");
  }

  function closePopup() {
    popupOpen = false;
    popup.removeClass("bd-open");
  }

  pip.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    popupOpen ? closePopup() : openPopup();
  });

  swatchRow.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const swatch = (e.target as HTMLElement).closest<HTMLElement>(".bd-pal-swatch");
    if (!swatch) return;
    currentColor = swatch.dataset.color ?? currentColor;
    ctx.strokeStyle = currentColor;
    ctx.fillStyle   = currentColor;
    pip.style.background = currentColor;
    swatchRow.querySelectorAll(".bd-pal-swatch").forEach(s => s.removeClass("bd-selected"));
    swatch.addClass("bd-selected");
    updateSizePreview();
  });

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
    saveTimer = setTimeout(doSave, 200);
  }

  async function doSave() {
    const folder = normalizedPath.substring(0, normalizedPath.lastIndexOf("/"));
    if (folder) {
      const folderExists = await app.vault.adapter.exists(folder);
      if (!folderExists) {
        try { await app.vault.createFolder(folder); } catch { /* exists */ }
      }
    }
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      await app.vault.adapter.writeBinary(normalizedPath, await blob.arrayBuffer());
    }, "image/png");
  }

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

  function enterDrawMode() {
    if (isDrawMode) return;
    isDrawMode = true;
    overlay.style.display = "none";
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
    overlay.style.display = "";
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

  function startStroke(e: PointerEvent) {
    if (!isDrawMode) return;
    e.preventDefault();
    pushUndo();
    canvas.setPointerCapture(e.pointerId);
    isPainting   = true;
    strokeRect   = canvas.getBoundingClientRect();
    ctx.lineWidth   = brushRadius * 2;
    ctx.strokeStyle = currentColor;
    ctx.fillStyle   = currentColor;
    lastX = (e.clientX - strokeRect.left) * (CANVAS_SIZE / strokeRect.width);
    lastY = (e.clientY - strokeRect.top)  * (CANVAS_SIZE / strokeRect.height);
    ctx.beginPath();
    ctx.arc(lastX, lastY, brushRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  function continueStroke(e: PointerEvent) {
    if (!isDrawMode || !isPainting || !strokeRect) return;
    e.preventDefault();
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

  loadImage();
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
    containerEl.createEl("h2", { text: "Doodle" });

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
  }
}
