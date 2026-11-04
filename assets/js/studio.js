/* Shared studio shell: device switcher and connection lock. */

(function () {
  const ICONS = {
    mouse: '<rect x="7" y="2" width="10" height="20" rx="5"/><path d="M12 6v4"/>',
    headset: '<path d="M4 14v-2a8 8 0 0116 0v2"/><rect x="2" y="13" width="4" height="7" rx="2"/><rect x="18" y="13" width="4" height="7" rx="2"/>'
  };

  let connected = false;

  function buildDeviceList() {
    const list = document.getElementById("device-list");
    const devices = window.CHESHUB_DEVICES || [];
    const current = document.body.dataset.device || "";
    if (!list || !devices.length) return;

    list.innerHTML = devices.map((device) => `
      <a class="nav-item${device.id === current ? " current" : ""}" href="../../${device.path}">
        <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[device.kind] || ICONS.mouse}</svg>
        <span>${device.short || device.name}</span>
      </a>`).join("");
  }

  function switchTab(tabId) {
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.remove("active"));
    const target = document.getElementById(tabId);
    if (target) target.classList.add("active");

    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    const nav = document.getElementById("nav-" + tabId);
    if (nav) nav.classList.add("active");

    refreshLock();
    document.dispatchEvent(new CustomEvent("cheshub:tabchange", { detail: { tabId } }));
  }

  /* Diagnostics and Appearance stay usable while offline, so the lock skips
     them. Every studio calls setConnected() from its own telemetry handler. */
  function refreshLock() {
    const overlay = document.getElementById("lock-overlay");
    if (!overlay) return;
    const exempt = ["tab-diagnostics", "tab-appearance"].some((id) => {
      const panel = document.getElementById(id);
      return panel && panel.classList.contains("active");
    });
    const show = !connected && !exempt;
    overlay.hidden = !show;

    const connect = document.getElementById("btn-connect");
    if (connect) connect.hidden = show;

    const sync = document.getElementById("btn-sync");
    if (sync) sync.disabled = !connected;
  }

  function setConnected(value) {
    connected = !!value;
    refreshLock();
  }

  window.ChesHub = { buildDeviceList, refreshLock, setConnected, switchTab };
  window.switchTab = switchTab;

  document.addEventListener("DOMContentLoaded", () => {
    buildDeviceList();
    refreshLock();
  });
})();
