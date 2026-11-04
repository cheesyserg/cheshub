/* Shared appearance preferences: accent palette, backdrop and wallpaper image.
   Stored once per origin so the hub and every studio share the same theme. */

(function () {
  const STORAGE_KEY = "cheshub.wallpaper";
  const PRESETS = ["aurora", "ocean", "sunset", "forest", "graphite"];
  const PRESET_LABELS = {
    aurora: "Aurora",
    ocean: "Ocean",
    sunset: "Sunset",
    forest: "Forest",
    graphite: "Graphite"
  };
  const ACCENTS = [
    { id: "azure", label: "Azure", color: "#2f9fdd" },
    { id: "violet", label: "Violet", color: "#8b5cf6" },
    { id: "emerald", label: "Emerald", color: "#1fae7a" },
    { id: "amber", label: "Amber", color: "#d38f1f" },
    { id: "rose", label: "Rose", color: "#e05588" },
    { id: "slate", label: "Slate", color: "#8b95a5" }
  ];

  const data = { image: "", motion: true, preset: "aurora", accent: "azure" };
  const root = document.documentElement;
  let modal = null;

  function notify(message) {
    if (typeof window.showToast === "function") window.showToast(message);
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!raw) return;
      if (typeof raw.image === "string") data.image = raw.image;
      if (typeof raw.motion === "boolean") data.motion = raw.motion;
      if (PRESETS.includes(raw.preset)) data.preset = raw.preset;
      if (ACCENTS.some((accent) => accent.id === raw.accent)) data.accent = raw.accent;
    } catch (err) { /* ignore */ }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      notify("Wallpaper is too large to store");
    }
  }

  /* Applied as soon as this file runs in <head>, before first paint. */
  function applyRoot() {
    const hasImage = !!data.image;
    root.dataset.wp = data.preset;
    root.dataset.accent = data.accent;
    root.classList.toggle("wp-image", hasImage);
    root.classList.toggle("wp-static", !data.motion);
    root.style.setProperty("--wallpaper-image", hasImage ? `url("${data.image}")` : "none");
  }

  function apply() {
    applyRoot();
    if (!document.body) return;
    const hasImage = !!data.image;

    const motion = document.getElementById("chk-motion");
    if (motion) motion.checked = data.motion;

    document.querySelectorAll(".wallpaper-swatch").forEach((swatch) => {
      swatch.classList.toggle("active", !hasImage && swatch.dataset.preset === data.preset);
    });

    document.querySelectorAll(".accent-swatch").forEach((swatch) => {
      swatch.classList.toggle("active", swatch.dataset.accent === data.accent);
    });

    const clear = document.getElementById("btn-wallpaper-clear");
    if (clear) clear.disabled = !hasImage;

    const choose = document.getElementById("btn-wallpaper-file");
    if (choose) choose.textContent = hasImage ? "Replace Image" : "Choose Image";

    const status = document.getElementById("wallpaper-status");
    if (status) {
      status.textContent = hasImage
        ? "Custom image in use. It stays in this browser."
        : "Using the built-in backdrop.";
    }
  }

  function readFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) return notify("Choose an image file");
    if (file.size > 15 * 1024 * 1024) return notify("Image is larger than 15 MB");

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1920;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return notify("Could not process that image");
        ctx.drawImage(img, 0, 0, width, height);
        try {
          data.image = canvas.toDataURL("image/jpeg", 0.82);
        } catch (err) {
          return notify("Could not process that image");
        }
        apply();
        save();
        notify("Wallpaper updated");
      };
      img.onerror = () => notify("Could not decode that image");
      img.src = String(reader.result);
    };
    reader.onerror = () => notify("Could not read that file");
    reader.readAsDataURL(file);
  }

  /* Wires the controls inside the TK Appearance tab or the shared dialog. */
  function wireControls(root) {
    const motion = root.querySelector("#chk-motion");
    if (motion) {
      motion.addEventListener("change", (event) => {
        data.motion = event.target.checked;
        apply();
        save();
      });
    }

    const fileInput = root.querySelector("#inp-wallpaper-file");
    const choose = root.querySelector("#btn-wallpaper-file");
    if (choose && fileInput) {
      choose.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", (event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = "";
        readFile(file);
      });
    }

    const clear = root.querySelector("#btn-wallpaper-clear");
    if (clear) {
      clear.addEventListener("click", () => {
        data.image = "";
        apply();
        save();
        notify("Wallpaper removed");
      });
    }
  }

  function accentSwatches() {
    return ACCENTS.map((accent) => `
      <button class="accent-swatch" data-accent="${accent.id}" type="button"
              style="--swatch:${accent.color}" title="${accent.label}"
              aria-label="${accent.label}"></button>`).join("");
  }

  function wallpaperSwatches() {
    return PRESETS.map((preset) => `
      <button class="wallpaper-swatch" data-preset="${preset}" type="button">
        <span class="wallpaper-preview"></span>${PRESET_LABELS[preset]}
      </button>`).join("");
  }

  function buildModal() {
    const el = document.createElement("div");
    el.className = "appearance-modal";
    el.hidden = true;
    el.innerHTML = `
      <div class="appearance-card" role="dialog" aria-modal="true" aria-label="Appearance">
        <div class="appearance-head">
          <div class="appearance-title">Appearance</div>
          <button class="appearance-close" type="button" aria-label="Close">&times;</button>
        </div>

        <div class="appearance-section">
          <div class="appearance-label">Accent color</div>
          <div class="accent-grid">${accentSwatches()}</div>
        </div>

        <div class="appearance-section">
          <div class="appearance-label">Background</div>
          <div class="wallpaper-grid">${wallpaperSwatches()}</div>

          <div class="form-row">
            <div class="form-info">
              <div class="form-label">Animate backdrop</div>
              <div class="form-hint">Slow drift of the colours or the wallpaper.</div>
            </div>
            <label class="toggle"><input type="checkbox" id="chk-motion" checked><span class="slider"></span></label>
          </div>

          <div class="form-row">
            <div class="form-info">
              <div class="form-label">Custom image</div>
              <div class="form-hint" id="wallpaper-status">Using the built-in backdrop.</div>
            </div>
            <div class="wallpaper-actions">
              <input type="file" id="inp-wallpaper-file" accept="image/*" hidden>
              <button class="btn-ghost" id="btn-wallpaper-file" type="button">Choose Image</button>
              <button class="btn-ghost" id="btn-wallpaper-clear" type="button">Remove</button>
            </div>
          </div>
        </div>
      </div>`;

    document.body.appendChild(el);
    el.addEventListener("click", (event) => {
      if (event.target === el) closeAppearance();
    });
    el.querySelector(".appearance-close").addEventListener("click", closeAppearance);
    wireControls(el);
    return el;
  }

  function openAppearance() {
    if (!modal) modal = buildModal();
    apply();
    modal.hidden = false;
  }

  function closeAppearance() {
    if (modal) modal.hidden = true;
  }

  /* Studios without a dedicated Appearance tab get a footer link instead. */
  function addStudioTrigger() {
    if (document.getElementById("tab-appearance")) return;
    const footer = document.querySelector("#sidebar .sidebar-footer");
    if (!footer || footer.querySelector("[data-open-appearance]")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "advanced-link";
    button.dataset.openAppearance = "";
    button.textContent = "Appearance";
    footer.appendChild(button);
  }

  window.ChesHubTheme = { data, load, save, apply, readFile, openAppearance };

  /* No-flash bootstrap: the head script runs before the stylesheets paint. */
  load();
  applyRoot();

  function guardBrowser() {
    if (navigator.hid || navigator.serial) return;
    if (document.getElementById("support-gate")) return;

    const gate = document.createElement("div");
    gate.id = "support-gate";
    gate.className = "support-gate";
    gate.innerHTML = `
      <div class="support-card">
        <div class="support-title">Browser not supported</div>
        <p class="support-text">ChesHub talks to peripherals through WebHID and Web Serial. Open this page in Chrome or Edge on desktop to continue.</p>
        <a class="btn-primary" href="https://www.google.com/chrome/" target="_blank" rel="noopener noreferrer">Get Chrome</a>
      </div>`;
    document.body.appendChild(gate);
  }

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-open-appearance]");
    if (trigger) {
      event.preventDefault();
      openAppearance();
      return;
    }

    const accent = event.target.closest(".accent-swatch");
    if (accent) {
      data.accent = accent.dataset.accent || "azure";
      apply();
      save();
      return;
    }

    const wallpaper = event.target.closest(".wallpaper-swatch");
    if (wallpaper) {
      data.preset = wallpaper.dataset.preset || "aurora";
      data.image = "";
      apply();
      save();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal && !modal.hidden) closeAppearance();
  });

  document.addEventListener("DOMContentLoaded", () => {
    apply();
    guardBrowser();
    wireControls(document);
    addStudioTrigger();
  });
})();
