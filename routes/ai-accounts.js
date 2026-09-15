export function register(ctx) {
  const { addRoute, json, readBody, listAiAccounts, listStoredAccounts, createStoredAccount, deleteStoredAccount, setAccountBudget, checkStoredAccountLogin } = ctx;

  // 콕핏 내장 계정 + 허브 참조 계정을 함께 반환
  addRoute('GET', '/api/ai-accounts', (_req, res) => {
    try {
      const data = listAiAccounts();
      json(res, { ...data, accounts: [...listStoredAccounts(), ...data.accounts] });
    } catch { json(res, { error: 'AI 계정 정보를 불러오지 못했습니다.' }, 500); }
  });

  addRoute('POST', '/api/ai-accounts', async (req, res) => {
    const body = await readBody(req);
    try { json(res, createStoredAccount({ name: body.name, provider: body.provider, email: body.email }), 201); }
    catch (err) { json(res, { error: err.message }, 400); }
  });

  addRoute('DELETE', '/api/ai-accounts/:id', (req, res) => {
    try { json(res, deleteStoredAccount(req.params.id)); }
    catch (err) { json(res, { error: err.message }, err.message === 'AI account not found' ? 404 : 400); }
  });

  // 연결 테스트 — 토큰을 쓰지 않고 로그인 상태 실측
  addRoute('POST', '/api/ai-accounts/:id/test', async (req, res) => {
    try { json(res, await checkStoredAccountLogin(req.params.id)); }
    catch (err) { json(res, { error: err.message }, err.message === 'AI account not found' ? 404 : 400); }
  });
  // 주간 토큰 예산 — 잔여량 % 계산 기준 (0이면 해제)
  addRoute('POST', '/api/ai-accounts/:id/budget', async (req, res) => {
    const body = await readBody(req);
    try { json(res, setAccountBudget(req.params.id, body.weeklyTokenBudget)); }
    catch (err) { json(res, { error: err.message }, err.message === 'Invalid AI account' ? 400 : 500); }
  });
}
