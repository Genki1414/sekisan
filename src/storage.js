// localStorage-backed shim matching the { get(key) -> {value}|null, set(key, value) } shape
export const storage = {
  async get(key) {
    try {
      const value = window.localStorage.getItem(key);
      return value == null ? null : { value };
    } catch {
      return null;
    }
  },
  async set(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  },
};
