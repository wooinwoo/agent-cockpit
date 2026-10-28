// The native process owner is required for tunnel lifecycle and safe legacy cleanup.
export function register({ addRoute, json }) {
  for (const [method, path] of [
    ['GET', '/api/aws-connect'],
    ...['auth', 'logout', 'start', 'stop', 'stop-external', 'save', 'delete'].map(action => ['POST', `/api/aws-connect/${action}`]),
  ]) {
    addRoute(method, path, (_req, res) => {
      json(res, { error: 'AWS 연결 탭은 Linux/WSL의 콕핏 기본 실행에서 지원합니다. 기본 실행으로 다시 시작하세요.' }, 501);
    });
  }
}
