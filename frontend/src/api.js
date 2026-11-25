const API_BASE = (import.meta.env.VITE_API_BASE || "http://localhost:8000").replace(/\/+$/, "");

function formatErrorDetail(detail, fallback) {
  if (!detail) return fallback;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map(item => {
      const loc = Array.isArray(item.loc) ? item.loc.join(".") : "";
      return loc ? `${loc}: ${item.msg}` : item.msg || JSON.stringify(item);
    }).join("; ");
  }
  return JSON.stringify(detail);
}

function authHeaders(token) {
  const h = { "Content-Type": "application/json" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

export async function register(email, password) {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(formatErrorDetail(data?.detail, `Registration failed (${res.status})`));
  return data;
}

export async function login(email, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(formatErrorDetail(data?.detail, `Login failed (${res.status})`));
  return data;
}

export async function sendChat({ sessionId, message, systemPrompt, simulateFailure, token }) {
  const headers = authHeaders(token);
  if (simulateFailure && simulateFailure.trim()) headers["X-Simulate-Failure"] = simulateFailure.trim();
  const body = { session_id: sessionId, message };
  if (systemPrompt && systemPrompt.trim()) body.system_prompt = systemPrompt.trim();
  const res = await fetch(`${API_BASE}/chat`, { method: "POST", headers, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error(formatErrorDetail(data?.detail, `Request failed with status ${res.status}`));
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function getSessions(token) {
  const res = await fetch(`${API_BASE}/sessions`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`Status ${res.status}`);
  return res.json();
}

export async function getSessionMessages(sessionId, token) {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/messages`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(formatErrorDetail(data?.detail, `Status ${res.status}`));
  }
  return res.json();
}

export async function deleteSession(sessionId, token) {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!res.ok && res.status !== 404) throw new Error(`Delete failed (${res.status})`);
}

export async function getHealth() {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error(`Health check failed (${res.status})`);
  return res.json();
}

