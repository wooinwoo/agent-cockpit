use super::*;
use crate::{board, board_value::V, process_inventory};
use std::collections::HashSet;
use std::sync::atomic::Ordering;

fn archives(state: &State) -> Vec<Value> {
    state.checkpoint["archivedTerminals"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize};

    #[derive(Debug, Clone)]
    struct RecordedKill {
        calls: Arc<AtomicUsize>,
        checkpoint: PathBuf,
    }
    impl ChildKiller for RecordedKill {
        fn kill(&mut self) -> io::Result<()> {
            let saved: Value = serde_json::from_slice(&fs::read(&self.checkpoint)?)?;
            assert_eq!(
                saved["terminals"],
                json!([]),
                "Removal must be durable before signalling"
            );
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    fn fixture(exited: bool) -> (tempfile::TempDir, Arc<Store>, Arc<Entry>, Arc<AtomicUsize>) {
        fixture_durable(exited, "")
    }
    fn fixture_durable(
        exited: bool,
        durable: &str,
    ) -> (tempfile::TempDir, Arc<Store>, Arc<Entry>, Arc<AtomicUsize>) {
        let directory = tempfile::tempdir().unwrap();
        let accounts = Arc::new(crate::accounts::Store::new(
            directory.path(),
            directory.path(),
        ));
        let store = Store::new(directory.path().to_path_buf(), accounts).unwrap();
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let (writer, _) = mpsc::sync_channel(1);
        let calls = Arc::new(AtomicUsize::new(0));
        let entry = Arc::new(Entry {
            id: "home-0123456789ab".into(),
            durable: durable.into(),
            pid: None,
            meta: Mutex::new(Meta {
                saved: json!({"termId":"home-0123456789ab","incarnation":"11111111111111111111111111111111","command":"jcode"}),
                conversation_dirty: false,
                replay: Replay::default(),
                output_count: 0,
                owner: None,
                agent: None,
            }),
            master: Mutex::new(pair.master),
            writer,
            control: Mutex::new(()),
            input_generation: AtomicU64::new(0),
            exited: AtomicBool::new(exited),
            killer: Mutex::new(Box::new(RecordedKill {
                calls: calls.clone(),
                checkpoint: directory.path().join("session-state.json"),
            })),
        });
        let mut state = store.state.lock().unwrap();
        state.restored = true;
        state.entries.push(entry.clone());
        store.checkpoint(&mut state).unwrap();
        drop(state);
        (directory, store, entry, calls)
    }

    #[test]
    fn legacy_close_fresh_snapshot_helper_payload_succeeds() {
        let (directory, store, entry, calls) = fixture(false);
        let board = board::Store::new(directory.path());
        let (initial, mut events) = store.snapshot();
        let connection = ConnectionClose::from_initial(&initial);
        let request = json!({"type":"kill","termId":entry.id,"confirm":true});
        let result = connection.kill(&store, &request, &board);
        let reply = kill_reply(&request, result);
        assert_eq!(
            reply["accepted"], true,
            "fresh read-only helper payload must close its original snapshot generation: {reply}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(store.find(&entry.id).is_none());
        assert_eq!(events.try_recv().unwrap()["type"], "closed");
        println!("LEGACY_FRESH_REPLY={reply}");
    }

    fn assert_legacy_refused_unchanged(
        store: &Store,
        connection: &ConnectionClose,
        request: &Value,
        board: &board::Store,
        directory: &Path,
        entry: &Arc<Entry>,
        calls: &AtomicUsize,
    ) {
        let checkpoint = directory.join("session-state.json");
        let reviews = directory.join(".cockpit-board.json");
        fs::write(&reviews, json!({"supervisors":[{"id":"keep-review","termId":entry.id,"status":"running","autoRecover":true}]}).to_string()).unwrap();
        let before = fs::read(&checkpoint).unwrap();
        let review_before = fs::read(&reviews).unwrap();
        let mut events = store.events.subscribe();
        assert!(
            connection.kill(store, request, board).is_err(),
            "must fail closed: {request}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0, "no signal on refusal");
        assert!(Arc::ptr_eq(&store.find(&entry.id).unwrap(), entry));
        assert_eq!(fs::read(&checkpoint).unwrap(), before);
        assert_eq!(fs::read(&reviews).unwrap(), review_before);
        assert!(events.try_recv().is_err(), "refusal cannot publish success");
    }

    #[test]
    fn legacy_close_explicit_malformed_or_stale_never_falls_back() {
        let (directory, store, entry, calls) = fixture(false);
        let board = board::Store::new(directory.path());
        let (initial, _) = store.snapshot();
        let connection = ConnectionClose::from_initial(&initial);
        for token in [
            Value::Null,
            json!(""),
            json!(false),
            json!(42),
            json!({}),
            json!([]),
            json!("0".repeat(32)),
            json!("A".repeat(32)),
        ] {
            assert_legacy_refused_unchanged(
                &store,
                &connection,
                &json!({"type":"kill","termId":entry.id,"confirm":true,"incarnation":token}),
                &board,
                directory.path(),
                &entry,
                &calls,
            );
        }
    }

    #[test]
    fn legacy_close_requires_exact_true_confirm_and_original_full_id() {
        let (directory, store, entry, calls) = fixture(false);
        entry.meta.lock().unwrap().saved["alias"] = json!("ai1");
        let board = board::Store::new(directory.path());
        let (initial, _) = store.snapshot();
        let connection = ConnectionClose::from_initial(&initial);
        let mut request = json!({"type":"kill","termId":entry.id});
        assert_legacy_refused_unchanged(
            &store,
            &connection,
            &request,
            &board,
            directory.path(),
            &entry,
            &calls,
        );
        for confirm in [
            Value::Null,
            json!(false),
            json!("true"),
            json!(1),
            json!({}),
        ] {
            request["confirm"] = confirm;
            assert_legacy_refused_unchanged(
                &store,
                &connection,
                &request,
                &board,
                directory.path(),
                &entry,
                &calls,
            );
        }
        for id in [
            json!("ai1"),
            json!("unknown-full-id"),
            json!(""),
            Value::Null,
            json!(42),
            json!({}),
        ] {
            assert_legacy_refused_unchanged(
                &store,
                &connection,
                &json!({"type":"kill","termId":id,"confirm":true}),
                &board,
                directory.path(),
                &entry,
                &calls,
            );
        }
        assert!(
            store
                .kill(&json!({"termId":entry.id,"confirm":true}), &board)
                .is_err(),
            "Store still requires explicit incarnation"
        );
    }

    #[test]
    fn legacy_close_conversation_held_refuses_original_generation() {
        let (directory, store, entry, calls) = fixture(false);
        let board = board::Store::new(directory.path());
        let (initial, _) = store.snapshot();
        let connection = ConnectionClose::from_initial(&initial);
        // Protection can change after the connection snapshot.
        entry.meta.lock().unwrap().saved["conversationHeld"] = json!(true);
        store.checkpoint(&mut store.state.lock().unwrap()).unwrap();
        assert_legacy_refused_unchanged(
            &store,
            &connection,
            &json!({"type":"kill","termId":entry.id,"confirm":true}),
            &board,
            directory.path(),
            &entry,
            &calls,
        );
    }

    #[test]
    fn legacy_close_versioned_valid_token_remains_supported_without_legacy_confirm() {
        let (directory, store, entry, calls) = fixture(false);
        let board = board::Store::new(directory.path());
        // Even an ID absent from the initial snapshot can use an explicit token.
        let connection = ConnectionClose::from_initial(&[]);
        connection.kill(&store, &json!({"type":"kill","termId":entry.id,"incarnation":"11111111111111111111111111111111","requestId":"versioned:1"}), &board).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn legacy_close_later_foreign_created_is_not_adopted() {
        let (directory, store, entry, calls) = fixture(false);
        let board = board::Store::new(directory.path());
        store.state.lock().unwrap().entries.clear();
        let (initial, mut events) = store.snapshot();
        assert!(initial.is_empty());
        let connection = ConnectionClose::from_initial(&initial);
        {
            let _gate = store.event_gate.lock().unwrap();
            store.state.lock().unwrap().entries.push(entry.clone());
            store.publish_created(&entry);
        }
        let created = events.try_recv().unwrap();
        assert_eq!(created["termId"], entry.id);
        assert_legacy_refused_unchanged(
            &store,
            &connection,
            &json!({"type":"kill","termId":created["termId"],"confirm":true}),
            &board,
            directory.path(),
            &entry,
            &calls,
        );
    }

    #[derive(Debug)]
    struct ForwardRecordedKill {
        inner: Box<dyn ChildKiller + Send + Sync>,
        calls: Arc<AtomicUsize>,
    }
    impl ChildKiller for ForwardRecordedKill {
        fn kill(&mut self) -> io::Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.inner.kill()
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(Self {
                inner: self.inner.clone_killer(),
                calls: self.calls.clone(),
            })
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn legacy_close_old_connection_rejects_same_id_resume_fresh_connection_closes() {
        tokio::task::spawn_blocking(|| {
            let (directory, mut store, entry, calls) = fixture(false);
            Arc::get_mut(&mut store).unwrap().shell = "/bin/cat".into();
            Arc::get_mut(&mut store).unwrap().durable = false;
            entry.meta.lock().unwrap().saved["cwd"] = json!(directory.path());
            entry.meta.lock().unwrap().saved["projectId"] = json!("__home__");
            let board = board::Store::new(directory.path());
            let (initial, _) = store.snapshot();
            let old_connection = ConnectionClose::from_initial(&initial);
            let old_intent = json!({"type":"kill","termId":entry.id,"confirm":true});
            old_connection.kill(&store, &old_intent, &board).unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            let resume = V::parse(&serde_json::value::to_raw_value(&json!({"action":"resume","termId":entry.id,"incarnation":initial[0]["incarnation"]})).unwrap()).unwrap();
            store.maintenance_request(true, &resume, &board).unwrap();
            let resumed = store.find(&entry.id).unwrap();
            let signals = Arc::new(AtomicUsize::new(0));
            {
                let mut killer = resumed.killer.lock().unwrap();
                *killer = Box::new(ForwardRecordedKill {inner:killer.clone_killer(),calls:signals.clone()});
            }
            let pid = resumed.pid.unwrap();
            assert_ne!(resumed.meta.lock().unwrap().saved["incarnation"], initial[0]["incarnation"]);
            assert_legacy_refused_unchanged(&store, &old_connection, &old_intent, &board, directory.path(), &resumed, &signals);
            assert!(Path::new(&format!("/proc/{pid}")).exists());
            assert!(!resumed.exited.load(Ordering::SeqCst));
            // A genuinely fresh helper connection may target the new generation.
            let (fresh_initial, _) = store.snapshot();
            let fresh_connection = ConnectionClose::from_initial(&fresh_initial);
            fresh_connection.kill(&store, &old_intent, &board).unwrap();
            assert_eq!(signals.load(Ordering::SeqCst), 1);
            assert!(store.find(&entry.id).is_none());
            println!("LEGACY_RESUME_BOUNDARY={}", json!({"initial":initial,"freshInitial":fresh_initial,"oldIntent":old_intent,"oldRefused":true,"signalsBeforeFreshClose":0,"freshCloseSignals":signals.load(Ordering::SeqCst)}));
        }).await.unwrap();
    }

    fn cat_store() -> (tempfile::TempDir, Arc<Store>) {
        let directory = tempfile::tempdir().unwrap();
        let accounts = Arc::new(crate::accounts::Store::new(
            directory.path(),
            directory.path(),
        ));
        let mut store = Store::new(directory.path().to_path_buf(), accounts).unwrap();
        Arc::get_mut(&mut store).unwrap().shell = "/bin/cat".into();
        Arc::get_mut(&mut store).unwrap().durable = false;
        store.state.lock().unwrap().restored = true;
        (directory, store)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn create_correlation_echoes_only_corresponding_fresh_created() {
        tokio::task::spawn_blocking(|| {
            let (directory, store) = cat_store();
            let projects = projects::Store::new(directory.path().to_path_buf()).unwrap();
            let board = board::Store::new(directory.path());
            let mut events = store.events.subscribe();
            let request = json!({"type":"create","projectId":"__home__","command":"","createRequestId":"switch:request_1-unique","unknownField":"must-not-reflect"});
            store.create(&projects, &board, &request, 7).unwrap();
            let created = std::iter::from_fn(|| events.try_recv().ok()).find(|v| v["type"] == "created").unwrap();
            let entry = store.find(value_text(&created,"termId")).unwrap();
            let saved = entry.meta.lock().unwrap().saved.clone();
            let checkpoint = fs::read_to_string(directory.path().join("session-state.json")).unwrap();
            // Release the isolated fixture even in RED.
            store.kill(&json!({"termId":entry.id,"incarnation":created["incarnation"]}), &board).unwrap();
            assert_eq!(created["createRequestId"], request["createRequestId"], "fresh create must echo its own bounded correlation only");
            assert!(created.get("unknownField").is_none());
            assert!(saved.get("createRequestId").is_none());
            assert!(!checkpoint.contains("createRequestId"));
            println!("CREATE_CORRELATION_BOUNDARY={created}");
        }).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn create_correlation_absent_invalid_and_distinct_requests_preserve_legacy_create() {
        tokio::task::spawn_blocking(|| {
            let (directory, store) = cat_store();
            let projects = projects::Store::new(directory.path().to_path_buf()).unwrap();
            let board = board::Store::new(directory.path());
            let values = [None, Some(Value::Null), Some(json!("")), Some(json!(42)), Some(json!({})), Some(json!([])), Some(json!(true)), Some(json!("한글")), Some(json!("bad\nvalue")), Some(json!("a".repeat(129))), Some(json!("a".repeat(128))), Some(json!("switch:other-2_unique"))];
            let mut ids = std::collections::HashSet::new();
            for (index, correlation) in values.into_iter().enumerate() {
                let mut events = store.events.subscribe();
                let mut request = json!({"type":"create","projectId":"__home__","command":"","unknownField":{"createRequestId":"not-authorized"}});
                if let Some(value) = correlation { request["createRequestId"] = value; }
                store.create(&projects, &board, &request, index as u64).unwrap();
                let created = std::iter::from_fn(|| events.try_recv().ok()).find(|v| v["type"] == "created").unwrap();
                let token = created["incarnation"].clone();
                let id = value_text(&created,"termId").to_owned();
                let saved = store.find(&id).unwrap().meta.lock().unwrap().saved.clone();
                let checkpoint = fs::read_to_string(directory.path().join("session-state.json")).unwrap();
                store.kill(&json!({"termId":id,"incarnation":token}), &board).unwrap();
                assert!(ids.insert(id), "separate requests create separate fresh IDs");
                if index >= 10 {
                    assert_eq!(created["createRequestId"], request["createRequestId"]);
                } else {
                    assert!(created.get("createRequestId").is_none(), "absent/invalid correlation cannot leak: {created}");
                }
                assert!(created.get("unknownField").is_none());
                assert!(saved.get("createRequestId").is_none());
                assert!(!checkpoint.contains("createRequestId"));
            }
        }).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn create_correlation_never_reused_for_same_id_resume_or_restore() {
        tokio::task::spawn_blocking(|| {
            let (directory, store) = cat_store();
            let projects = projects::Store::new(directory.path().to_path_buf()).unwrap();
            let board = board::Store::new(directory.path());
            let mut events = store.events.subscribe();
            store.create(&projects, &board, &json!({"type":"create","projectId":"__home__","command":"jcode","createRequestId":"switch:once"}), 3).unwrap();
            let first = std::iter::from_fn(|| events.try_recv().ok()).find(|v| v["type"] == "created").unwrap();
            store.kill(&json!({"termId":first["termId"],"incarnation":first["incarnation"]}), &board).unwrap();
            let resume = V::parse(&serde_json::value::to_raw_value(&json!({"action":"resume","termId":first["termId"],"incarnation":first["incarnation"],"createRequestId":"switch:spoof-resume"})).unwrap()).unwrap();
            store.maintenance_request(true, &resume, &board).unwrap();
            let resumed = std::iter::from_fn(|| events.try_recv().ok()).find(|v| v["type"] == "created").unwrap();
            assert_eq!(resumed["termId"], first["termId"]);
            assert!(resumed.get("createRequestId").is_none());
            let checkpoint = store.checkpoint_snapshot().unwrap();
            assert!(!checkpoint.to_string().contains("createRequestId"));
            store.kill(&json!({"termId":resumed["termId"],"incarnation":resumed["incarnation"]}), &board).unwrap();

            // Real restore path, isolated directory and /bin/cat only.
            let restored_directory = tempfile::tempdir().unwrap();
            fs::write(restored_directory.path().join("session-state.json"), checkpoint.to_string()).unwrap();
            let accounts = Arc::new(crate::accounts::Store::new(restored_directory.path(), restored_directory.path()));
            let mut restored_store = Store::new(restored_directory.path().to_path_buf(), accounts).unwrap();
            Arc::get_mut(&mut restored_store).unwrap().shell = "/bin/cat".into();
            Arc::get_mut(&mut restored_store).unwrap().durable = false;
            let restored_projects = projects::Store::new(restored_directory.path().to_path_buf()).unwrap();
            let restored_board = board::Store::new(restored_directory.path());
            let mut restored_events = restored_store.events.subscribe();
            restored_store.restore(&restored_projects, &restored_board).unwrap();
            let (active, _) = restored_store.snapshot();
            assert_eq!(active.len(), 1);
            restored_store.kill(&json!({"termId":active[0]["termId"],"incarnation":active[0]["incarnation"]}), &restored_board).unwrap();
            for event in std::iter::from_fn(|| restored_events.try_recv().ok()) {
                assert!(event.get("createRequestId").is_none());
            }
            assert!(active[0].get("createRequestId").is_none());
        }).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn create_correlation_failed_create_does_not_echo_success() {
        tokio::task::spawn_blocking(|| {
            let (directory, store) = cat_store();
            let projects = projects::Store::new(directory.path().to_path_buf()).unwrap();
            let board = board::Store::new(directory.path());
            let mut events = store.events.subscribe();
            assert!(store.create(&projects, &board, &json!({"type":"create","projectId":"unknown","createRequestId":"switch:failed"}), 5).is_err());
            assert!(events.try_recv().is_err());
            assert!(store.active().is_empty());
        }).await.unwrap();
    }

    #[test]
    fn close_contract_success_publishes_authoritative_close_and_keeps_history() {
        let (directory, store, entry, calls) = fixture(false);
        let mut events = store.events.subscribe();
        let board = board::Store::new(directory.path());
        let request = json!({"termId":entry.id,"incarnation":entry.meta.lock().unwrap().saved["incarnation"]});
        store.kill(&request, &board).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(store.find(&entry.id).is_none());
        let saved: Value =
            serde_json::from_slice(&fs::read(directory.path().join("session-state.json")).unwrap())
                .unwrap();
        assert_eq!(saved["terminals"], json!([]));
        assert_eq!(saved["archivedTerminals"][0]["saved"]["termId"], entry.id);
        let closed = events.try_recv().expect("successful existing close path must notify every client, not just the requesting socket");
        assert_eq!(closed["type"], "closed");
        assert_eq!(closed["termId"], entry.id);
        assert_eq!(closed["nativeCleanup"]["status"], "not_attempted");
        store.kill(&request, &board).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(
            events.try_recv().is_err(),
            "repeat close has no duplicate cleanup event"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn close_incarnation_shared_respawn_boundary_invalidates_old_close_even_on_uncertain_failure(
    ) {
        tokio::task::spawn_blocking(|| {
            let durable = format!("{:024x}", rand::random::<u128>() & ((1u128 << 96) - 1));
            let (directory, store, entry, calls) = fixture_durable(false, &durable);
            let board = board::Store::new(directory.path());
            let (initial, _) = store.snapshot();
            let connection = ConnectionClose::from_initial(&initial);
            let old = json!({"termId":entry.id,"incarnation":"11111111111111111111111111111111"});
            let mut events = store.events.subscribe();
            // A tmux client against an absent isolated socket: cannot start an
            // AI or a server. Both manual resume and supervisor recovery use it.
            assert!(store
                .tmux(
                    &durable,
                    &["respawn-pane", "-k", "-t", "main"],
                    None,
                    &entry.id
                )
                .is_err());
            assert!(
                store.kill(&old, &board).is_err(),
                "a pre-respawn close cannot authorize cleanup after any respawn attempt"
            );
            assert_ne!(
                entry.meta.lock().unwrap().saved["incarnation"],
                old["incarnation"]
            );
            let created = events.try_recv().unwrap();
            assert_eq!(created["type"], "created");
            assert!(
                created.get("createRequestId").is_none(),
                "respawn is not a correlated fresh create"
            );
            assert_legacy_refused_unchanged(
                &store,
                &connection,
                &json!({"type":"kill","termId":entry.id,"confirm":true}),
                &board,
                directory.path(),
                &entry,
                &calls,
            );
        })
        .await
        .unwrap();
    }

    #[test]
    fn close_incarnation_legacy_archive_is_bound_before_resume() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("session-state.json"), json!({"terminals":[],"archivedTerminals":[{"saved":{"termId":"legacy-full-id","command":"jcode"}}]}).to_string()).unwrap();
        let accounts = Arc::new(crate::accounts::Store::new(
            directory.path(),
            directory.path(),
        ));
        let store = Store::new(directory.path().to_path_buf(), accounts).unwrap();
        let saved = store.state.lock().unwrap().checkpoint["archivedTerminals"][0]["saved"].clone();
        assert_eq!(value_text(&saved, "incarnation").len(), 32, "legacy archived records must obtain a stable server-issued token, not become permanently unresumable");
        require_incarnation(&saved, value_text(&saved, "incarnation")).unwrap();
    }

    #[test]
    fn close_incarnation_invalid_tokens_preserve_every_boundary() {
        let (directory, store, entry, calls) = fixture(false);
        let board = board::Store::new(directory.path());
        let checkpoint = directory.path().join("session-state.json");
        let before = fs::read(&checkpoint).unwrap();
        let mut events = store.events.subscribe();
        for token in [
            Value::Null,
            json!(""),
            json!("legacy"),
            json!("0".repeat(32)),
            json!("A".repeat(32)),
            json!(42),
        ] {
            let request = json!({"type":"kill","termId":entry.id,"incarnation":token,"confirm":true,"requestId":"another-client"});
            assert!(store
                .kill(&request, &board)
                .unwrap_err()
                .to_string()
                .contains("incarnation"));
            for action in ["archive", "resume"] {
                let input = V::parse(
                    &serde_json::value::to_raw_value(
                        &json!({"action":action,"termId":entry.id,"incarnation":token}),
                    )
                    .unwrap(),
                )
                .unwrap();
                assert!(store
                    .maintenance_request(true, &input, &board)
                    .unwrap_err()
                    .to_string()
                    .contains("incarnation"));
            }
            assert!(Arc::ptr_eq(&store.find(&entry.id).unwrap(), &entry));
            assert_eq!(fs::read(&checkpoint).unwrap(), before);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert!(events.try_recv().is_err());
        }
        assert!(store.kill(&json!({"termId":entry.id}), &board).is_err());
        // An incarnation is shared by authorized clients, not tied to size owner.
        let request = json!({"type":"kill","termId":entry.id,"incarnation":"11111111111111111111111111111111","requestId":"client-b:valid"});
        store.kill(&request, &board).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            events.try_recv().unwrap()["incarnation"],
            request["incarnation"]
        );
    }

    // Synchronize the real snapshot at its copy/subscribe boundary.
    #[test]
    fn close_snapshot_boundary_never_loses_authoritative_closed() {
        let (directory, store, entry, calls) = fixture(false);
        let closing_store = store.clone();
        let id = entry.id.clone();
        let board = board::Store::new(directory.path());
        let (start_tx, start_rx) = mpsc::sync_channel(0);
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        let closer = std::thread::spawn(move || {
            start_rx.recv().unwrap();
            let result = closing_store.kill(
                &json!({"termId":id,"incarnation":"11111111111111111111111111111111"}),
                &board,
            );
            done_tx.send(()).unwrap();
            result.unwrap();
        });
        let (active, mut events) = store.snapshot_with_boundary(|| {
            start_tx.send(()).unwrap();
            // Before the fix close completes *inside* this exact gap. With the
            // shared gate it must wait until this snapshot subscribes.
            let completed_in_gap = done_rx.recv_timeout(Duration::from_secs(1)).is_ok();
            println!("close completed between active copy and subscribe: {completed_in_gap}");
        });
        closer.join().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(active.iter().any(|v| v["termId"] == entry.id));
        let closed = events
            .try_recv()
            .expect("copied active terminal MUST have a matching closed event after subscribe");
        assert_eq!(closed["type"], "closed");
        assert_eq!(closed["termId"], entry.id);
        let (after, mut after_events) = store.snapshot();
        assert!(after.is_empty());
        assert!(after_events.try_recv().is_err());
    }

    // RED seam: the same full ID is reopened by the real maintenance/spawn path.
    // /bin/cat is a non-interpreting PTY fixture: it cannot start the saved AI command.
    #[tokio::test(flavor = "multi_thread")]
    async fn close_incarnation_delayed_old_kill_preserves_real_resumed_process() {
        tokio::task::spawn_blocking(|| {
            let (directory, mut store, entry, calls) = fixture(false);
            Arc::get_mut(&mut store).unwrap().shell = "/bin/cat".into();
            Arc::get_mut(&mut store).unwrap().durable = false;
            {
                let mut meta = entry.meta.lock().unwrap();
                meta.saved["incarnation"] = json!("11111111111111111111111111111111");
                meta.saved["cwd"] = json!(directory.path());
                meta.saved["projectId"] = json!("__home__");
            }
            let old_request = json!({"type":"kill","termId":entry.id,"incarnation":"11111111111111111111111111111111","requestId":"close:1","confirm":true});
            let board = board::Store::new(directory.path());
            let initial = store.active();
            let mut events = store.events.subscribe();
            store.kill(&old_request, &board).unwrap();
            let old_closed = events.try_recv().unwrap();
            let delayed_receipt = kill_reply(&old_request, Ok(()));
            let resume = V::parse(&serde_json::value::to_raw_value(&json!({"action":"resume","termId":entry.id,"incarnation":"11111111111111111111111111111111"})).unwrap()).unwrap();
            store.maintenance_request(true, &resume, &board).unwrap();
            let resumed = store.find(&entry.id).unwrap();
            let pid = resumed.pid.unwrap();
            let created = events.try_recv().unwrap();
            assert_eq!(created["type"], "created");
            assert_ne!(created["incarnation"], old_request["incarnation"]);
            assert_eq!(store.active()[0]["incarnation"], created["incarnation"]);
            let checkpoint = directory.path().join("session-state.json");
            let before = fs::read(&checkpoint).unwrap();
            let reviews = directory.path().join(".cockpit-board.json");
            fs::write(&reviews, json!({"supervisors":[{"id":"new-review","termId":entry.id,"status":"running","autoRecover":true}]}).to_string()).unwrap();
            let review_before = fs::read(&reviews).unwrap();
            let result = store.kill(&old_request, &board);
            assert!(result.as_ref().unwrap_err().to_string().contains("incarnation"));
            let stale_receipt = kill_reply(&old_request, result);
            let preserved = store.find(&entry.id).is_some_and(|e| Arc::ptr_eq(&e, &resumed));
            let process_alive = Path::new(&format!("/proc/{pid}")).exists() && !resumed.exited.load(Ordering::SeqCst);
            let unchanged = fs::read(&checkpoint).unwrap() == before && fs::read(&reviews).unwrap() == review_before;
            // Always release this isolated test PTY even when the regression is RED.
            let new_request = json!({"type":"kill","termId":entry.id,"incarnation":created["incarnation"],"requestId":"close:2","confirm":true});
            let new_receipt = kill_reply(&new_request, store.kill(&new_request, &board));
            assert_eq!(new_receipt["accepted"], true);
            assert_eq!(new_receipt["requestId"], "close:2");
            let new_closed = std::iter::from_fn(|| events.try_recv().ok()).find(|event| event["type"] == "closed").unwrap();
            println!("CLOSE_BOUNDARY_TRANSCRIPT={}", json!({"initial":initial,"oldRequest":old_request,"oldClosed":old_closed,"created":created,"delayedReceipt":delayed_receipt,"staleReceipt":stale_receipt,"newRequest":new_request,"newReceipt":new_receipt,"newClosed":new_closed}));
            assert_eq!(stale_receipt["accepted"], false, "stale client B close must be rejected after client A close + same-ID resume");
            assert!(preserved && process_alive && unchanged, "new entry, process, checkpoint and review must be unchanged");
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }).await.unwrap();
    }

    #[test]
    fn close_contract_reusable_alias_cannot_authorize_kill() {
        let (directory, store, entry, calls) = fixture(false);
        entry.meta.lock().unwrap().saved["alias"] = json!("ai1");
        store.checkpoint(&mut store.state.lock().unwrap()).unwrap();
        let board = board::Store::new(directory.path());
        assert!(
            store
                .kill(
                    &json!({"termId":"ai1","incarnation":"11111111111111111111111111111111"}),
                    &board
                )
                .is_err(),
            "close must use full termId, not a reusable alias"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(store.find(&entry.id).is_some());
    }

    #[test]
    fn close_contract_protected_exact_terminal_is_preserved() {
        let (directory, store, entry, calls) = fixture(false);
        entry.meta.lock().unwrap().saved["conversationHeld"] = json!(true);
        store.checkpoint(&mut store.state.lock().unwrap()).unwrap();
        let before = fs::read(directory.path().join("session-state.json")).unwrap();
        let board = board::Store::new(directory.path());
        let request = json!({"termId":entry.id,"incarnation":"11111111111111111111111111111111"});
        assert!(
            store.kill(&request, &board).is_err(),
            "protected explicit close must refuse before archiving or signalling"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(store.find(&entry.id).is_some());
        assert_eq!(
            fs::read(directory.path().join("session-state.json")).unwrap(),
            before
        );
    }

    #[test]
    fn final_checkpoint_failure_keeps_entry_and_never_signals() {
        let (directory, store, entry, calls) = fixture(false);
        store.preserve_archive(&entry, "closed").unwrap();
        let path = directory.path().join("session-state.json");
        let backup = directory.path().join("saved.json");
        fs::rename(&path, &backup).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(store.close_entry(&entry).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(Arc::ptr_eq(&store.find(&entry.id).unwrap(), &entry));
        fs::remove_dir(&path).unwrap();
        fs::rename(&backup, &path).unwrap();
        store.close_entry(&entry).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn reaped_entries_are_never_signalled_by_close_or_shutdown() {
        for shutdown in [false, true] {
            let (_directory, store, entry, calls) = fixture(true);
            if shutdown {
                store.shutdown().unwrap();
            } else {
                store.close_entry(&entry).unwrap();
            }
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }
    }
}

impl Store {
    pub(super) fn record_archive(
        &self,
        state: &mut State,
        entry: &Entry,
        reason: &str,
        code: Option<u32>,
    ) {
        let meta = entry.meta.lock().unwrap();
        let mut items = archives(state);
        items.retain(|item| item["saved"]["termId"] != entry.id);
        items.push(json!({"saved":meta.saved,"output":meta.replay.read(),"archivedAt":now(),"reason":reason,"exitCode":code}));
        state.checkpoint["archivedTerminals"] = json!(items);
    }

    pub(super) fn preserve_archive(&self, entry: &Entry, reason: &str) -> io::Result<()> {
        let mut state = self.state.lock().unwrap();
        if !state.restored || state.closing {
            return Err(err(
                "세션 복원 또는 종료 중입니다. 잠시 뒤 다시 시도하세요.",
            ));
        }
        let previous = state.checkpoint.clone();
        self.record_archive(&mut state, entry, reason, None);
        if let Err(error) = self.checkpoint(&mut state) {
            state.checkpoint = previous;
            return Err(error);
        }
        Ok(())
    }

    fn inactive_ids(&self) -> HashSet<String> {
        let state = self.state.lock().unwrap();
        archives(&state)
            .iter()
            .filter_map(|item| {
                let id = value_text(&item["saved"], "termId");
                (terminal_id(id)
                    && !state.entries.iter().any(|entry| entry.id == id)
                    && !state
                        .deferred
                        .iter()
                        .any(|saved| value_text(saved, "termId") == id))
                .then(|| id.to_string())
            })
            .collect()
    }

    pub(super) fn sweep_orphan_mcp(&self) {
        let at = now() as u64;
        if at.saturating_sub(self.last_mcp_sweep.load(Ordering::Relaxed)) < 30 * 60 * 1000 {
            return;
        }
        self.last_mcp_sweep.store(at, Ordering::Relaxed);
        let known = self.inactive_ids();
        if let Ok(snapshot) = process_inventory::snapshot(&known) {
            let requested = snapshot["orphans"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["eligible"] == true)
                .take(100)
                .map(|item| json!({"pid":item["pid"],"startTicks":item["startTicks"]}))
                .collect::<Vec<_>>();
            if !requested.is_empty() {
                let _ = process_inventory::cleanup(&known, &json!(requested));
            }
        }
    }

    pub(super) fn pane_identity(&self, entry: &Entry) -> io::Result<(u32, bool)> {
        if entry.durable.is_empty() {
            let pid = entry.pid.ok_or_else(|| err("세션 프로세스가 없습니다."))?;
            return Ok((pid, entry.exited.load(Ordering::SeqCst)));
        }
        let raw = self.tmux(
            &entry.durable,
            &[
                "display-message",
                "-p",
                "-t",
                "main",
                "#{pane_pid} #{pane_dead}",
            ],
            None,
            &entry.id,
        )?;
        let parts: Vec<_> = raw.split_whitespace().collect();
        let pid = parts
            .first()
            .and_then(|s| s.parse::<u32>().ok())
            .filter(|p| *p > 0)
            .ok_or_else(|| err("세션 상태를 확인할 수 없습니다."))?;
        match parts.get(1) {
            Some(&"0") => Ok((pid, false)),
            Some(&"1") => Ok((pid, true)),
            _ => Err(err("세션 상태를 확인할 수 없습니다.")),
        }
    }

    fn stopped_pane(&self, entry: &Entry) -> io::Result<(u32, bool)> {
        let pane = self.pane_identity(entry)?;
        if pane.1 {
            return Ok(pane);
        }
        Err(err("터미널 프로세스가 아직 실행 중입니다. 작업을 끝낸 뒤 터미널을 닫으면 보관 기록에서 다시 열 수 있습니다."))
    }

    fn maintenance_summary(self: &Arc<Self>) -> io::Result<Value> {
        let entries = self.state.lock().unwrap().entries.clone();
        let mut sessions = self.summary(false)["terminals"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        tokio::runtime::Handle::current().block_on(async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
            let mut pending = stream::iter(entries)
                .map(|entry| {
                    let store = self.clone();
                    tokio::task::spawn_blocking(move || {
                        let activity = store.observe(&entry);
                        let pane = store.pane_identity(&entry).ok();
                        let rss = pane.and_then(|(pid, dead)| {
                            if dead {
                                Some(0)
                            } else {
                                process_inventory::tree_rss_kib(pid).ok()
                            }
                        });
                        let stopped = store.stopped_pane(&entry).is_ok();
                        let saved = entry.meta.lock().unwrap().saved.clone();
                        (entry.id.clone(), activity, rss, stopped, saved)
                    })
                })
                .buffer_unordered(8);
            while let Ok(Some(result)) = tokio::time::timeout_at(deadline, pending.next()).await {
                if let Ok((id, activity, rss, stopped, saved)) = result {
                    let Some(session) = sessions.iter_mut().find(|session| session["termId"] == id)
                    else {
                        continue;
                    };
                    session["activity"] = activity;
                    session["rssKiB"] = json!(rss);
                    session["lastOutputAt"] = saved["lastOutputAt"].clone();
                    session["canArchive"] = json!(stopped && saved["conversationHeld"] != true);
                    session["canResume"] = json!(
                        stopped
                            && saved["conversationHeld"] != true
                            && recovery_command(value_text(&saved, "command"))
                    );
                }
            }
        });
        let state = self.state.lock().unwrap();
        let archived = archives(&state).into_iter().filter(|item| !state.entries.iter().any(|entry| item["saved"]["termId"] == entry.id))
            .map(|item| json!({"termId":item["saved"]["termId"],"incarnation":item["saved"]["incarnation"],"alias":item["saved"]["alias"],"account":item["saved"]["account"],"archivedAt":item["archivedAt"],"reason":item["reason"],"exitCode":item["exitCode"],"canResume":recovery_command(value_text(&item["saved"], "command"))})).collect::<Vec<_>>();
        drop(state);
        let processes = process_inventory::snapshot(&self.inactive_ids())?;
        Ok(
            json!({"sessions":sessions,"archived":archived,"processes":processes,"autoCleanupMinutes":30}),
        )
    }

    pub(super) fn maintenance_request(
        self: &Arc<Self>,
        mutate: bool,
        input: &V,
        board: &board::Store,
    ) -> io::Result<Value> {
        if !mutate {
            return self.maintenance_summary();
        }
        let action = input["action"].text();
        let id = input["termId"].text();
        if action == "cleanup" {
            let _operation = self.operations.lock().unwrap();
            if self.is_closing() {
                return Err(err("서버가 종료 중입니다."));
            }
            return process_inventory::cleanup(
                &self.inactive_ids(),
                &serde_json::from_str(input["processes"].raw().get())?,
            );
        }
        if !terminal_id(&id) {
            return Err(err("세션 ID가 올바르지 않습니다."));
        }
        let _operation = self.operations.lock().unwrap();
        if self.is_closing() || !self.is_restored() {
            return Err(err("세션 복원 또는 종료 중입니다."));
        }
        match action.as_str() {
            "archive" => {
                let entry = self.find(&id).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "세션을 찾지 못했습니다.")
                })?;
                let _guard = entry.control.lock().unwrap();
                if entry.id != id {
                    return Err(err("전체 termId가 필요합니다."));
                }
                require_incarnation(
                    &entry.meta.lock().unwrap().saved,
                    &input["incarnation"].text(),
                )?;
                if entry.meta.lock().unwrap().saved["conversationHeld"] == true {
                    return Err(err("사용자 대화 중인 세션은 보관하지 않습니다."));
                }
                let before = self.stopped_pane(&entry)?;
                self.preserve_archive(&entry, "archived")?;
                board.stop_terminal_reviews(&entry.id).map_err(err)?;
                if self.stopped_pane(&entry)? != before {
                    return Err(err("세션 상태가 바뀌어 보관을 취소했습니다."));
                }
                self.close_entry(&entry)?;
                let _ = self
                    .events
                    .send(json!({"type":"exit","termId":id,"exitCode":0}));
            }
            "history" => {
                let item = archives(&self.state.lock().unwrap())
                    .into_iter()
                    .find(|item| item["saved"]["termId"] == id)
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::NotFound, "보관 기록을 찾지 못했습니다.")
                    })?;
                return Ok(
                    json!({"output":activity::clean_screen(value_text(&item, "output"), 1000).0.join("\n"),"archivedAt":item["archivedAt"]}),
                );
            }
            "delete" => {
                if self.find(&id).is_some() {
                    return Err(err("현재 열린 세션의 기록은 삭제하지 않습니다."));
                }
                let mut state = self.state.lock().unwrap();
                let previous = state.checkpoint.clone();
                let items: Vec<_> = archives(&state)
                    .into_iter()
                    .filter(|item| item["saved"]["termId"] != id)
                    .collect();
                state.checkpoint["archivedTerminals"] = json!(items);
                if let Err(error) = self.checkpoint(&mut state) {
                    state.checkpoint = previous;
                    return Err(error);
                }
            }
            "resume" => {
                if let Some(entry) = self.find(&id) {
                    let _guard = entry.control.lock().unwrap();
                    let saved = entry.meta.lock().unwrap().saved.clone();
                    if entry.id != id {
                        return Err(err("전체 termId가 필요합니다."));
                    }
                    require_incarnation(&saved, &input["incarnation"].text())?;
                    if saved["conversationHeld"] == true {
                        return Err(err("사용자 대화 보호를 해제한 뒤 재개하세요."));
                    }
                    let before = self.stopped_pane(&entry)?;
                    let command = value_text(&saved, "command");
                    if !recovery_command(command) || entry.durable.is_empty() {
                        return Err(err("저장된 AI 실행 명령으로 재개할 수 없습니다."));
                    }
                    self.preserve_archive(&entry, "restarted")?;
                    if self.stopped_pane(&entry)? != before {
                        return Err(err("세션 상태가 바뀌어 재개를 취소했습니다."));
                    }
                    entry.input_generation.fetch_add(1, Ordering::SeqCst);
                    self.tmux(
                        &entry.durable,
                        &[
                            "respawn-pane",
                            "-k",
                            "-t",
                            "main",
                            "-c",
                            value_text(&saved, "cwd"),
                        ],
                        None,
                        &id,
                    )?;
                    entry
                        .writer
                        .try_send(WriteRequest::Raw(format!(
                            "{}\r",
                            self.managed_launch(&saved, command)?
                        )))
                        .map_err(err)?;
                } else {
                    let state = self.state.lock().unwrap();
                    if state
                        .deferred
                        .iter()
                        .any(|saved| value_text(saved, "termId") == id)
                    {
                        return Err(err(
                            "복원 대기 중인 세션입니다. 계정과 작업 폴더를 확인하세요.",
                        ));
                    }
                    let item = archives(&state)
                        .into_iter()
                        .find(|item| item["saved"]["termId"] == id)
                        .ok_or_else(|| {
                            io::Error::new(io::ErrorKind::NotFound, "보관 세션을 찾지 못했습니다.")
                        })?;
                    drop(state);
                    let mut saved = item["saved"].clone();
                    require_incarnation(&saved, &input["incarnation"].text())?;
                    saved.as_object_mut().unwrap().remove("processExited");
                    if !recovery_command(value_text(&saved, "command")) {
                        return Err(err("일회성 명령은 자동 재실행하지 않습니다."));
                    }
                    if !value_text(&saved, "durableId").is_empty()
                        && self.exists(value_text(&saved, "durableId"))?
                    {
                        return Err(err(
                            "같은 세션의 터미널이 남아 있어 중복 실행하지 않았습니다.",
                        ));
                    }
                    self.spawn(
                        saved,
                        PtySize {
                            cols: 120,
                            rows: 30,
                            pixel_width: 0,
                            pixel_height: 0,
                        },
                        None,
                        false,
                    )?;
                }
                self.checkpoint(&mut self.state.lock().unwrap())?;
            }
            _ => return Err(err("지원하지 않는 세션 관리 동작입니다.")),
        }
        Ok(json!({"ok":true,"termId":id}))
    }
}
