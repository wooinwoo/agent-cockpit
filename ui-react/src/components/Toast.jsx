import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import './Toast.css';

// 토스트 인프라. App.jsx의 <ToastProvider>가 상태를 들고,
// <Toasts/> 호스트가 루트에 렌더링된다.
// 각 뷰는 `const toast = useToast()` 후
// toast.info/success/error(message)로 피드백을 띄울 수 있다.
const ToastContext = createContext(null);

let toastSeq = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    const tm = timers.current.get(id);
    if (tm) {
      clearTimeout(tm);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message, type = 'info', duration = 3000) => {
      const id = toastSeq++;
      setToasts((prev) => [...prev.slice(-4), { id, message: String(message), type }]);
      if (duration > 0) {
        timers.current.set(id, setTimeout(() => dismiss(id), duration));
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo(
    () => ({
      toasts,
      push,
      dismiss,
      info: (msg, duration) => push(msg, 'info', duration),
      success: (msg, duration) => push(msg, 'success', duration),
      error: (msg, duration) => push(msg, 'error', duration),
    }),
    [toasts, push, dismiss],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

export function Toasts() {
  const ctx = useContext(ToastContext);
  if (!ctx) return null;
  return (
    <div className="toast-host toast-container" role="status" aria-live="polite">
      {ctx.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>
          <span className="toast-msg">{t.message}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="알림 닫기"
            onClick={() => ctx.dismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default ToastProvider;
