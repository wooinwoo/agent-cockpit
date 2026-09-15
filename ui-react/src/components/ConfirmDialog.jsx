// window.confirm 대체용 경량 확인 다이얼로그.
// App 설정의 "서버 재시작" 확인에 사용 중이며,
// 각 뷰의 window.confirm 호출을 점진적으로 대체할 수 있다.
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '확인',
  cancelLabel = '취소',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}) {
  if (!open) return null;
  return (
    <div
      role="presentation"
      onClick={() => {
        if (!busy) onCancel?.();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 60,
        padding: 16,
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-1)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 16,
          minWidth: 280,
          maxWidth: 420,
          display: 'grid',
          gap: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: '1rem' }}>{title}</h3>
        {message && (
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-2)' }}>{message}</p>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" autoFocus onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={
              danger
                ? { borderColor: 'var(--red)', color: 'var(--red)' }
                : { borderColor: 'var(--accent)' }
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
