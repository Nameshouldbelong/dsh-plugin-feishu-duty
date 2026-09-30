export type ProgressPhase = 'received' | 'thinking' | 'tool' | 'writing';

export function formatProgress(
  phase: ProgressPhase,
  info: { step?: number; toolName?: string },
  language: 'zh' | 'en'
): string {
  const isZh = language === 'zh';
  const stepText = info.step !== undefined 
    ? (isZh ? `（第 ${info.step} 步）` : ` (Step ${info.step})`) 
    : '';

  switch (phase) {
    case 'received':
      return isZh ? '🤔 已接收，准备中…' : '🤔 Received, preparing...';
    case 'thinking':
      return isZh ? `💭 思考中…${stepText}` : `💭 Thinking...${stepText}`;
    case 'tool':
      return isZh
        ? `🔧 执行工具：${info.toolName || 'unknown'}${stepText}`
        : `🔧 Running tool: ${info.toolName || 'unknown'}${stepText}`;
    case 'writing':
      return isZh ? `✍️ 撰写回复…${stepText}` : `✍️ Writing reply...${stepText}`;
  }
}

export function createThrottle(minIntervalMs: number): (fn: () => void) => void {
  let lastTime = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return (fn: () => void) => {
    const now = Date.now();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const remain = minIntervalMs - (now - lastTime);
    if (remain <= 0) {
      lastTime = now;
      fn();
    } else {
      timer = setTimeout(() => {
        lastTime = Date.now();
        timer = null;
        fn();
      }, remain);
    }
  };
}
