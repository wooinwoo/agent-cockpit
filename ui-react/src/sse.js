import { useEffect, useRef } from 'react';

// 여러 뷰가 공유하는 SSE 구독 훅.
// 원본 js/dashboard.js connectSSE()와 동일하게 /api/events에 연결하고,
// 지정한 이벤트명 하나만 add/removeEventListener로 구독한다.
// AiAccounts.jsx의 인라인 EventSource + 30초 폴링 패턴을 이 훅으로 대체할 수 있다.
export function useSse(eventName, handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const es = new EventSource('/api/events');
    const onEvent = (e) => handlerRef.current?.(e);
    es.addEventListener(eventName, onEvent);
    return () => {
      es.removeEventListener(eventName, onEvent);
      es.close();
    };
  }, [eventName]);
}
