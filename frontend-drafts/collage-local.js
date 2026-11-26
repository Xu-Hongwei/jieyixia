/* Standalone playground storage. Isolated from the product app and all APIs. */
(() => {
  const key = 'jxl-collage-playground-v1';
  let available = true;
  window.collageLocal = {
    load() {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (data.version !== 1 || !Array.isArray(data.tasks) || !Array.isArray(data.completed)) return null;
        if (!data.tasks.every(t => t && typeof t.id === 'string' && typeof t.title === 'string' && Array.isArray(t.requirements))) return null;
        return data;
      } catch { available = false; return null; }
    },
    save(tasks, completed) {
      try {
        localStorage.setItem(key, JSON.stringify({version: 1, tasks, completed: [...completed]}));
        available = true;
        return true;
      } catch { available = false; return false; }
    },
    get available() { return available; },
  };
})();
