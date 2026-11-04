/* Shared backdrop preferences: animated ambient or a custom wallpaper.
   Stored once per origin so the hub and every studio share the same look. */

(function () {
  const STORAGE_KEY = "cheshub.wallpaper";
  const data = { image: "", motion: true };

  function notify(message) {
    if (typeof window.showToast === "function") window.showToast(message);
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (raw && typeof raw.image === "string") data.image = raw.image;
      if (raw && typeof raw.motion === "boolean") data.motion = raw.motion;
    } catch (err) { /* ignore */ }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      notify("Wallpaper is too large to store");
    }
  }

  function apply() {
    const hasImage = !!data.image;
    document.body.classList.toggle("wp-image", hasImage);
    document.body.classList.toggle("wp-static", !data.motion);

    const layer = document.getElementById("wallpaper");
    if (layer) layer.style.backgroundImage = hasImage ? `url("${data.image}")` : "";

    const motion = document.getElementById("chk-motion");
    if (motion) motion.checked = data.motion;

    const clear = document.getElementById("btn-wallpaper-clear");
    if (clear) clear.disabled = !hasImage;

    const choose = document.getElementById("btn-wallpaper-file");
    if (choose) choose.textContent = hasImage ? "Replace Image" : "Choose Image";

    const status = document.getElementById("wallpaper-status");
    if (status) {
      status.textContent = hasImage
        ? "Custom image in use. It stays in this browser."
        : "Using the animated backdrop.";
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

  window.ChesHubTheme = { data, load, save, apply, readFile };

  document.addEventListener("DOMContentLoaded", () => {
    load();
    apply();

    const motion = document.getElementById("chk-motion");
    if (motion) {
      motion.addEventListener("change", (event) => {
        data.motion = event.target.checked;
        apply();
        save();
      });
    }

    const fileInput = document.getElementById("inp-wallpaper-file");
    const choose = document.getElementById("btn-wallpaper-file");
    if (choose && fileInput) {
      choose.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", (event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = "";
        readFile(file);
      });
    }

    const clear = document.getElementById("btn-wallpaper-clear");
    if (clear) {
      clear.addEventListener("click", () => {
        data.image = "";
        apply();
        save();
        notify("Wallpaper removed");
      });
    }
  });
})();
