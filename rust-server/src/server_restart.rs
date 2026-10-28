use crate::{ai_transport::Cancel, App};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

pub struct Store {
    manager: Option<u32>,
    pending: AtomicBool,
    committed: AtomicBool,
    pub signal: Cancel,
}
impl Store {
    pub fn new(manager: Option<u32>) -> Self {
        Self {
            manager,
            pending: AtomicBool::new(false),
            committed: AtomicBool::new(false),
            signal: Cancel::default(),
        }
    }
    pub fn committed(&self) -> bool {
        self.committed.load(Ordering::Acquire)
    }
    fn require_manager(&self) -> Result<(), String> {
        let Some(manager) = self.manager else {
            return Err(
                "세션을 보존하며 재시작하려면 콕핏을 관리 실행기로 시작해야 합니다.".into(),
            );
        };
        #[cfg(target_os = "linux")]
        let connected = manager > 1 && unsafe { libc::getppid() } as u32 == manager;
        #[cfg(not(target_os = "linux"))]
        let connected = {
            let _ = manager;
            false
        };
        if !connected {
            return Err(
                "관리 실행기가 종료되어 재시작을 취소했습니다. 기존 서버를 유지합니다.".into(),
            );
        }
        Ok(())
    }
}

pub struct Prepared {
    app: Arc<App>,
    pub terminal_count: usize,
}
impl Drop for Prepared {
    fn drop(&mut self) {
        if !self.app.restart.committed() {
            self.app.restart.pending.store(false, Ordering::Release);
        }
    }
}

pub async fn prepare(app: Arc<App>) -> Result<Prepared, String> {
    app.restart.require_manager()?;
    if app.closing.load(Ordering::Acquire)
        || app
            .restart
            .pending
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
    {
        return Err("서버 재시작이 이미 진행 중입니다.".into());
    }
    let mut request = Prepared {
        app: app.clone(),
        terminal_count: 0,
    };
    request.terminal_count = tokio::task::spawn_blocking(move || {
        app.restart.require_manager()?;
        if app.closing.load(Ordering::Acquire) {
            return Err("서버 종료가 이미 진행 중입니다.".into());
        }
        if !app.dev_servers.snapshot().array().is_empty() {
            return Err("콕핏에서 실행한 개발 서버가 있어 재시작을 취소했습니다. 개발 서버 작업을 마친 뒤 다시 시도하세요.".into());
        }
        app.terminals.prepare_restart(false).map_err(|e| e.to_string())
    }).await.map_err(|_| "재시작 준비를 확인하지 못해 기존 서버를 유지합니다.")??;
    Ok(request)
}

impl Prepared {
    // HTTP calls this after preparing its response. Telegram calls it only
    // after the acknowledgement was delivered successfully.
    pub fn schedule(self) {
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if self.app.closing.load(Ordering::Acquire) {
                return;
            }
            if let Err(error) = self.app.dev_servers.reserve_restart() {
                eprintln!("Server restart cancelled: {error}");
                return;
            }
            let app = self.app.clone();
            let result = tokio::task::spawn_blocking(move || {
                app.restart.require_manager()?;
                app.terminals
                    .prepare_restart_checked(true, || {
                        app.restart.require_manager().map_err(std::io::Error::other)
                    })
                    .map_err(|e| e.to_string())
            })
            .await;
            if !matches!(result, Ok(Ok(_))) {
                if !self.app.closing.load(Ordering::Acquire) {
                    self.app.dev_servers.cancel_restart();
                }
                eprintln!("Server restart cancelled: final checkpoint was not confirmed");
                return;
            }
            self.app.restart.committed.store(true, Ordering::Release);
            self.app.restart.signal.cancel();
        });
    }
}
