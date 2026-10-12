const SESSION_KEY = "stud_session_id";

const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const generateSessionId = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CHARSET[b % CHARSET.length]).join("");
};

export const getSessionId = (): string => {
  const stored = localStorage.getItem(SESSION_KEY);
  if (stored && /^[A-Z0-9]{8}$/.test(stored)) return stored;
  const id = generateSessionId();
  localStorage.setItem(SESSION_KEY, id);
  return id;
};

export const setSessionId = (id: string): void => {
  localStorage.setItem(SESSION_KEY, id.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12));
};

export const regenerateSessionId = (): string => {
  const id = generateSessionId();
  localStorage.setItem(SESSION_KEY, id);
  return id;
};
