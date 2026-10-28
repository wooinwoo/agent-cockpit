# 비용 집계 메모리 측정

`scripts/measure-cost-memory.mjs`로 측정한 원본 기록이다. 서버는 합성 세션 기록만 읽는 임시 저장소에서 실행했고, 운영 데이터는 사용하지 않았다. 경로는 `<repo>`·`<home>`으로 바꿨다.

| 파일 | 조건 | 결과 |
|---|---|---|
| `node-vs-rust.json` | 2026-10-08, release, 8 MiB·파일 4개, 31초 간격 3회. 큰 행(1 MiB)과 작은 행(1 KiB) 두 경우 | Node와 Rust의 RSS 비교. 집계 결과는 두 런타임이 같다 |
| `rust-bounded-arenas.jsonl` | 작은 행, glibc arena 수만 제한 | 작은 기록 추가 후 약 20 MiB 잔류로 실패 |
| `rust-single-arena.jsonl` | 작은 행, Tokio 시작 전 arena 1개(현재 기본값) | 마지막 회차 증가 128 KiB, 회귀 검사 통과 |

다시 측정하려면 release 빌드 후 실행한다. `--check-growth`는 작은 행 조건에서 마지막 회차 RSS 증가가 8 MiB 이상이면 실패한다.

```bash
cargo build --release --locked --manifest-path rust-server/Cargo.toml
node scripts/measure-cost-memory.mjs --release
node scripts/measure-cost-memory.mjs --release --line-kib=1 --rust-only --check-growth
```

단일 로컬 실행(WSL) 결과다. VmHWM에는 샘플 간격(100 ms)보다 짧은 최고치가 포함될 수 있다. 메모리 상한이나 장시간 누수가 없음을 보장하지 않는다.
