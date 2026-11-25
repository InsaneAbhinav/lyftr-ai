import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteSession, getHealth, getSessions,
  getSessionMessages, login, register, sendChat,
} from "./api.js";

function createSessionId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function timeAgo(isoStr) {
  if (!isoStr) return "";
  const diff = (Date.now() - new Date(isoStr)) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const QUICK_PROMPTS = [
  "What is LLM response caching and why does it matter?",
  "Explain API failover in simple terms.",
  "Write a short poem about artificial intelligence.",
];

const FAILURE_PRESETS = [
  { label: "None", value: "" },
  { label: "Fail Key 1", value: "key_1=429" },
  { label: "Fail All", value: "*=429" },
];

function LyftrLogo({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <rect width="40" height="40" rx="10" fill="url(#lg)" />
      <path d="M12 28L20 12L28 28" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 23H25" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366f1" /><stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const fn = mode === "login" ? login : register;
      const data = await fn(email.trim(), password);
      onAuth(data.token, data.email);
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={A.root}>
      <div style={A.glow} />
      <div style={A.card}>
        <div style={A.logoWrap}><LyftrLogo size={48} /></div>
        <h1 style={A.title}>Lyftr <span style={A.titleAI}>AI</span></h1>
        <p style={A.subtitle}>Intelligent Chat Gateway</p>
        <div style={A.tabs}>
          <button style={{ ...A.tab, ...(mode === "login" ? A.tabActive : {}) }}
            onClick={() => { setMode("login"); setError(""); }}>Sign In</button>
          <button style={{ ...A.tab, ...(mode === "register" ? A.tabActive : {}) }}
            onClick={() => { setMode("register"); setError(""); }}>Sign Up</button>
        </div>
        <form onSubmit={handleSubmit} style={A.form}>
          <div style={A.field}>
            <label style={A.label}>Email</label>
            <input style={A.input} type="email" placeholder="you@example.com"
              value={email} onChange={e => setEmail(e.target.value)}
              autoFocus required />
          </div>
          <div style={A.field}>
            <label style={A.label}>Password</label>
            <input style={A.input} type="password" placeholder="••••••••"
              value={password} onChange={e => setPassword(e.target.value)}
              required minLength={6} />
          </div>
          {error && <div style={A.error}>{error}</div>}
          <button style={{ ...A.submitBtn, ...(loading ? A.submitDisabled : {}) }}
            type="submit" disabled={loading}>
            {loading ? "Please wait…" : mode === "login" ? "Sign In" : "Create Account"}
          </button>
        </form>
        <p style={A.switchText}>
          {mode === "login" ? "Don't have an account? " : "Already have an account? "}
          <button style={A.switchBtn}
            onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
            {mode === "login" ? "Sign Up" : "Sign In"}
          </button>
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem("lyftr_token") || "");
  const [email, setEmail] = useState(() => localStorage.getItem("lyftr_email") || "");
  const [sessionId, setSessionId] = useState(() => createSessionId());
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [simulateFailure, setSimulateFailure] = useState("");
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessions, setSessions] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const bottomRef = useRef(null);

  const handleAuth = (tok, uname) => {
    localStorage.setItem("lyftr_token", tok);
    localStorage.setItem("lyftr_email", uname);
    setToken(tok);
    setEmail(uname);
  };

  const handleLogout = () => {
    localStorage.removeItem("lyftr_token");
    localStorage.removeItem("lyftr_email");
    setToken(""); setEmail(""); setMessages([]); setSessions([]);
  };

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
  }, []);

  const refreshSessions = useCallback(() => {
    if (!token) return;
    getSessions(token).then(d => {
      const list = d.sessions || [];
      const seen = new Set();
      setSessions(list.filter(s => {
        if (seen.has(s.session_id)) return false;
        seen.add(s.session_id); return true;
      }));
    }).catch(() => {});
  }, [token]);

  useEffect(() => { if (token) refreshSessions(); }, [token, refreshSessions]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const stats = useMemo(() => {
    let assistantCount = 0, cacheHits = 0, totalTokens = 0;
    for (const m of messages) {
      if (m.role === "assistant" && m.metadata) {
        assistantCount++;
        if (m.metadata.resolution_source === "LLM_CACHE") cacheHits++;
        totalTokens += (m.metadata.input_tokens || 0) + (m.metadata.output_tokens || 0);
      }
    }
    return { assistantCount, cacheHits, totalTokens, hitRate: assistantCount ? Math.round((cacheHits / assistantCount) * 100) : 0 };
  }, [messages]);

  const handleNewSession = () => { setSessionId(createSessionId()); setMessages([]); };

  const loadSession = async (sid) => {
    if (sid === sessionId && messages.length > 0) return;
    setLoadingHistory(true);
    try {
      const data = await getSessionMessages(sid, token);
      setSessionId(sid);
      setMessages((data.messages || []).map((m, i) => ({
        id: `loaded-${i}-${m.role}`, role: m.role, content: m.content, metadata: m.metadata || null,
      })));
    } catch { setSessionId(sid); setMessages([]); }
    finally { setLoadingHistory(false); }
  };

  const handleDeleteSession = async (sid) => {
    try {
      await deleteSession(sid, token);
      setSessions(prev => prev.filter(s => s.session_id !== sid));
      if (sid === sessionId) { setSessionId(createSessionId()); setMessages([]); }
    } catch { /* ignore */ }
    setDeleteConfirm(null);
  };

  const submitMessage = async (textToSend) => {
    const trimmed = textToSend.trim();
    if (!trimmed || loading) return;
    setMessages(prev => [...prev, { id: `${Date.now()}-user`, role: "user", content: trimmed }]);
    setInput("");
    setLoading(true);
    try {
      const data = await sendChat({ sessionId, message: trimmed, systemPrompt, simulateFailure, token });
      setMessages(prev => [...prev, {
        id: `${Date.now()}-assistant`, role: "assistant", content: data.reply, metadata: data.metadata,
      }]);
      refreshSessions();
    } catch (err) {
      setMessages(prev => [...prev, {
        id: `${Date.now()}-error`, role: "error", content: err.message || "An unexpected error occurred.",
      }]);
    } finally { setLoading(false); }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitMessage(input); }
  };

  if (!token) return <AuthScreen onAuth={handleAuth} />;

  const isOnline = health !== null;

  return (
    <div style={S.root}>
      <div style={S.glow1} /><div style={S.glow2} />

      {deleteConfirm && (
        <div style={S.modalOverlay}>
          <div style={S.modal}>
            <div style={S.modalTitle}>Delete conversation?</div>
            <div style={S.modalText}>This cannot be undone.</div>
            <div style={S.modalBtns}>
              <button style={S.modalCancel} onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button style={S.modalConfirm} onClick={() => handleDeleteSession(deleteConfirm)}>Delete</button>
            </div>
          </div>
        </div>
      )}

      <aside style={{ ...S.sidebar, ...(sidebarOpen ? {} : S.sidebarClosed) }}>
        <div style={S.sidebarHeader}>
          <div style={S.sidebarBrand}>
            <LyftrLogo size={28} />
            {sidebarOpen && <span style={S.sidebarBrandName}>Lyftr <span style={S.brandAI}>AI</span></span>}
          </div>
          <button style={S.collapseBtn} onClick={() => setSidebarOpen(v => !v)}>
            {sidebarOpen ? "◀" : "▶"}
          </button>
        </div>

        <button style={S.newChatBtn} onClick={handleNewSession}>
          {sidebarOpen ? <><span style={S.newChatIcon}>＋</span>New Chat</> : "＋"}
        </button>

        {sidebarOpen && (
          <>
            <div style={S.sessionsList}>
              <div style={S.sessionsLabel}>Recent Chats</div>
              {sessions.length === 0 && <div style={S.noSessions}>No conversations yet</div>}
              {sessions.map(s => {
                const isActive = s.session_id === sessionId;
                return (
                  <div key={s.session_id} style={{ ...S.sessionItem, ...(isActive ? S.sessionItemActive : {}) }}>
                    <button style={S.sessionBtn} onClick={() => loadSession(s.session_id)}>
                      <div style={S.sessionPreview}>{s.preview || "New conversation"}</div>
                      <div style={S.sessionMeta}>
                        <span style={S.sessionTime}>{timeAgo(s.last_at)}</span>
                        <span style={S.sessionCount}>{s.msg_count} turn{s.msg_count !== 1 ? "s" : ""}</span>
                      </div>
                    </button>
                    <button style={S.deleteBtn} onClick={e => { e.stopPropagation(); setDeleteConfirm(s.session_id); }} title="Delete">
                      🗑
                    </button>
                  </div>
                );
              })}
            </div>

            <div style={S.sidebarFooter}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: isOnline ? "#10b981" : "#ef4444", flexShrink: 0 }} />
              <span style={S.sidebarStatus}>{isOnline ? `${health.keys_configured} keys · cache on` : "offline"}</span>
              <div style={{ flex: 1 }} />
              <div style={S.userChip}>
                <div style={S.userAvatar}>{email[0]?.toUpperCase()}</div>
                <span style={S.userName}>{email}</span>
                <button style={S.logoutBtn} onClick={handleLogout} title="Sign out">↩</button>
              </div>
            </div>
          </>
        )}
      </aside>

      <div style={S.main}>
        <header style={S.header}>
          <div style={S.headerLeft}>
            <div style={S.sessionChip}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: isOnline ? "#10b981" : "#ef4444", flexShrink: 0 }} />
              <span style={S.sessionLabel}>{sessionId.slice(0, 8)}…{sessionId.slice(-4)}</span>
            </div>
            {stats.assistantCount > 0 && (
              <span style={S.pill}>⚡ {stats.hitRate}% cached · {stats.totalTokens} tok</span>
            )}
          </div>
          <div style={S.headerRight}>
            <button style={S.iconBtn} onClick={() => setShowSettings(v => !v)} title="Settings">⚙</button>
          </div>
        </header>

        {showSettings && (
          <div style={S.settingsPanel}>
            <div style={S.settingGroup}>
              <label style={S.settingLabel}>System Prompt</label>
              <input data-testid="system-prompt-input" style={S.settingInput}
                placeholder="e.g. You are a helpful assistant."
                value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} />
            </div>
            <div style={S.settingGroup}>
              <label style={S.settingLabel}>Simulate Failure</label>
              <div style={S.failureRow}>
                {FAILURE_PRESETS.map(p => (
                  <button key={p.label}
                    style={{ ...S.failureChip, ...(simulateFailure === p.value ? S.failureChipActive : {}) }}
                    onClick={() => setSimulateFailure(p.value)}>{p.label}</button>
                ))}
                <input style={{ ...S.settingInput, flex: 1, fontFamily: "monospace" }}
                  placeholder="key_1=429" value={simulateFailure}
                  onChange={e => setSimulateFailure(e.target.value)} />
              </div>
            </div>
          </div>
        )}

        <main style={S.messages}>
          {loadingHistory && <div style={S.historyLoading}>Loading conversation…</div>}

          {!loadingHistory && messages.length === 0 && (
            <div style={S.empty}>
              <div style={S.emptyLogo}><LyftrLogo size={52} /></div>
              <h2 style={S.emptyHeading}>How can I help you today?</h2>
              <p style={S.emptySubtext}>Multi-provider AI with automatic failover and response caching.</p>
              <div style={S.chips}>
                {QUICK_PROMPTS.map(p => (
                  <button key={p} style={S.chip} onClick={() => submitMessage(p)}>{p}</button>
                ))}
              </div>
            </div>
          )}

          {!loadingHistory && messages.map((msg, idx) => {
            if (msg.role === "user") return (
              <div key={msg.id} className="msg-enter" style={S.userRow}>
                <div style={S.userBubble}>{msg.content}</div>
              </div>
            );
            if (msg.role === "error") return (
              <div key={msg.id} className="msg-enter" style={S.errorRow} role="alert">
                <div style={S.errorIcon}>!</div>
                <div>
                  <div style={S.errorTitle}>Request Failed</div>
                  <div style={S.errorMsg}>{msg.content}</div>
                </div>
              </div>
            );
            const meta = msg.metadata || {};
            const isCache = meta.resolution_source === "LLM_CACHE";
            const prev = messages[idx - 1];
            const showAvatar = !prev || prev.role !== "assistant";
            return (
              <div key={msg.id} className="msg-enter" style={S.aiRow}>
                <div style={{ ...S.aiAvatar, opacity: showAvatar ? 1 : 0 }}><LyftrLogo size={24} /></div>
                <div style={S.aiCard} data-testid="assistant-message">
                  <div style={S.aiText}>{msg.content}</div>
                  <div style={S.metaRow}>
                    <span data-testid="meta-source" style={isCache ? S.cacheTag : S.liveTag}>
                      {isCache ? "⚡ CACHED" : "● LIVE"}
                    </span>
                    <span data-testid="meta-model" style={S.metaTag}>{meta.model}</span>
                    <span data-testid="meta-latency" style={S.metaTag}>{meta.latency_ms} ms</span>
                    <span style={S.metaTag}>
                      ↑<strong data-testid="meta-input-tokens">{meta.input_tokens}</strong>
                      {" "}↓<strong data-testid="meta-output-tokens">{meta.output_tokens}</strong> tok
                    </span>
                    {meta.key_id && <span style={S.metaTag}>{meta.key_id}</span>}
                    {meta.fallback_attempts > 0 && (
                      <span style={{ ...S.metaTag, color: "#f59e0b" }}>
                        {meta.fallback_attempts} fallback{meta.fallback_attempts > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {loading && (
            <div className="msg-enter" style={S.aiRow}>
              <div style={S.aiAvatar}><LyftrLogo size={24} /></div>
              <div style={S.typingCard}>
                <span style={S.dot} className="dot-1" />
                <span style={S.dot} className="dot-2" />
                <span style={S.dot} className="dot-3" />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </main>

        <footer style={S.footer}>
          <div style={S.composerWrap}>
            <textarea data-testid="chat-input" style={S.textarea} rows={1}
              placeholder="Message Lyftr AI…" value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown} disabled={loading} />
            <button data-testid="send-button"
              style={{ ...S.sendBtn, ...(loading || !input.trim() ? S.sendDisabled : {}) }}
              onClick={() => submitMessage(input)} disabled={loading || !input.trim()}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <div style={S.footerNote}>Enter to send · Shift+Enter for new line · Lyftr AI</div>
        </footer>
      </div>
    </div>
  );
}

const A = {
  root: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, #060912 0%, #0d1424 60%, #060912 100%)", padding: "16px", position: "relative", overflow: "hidden" },
  glow: { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: "600px", height: "600px", background: "radial-gradient(circle, rgba(99,102,241,0.1) 0%, transparent 65%)", pointerEvents: "none", filter: "blur(60px)" },
  card: { position: "relative", width: "100%", maxWidth: "400px", backgroundColor: "rgba(10,14,26,0.92)", backdropFilter: "blur(20px)", border: "1px solid rgba(99,102,241,0.18)", borderRadius: "20px", padding: "36px 32px", boxShadow: "0 24px 60px rgba(0,0,0,0.6)", textAlign: "center" },
  logoWrap: { display: "inline-flex", marginBottom: "14px", filter: "drop-shadow(0 0 20px rgba(99,102,241,0.4))" },
  title: { margin: "0 0 4px", fontSize: "28px", fontWeight: 800, color: "#f8fafc", letterSpacing: "-0.03em" },
  titleAI: { background: "linear-gradient(135deg, #6366f1, #06b6d4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" },
  subtitle: { margin: "0 0 24px", fontSize: "13px", color: "#475569" },
  tabs: { display: "flex", backgroundColor: "rgba(30,41,59,0.5)", borderRadius: "10px", padding: "3px", marginBottom: "24px", border: "1px solid rgba(148,163,184,0.1)" },
  tab: { flex: 1, padding: "8px", borderRadius: "8px", border: "none", backgroundColor: "transparent", color: "#64748b", fontSize: "13px", fontWeight: 600, cursor: "pointer" },
  tabActive: { backgroundColor: "rgba(99,102,241,0.25)", color: "#a5b4fc" },
  form: { display: "flex", flexDirection: "column", gap: "14px", textAlign: "left" },
  field: { display: "flex", flexDirection: "column", gap: "5px" },
  label: { fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#475569" },
  input: { padding: "10px 12px", borderRadius: "9px", border: "1px solid rgba(148,163,184,0.15)", backgroundColor: "rgba(15,23,42,0.8)", color: "#f1f5f9", fontSize: "14px", outline: "none" },
  error: { padding: "9px 12px", borderRadius: "8px", fontSize: "13px", backgroundColor: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", color: "#fca5a5" },
  submitBtn: { marginTop: "4px", padding: "11px", borderRadius: "10px", border: "none", background: "linear-gradient(135deg, #6366f1 0%, #06b6d4 100%)", color: "#fff", fontSize: "14px", fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 16px rgba(99,102,241,0.4)" },
  submitDisabled: { opacity: 0.5, cursor: "not-allowed" },
  switchText: { marginTop: "18px", fontSize: "13px", color: "#475569" },
  switchBtn: { background: "none", border: "none", color: "#818cf8", fontSize: "13px", fontWeight: 600, cursor: "pointer" },
};

const S = {
  root: { display: "flex", height: "100vh", width: "100vw", overflow: "hidden", background: "linear-gradient(135deg, #060912 0%, #0d1424 60%, #060912 100%)", position: "relative", fontFamily: "'Inter', sans-serif" },
  glow1: { position: "fixed", top: "-180px", left: "25%", width: "600px", height: "500px", background: "radial-gradient(circle, rgba(99,102,241,0.1) 0%, transparent 70%)", pointerEvents: "none", filter: "blur(70px)", zIndex: 0 },
  glow2: { position: "fixed", bottom: "-120px", right: "15%", width: "500px", height: "400px", background: "radial-gradient(circle, rgba(6,182,212,0.07) 0%, transparent 70%)", pointerEvents: "none", filter: "blur(70px)", zIndex: 0 },
  modalOverlay: { position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 },
  modal: { backgroundColor: "rgba(13,20,36,0.98)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "14px", padding: "24px 28px", maxWidth: "320px", width: "100%", textAlign: "center", boxShadow: "0 20px 50px rgba(0,0,0,0.6)" },
  modalTitle: { fontSize: "16px", fontWeight: 700, color: "#f1f5f9", marginBottom: "6px" },
  modalText: { fontSize: "13px", color: "#64748b", marginBottom: "20px" },
  modalBtns: { display: "flex", gap: "10px", justifyContent: "center" },
  modalCancel: { padding: "8px 20px", borderRadius: "8px", border: "1px solid rgba(148,163,184,0.15)", backgroundColor: "rgba(30,41,59,0.6)", color: "#94a3b8", fontSize: "13px", fontWeight: 600, cursor: "pointer" },
  modalConfirm: { padding: "8px 20px", borderRadius: "8px", border: "none", backgroundColor: "#ef4444", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" },
  sidebar: { width: "260px", minWidth: "260px", display: "flex", flexDirection: "column", backgroundColor: "rgba(6,9,18,0.95)", borderRight: "1px solid rgba(99,102,241,0.1)", transition: "width 0.2s ease, min-width 0.2s ease", overflow: "hidden", zIndex: 10 },
  sidebarClosed: { width: "56px", minWidth: "56px" },
  sidebarHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 12px", borderBottom: "1px solid rgba(99,102,241,0.08)" },
  sidebarBrand: { display: "flex", alignItems: "center", gap: "8px", overflow: "hidden" },
  sidebarBrandName: { fontSize: "16px", fontWeight: 800, color: "#f8fafc", letterSpacing: "-0.03em", whiteSpace: "nowrap" },
  brandAI: { background: "linear-gradient(135deg, #6366f1, #06b6d4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" },
  collapseBtn: { background: "transparent", border: "none", color: "#475569", fontSize: "11px", cursor: "pointer", padding: "4px", flexShrink: 0 },
  newChatBtn: { margin: "10px 10px 4px", padding: "9px 12px", borderRadius: "9px", border: "1px solid rgba(99,102,241,0.3)", background: "linear-gradient(135deg, rgba(99,102,241,0.18), rgba(6,182,212,0.12))", color: "#a5b4fc", fontSize: "13px", fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap", overflow: "hidden" },
  newChatIcon: { fontSize: "16px", lineHeight: 1 },
  sessionsList: { flex: 1, overflowY: "auto", padding: "4px 6px" },
  sessionsLabel: { fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#334155", padding: "8px 6px 4px" },
  noSessions: { fontSize: "12px", color: "#334155", padding: "8px 6px", fontStyle: "italic" },
  sessionItem: { display: "flex", alignItems: "stretch", border: "1px solid transparent", borderRadius: "8px", marginBottom: "2px", overflow: "hidden" },
  sessionItemActive: { backgroundColor: "rgba(99,102,241,0.12)", borderColor: "rgba(99,102,241,0.25)" },
  sessionBtn: { flex: 1, textAlign: "left", background: "transparent", border: "none", padding: "8px 10px", cursor: "pointer", minWidth: 0 },
  sessionPreview: { fontSize: "12.5px", color: "#cbd5e1", lineHeight: 1.4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: "4px" },
  sessionMeta: { display: "flex", justifyContent: "space-between" },
  sessionTime: { fontSize: "10px", color: "#475569" },
  sessionCount: { fontSize: "10px", color: "#475569" },
  deleteBtn: { background: "transparent", border: "none", color: "#334155", fontSize: "12px", cursor: "pointer", padding: "0 8px", display: "flex", alignItems: "center", flexShrink: 0 },
  sidebarFooter: { padding: "10px 12px", borderTop: "1px solid rgba(99,102,241,0.08)", display: "flex", alignItems: "center", gap: "7px" },
  sidebarStatus: { fontSize: "11px", color: "#475569" },
  userChip: { display: "flex", alignItems: "center", gap: "5px" },
  userAvatar: { width: "22px", height: "22px", borderRadius: "6px", background: "linear-gradient(135deg, #6366f1, #06b6d4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: 700, color: "#fff", flexShrink: 0 },
  userName: { fontSize: "11px", color: "#64748b", maxWidth: "70px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  logoutBtn: { background: "transparent", border: "none", color: "#475569", fontSize: "13px", cursor: "pointer", padding: "2px" },
  main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative", zIndex: 1 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px", borderBottom: "1px solid rgba(148,163,184,0.07)", backgroundColor: "rgba(6,9,18,0.85)", flexWrap: "wrap", gap: "8px" },
  headerLeft: { display: "flex", alignItems: "center", gap: "8px" },
  headerRight: { display: "flex", alignItems: "center", gap: "8px" },
  sessionChip: { display: "inline-flex", alignItems: "center", gap: "6px", padding: "4px 10px", borderRadius: "999px", backgroundColor: "rgba(30,41,59,0.6)", border: "1px solid rgba(148,163,184,0.1)", fontSize: "11px", color: "#64748b", fontFamily: "monospace" },
  sessionLabel: { letterSpacing: "0.02em" },
  pill: { padding: "3px 9px", borderRadius: "999px", fontSize: "11px", color: "#6366f1", backgroundColor: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)", fontWeight: 500 },
  iconBtn: { width: "30px", height: "30px", borderRadius: "7px", border: "1px solid rgba(148,163,184,0.12)", backgroundColor: "rgba(30,41,59,0.5)", color: "#475569", fontSize: "14px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  settingsPanel: { padding: "10px 18px", borderBottom: "1px solid rgba(148,163,184,0.07)", backgroundColor: "rgba(10,14,26,0.6)", display: "flex", gap: "14px", flexWrap: "wrap" },
  settingGroup: { flex: 1, minWidth: "180px", display: "flex", flexDirection: "column", gap: "4px" },
  settingLabel: { fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#475569" },
  settingInput: { padding: "6px 9px", borderRadius: "7px", border: "1px solid rgba(148,163,184,0.1)", backgroundColor: "rgba(15,23,42,0.8)", color: "#e2e8f0", fontSize: "12.5px", outline: "none", width: "100%" },
  failureRow: { display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" },
  failureChip: { padding: "4px 9px", borderRadius: "6px", border: "1px solid rgba(148,163,184,0.12)", backgroundColor: "rgba(30,41,59,0.6)", color: "#64748b", fontSize: "11px", cursor: "pointer" },
  failureChipActive: { borderColor: "#ef4444", backgroundColor: "rgba(239,68,68,0.15)", color: "#fca5a5" },
  messages: { flex: 1, overflowY: "auto", padding: "24px 24px 16px", display: "flex", flexDirection: "column", gap: "18px" },
  historyLoading: { margin: "auto", color: "#475569", fontSize: "13px" },
  empty: { margin: "auto", textAlign: "center", maxWidth: "460px", padding: "24px 16px" },
  emptyLogo: { display: "inline-flex", marginBottom: "18px", filter: "drop-shadow(0 0 20px rgba(99,102,241,0.35))" },
  emptyHeading: { margin: "0 0 8px", fontSize: "22px", fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.03em" },
  emptySubtext: { margin: "0 0 22px", fontSize: "13.5px", color: "#475569", lineHeight: 1.6 },
  chips: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "7px" },
  chip: { padding: "8px 13px", borderRadius: "10px", border: "1px solid rgba(99,102,241,0.18)", backgroundColor: "rgba(99,102,241,0.07)", color: "#818cf8", fontSize: "12.5px", cursor: "pointer", textAlign: "left", lineHeight: 1.4 },
  userRow: { display: "flex", justifyContent: "flex-end" },
  userBubble: { maxWidth: "68%", padding: "11px 15px", borderRadius: "18px 18px 4px 18px", background: "linear-gradient(135deg, #4f46e5 0%, #0891b2 100%)", color: "#fff", fontSize: "14px", lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word", boxShadow: "0 4px 18px rgba(79,70,229,0.28)" },
  aiRow: { display: "flex", gap: "10px", alignItems: "flex-start" },
  aiAvatar: { width: "30px", height: "30px", flexShrink: 0, marginTop: "3px", filter: "drop-shadow(0 0 6px rgba(99,102,241,0.3))" },
  aiCard: { flex: 1, maxWidth: "calc(100% - 40px)", backgroundColor: "rgba(13,20,36,0.8)", border: "1px solid rgba(99,102,241,0.1)", borderRadius: "4px 18px 18px 18px", padding: "13px 15px", display: "flex", flexDirection: "column", gap: "10px", boxShadow: "0 2px 12px rgba(0,0,0,0.3)" },
  aiText: { fontSize: "14px", lineHeight: 1.72, color: "#e2e8f0", whiteSpace: "pre-wrap", wordBreak: "break-word" },
  metaRow: { display: "flex", flexWrap: "wrap", gap: "4px", paddingTop: "8px", borderTop: "1px solid rgba(148,163,184,0.06)" },
  cacheTag: { padding: "2px 7px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, backgroundColor: "rgba(16,185,129,0.1)", color: "#34d399", border: "1px solid rgba(16,185,129,0.2)" },
  liveTag: { padding: "2px 7px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, backgroundColor: "rgba(99,102,241,0.1)", color: "#818cf8", border: "1px solid rgba(99,102,241,0.2)" },
  metaTag: { padding: "2px 6px", borderRadius: "4px", fontSize: "10px", fontFamily: "monospace", color: "#475569", backgroundColor: "rgba(30,41,59,0.5)", border: "1px solid rgba(148,163,184,0.07)" },
  errorRow: { display: "flex", gap: "10px", alignItems: "flex-start", padding: "11px 13px", borderRadius: "11px", backgroundColor: "rgba(127,29,29,0.22)", border: "1px solid rgba(239,68,68,0.25)" },
  errorIcon: { width: "22px", height: "22px", borderRadius: "50%", backgroundColor: "rgba(239,68,68,0.25)", color: "#fca5a5", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: 700, flexShrink: 0 },
  errorTitle: { fontSize: "11px", fontWeight: 700, color: "#fca5a5", marginBottom: "2px" },
  errorMsg: { fontSize: "13px", color: "#fecaca", lineHeight: 1.5 },
  typingCard: { padding: "13px 16px", borderRadius: "4px 14px 14px 14px", backgroundColor: "rgba(13,20,36,0.8)", border: "1px solid rgba(99,102,241,0.1)", display: "flex", gap: "5px", alignItems: "center" },
  dot: { width: "7px", height: "7px", borderRadius: "50%", backgroundColor: "#6366f1", display: "inline-block" },
  footer: { padding: "10px 18px 14px", borderTop: "1px solid rgba(148,163,184,0.07)", backgroundColor: "rgba(6,9,18,0.9)" },
  composerWrap: { display: "flex", gap: "8px", alignItems: "flex-end", backgroundColor: "rgba(16,22,40,0.9)", border: "1px solid rgba(99,102,241,0.18)", borderRadius: "14px", padding: "9px 9px 9px 14px" },
  textarea: { flex: 1, resize: "none", border: "none", backgroundColor: "transparent", color: "#f1f5f9", fontSize: "14px", fontFamily: "inherit", lineHeight: 1.6, outline: "none", padding: "0", minHeight: "24px", maxHeight: "120px" },
  sendBtn: { width: "34px", height: "34px", borderRadius: "9px", border: "none", background: "linear-gradient(135deg, #6366f1 0%, #06b6d4 100%)", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 3px 12px rgba(99,102,241,0.4)" },
  sendDisabled: { opacity: 0.3, cursor: "not-allowed", boxShadow: "none" },
  footerNote: { marginTop: "6px", textAlign: "center", fontSize: "10px", color: "#1e293b", letterSpacing: "0.03em" },
};


