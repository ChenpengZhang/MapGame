/** Windows 高德滚轮适配：合并离散输入，让 SDK 完成动画，避免逐帧 setZoom 重置瓦片。 */
export function installWindowsAmapWheel(map, element, { platform = '', getSpeed = () => 0.5, isLocked = () => false } = {}) {
  if (!/^Win/i.test(platform) || !element) return () => {};
  let timer = null;
  let target = null;
  let lastInput = 0;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    target = null;
  };
  const flush = () => {
    timer = null;
    if (isLocked()) { clear(); return; }
    // 使用 SDK 自身的过渡；绝不逐帧写小数 zoom 或反复重设中心点。
    map.setZoom(target, false, 320);
  };
  const wheel = (event) => {
    // 捕获阶段只接管普通纵向滚轮。触控板 pinch/Ctrl/Command 仍走原有处理。
    if (event.ctrlKey || event.metaKey || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (isLocked()) { clear(); return; }
    const now = performance.now();
    if (target === null || now - lastInput > 450) target = map.getZoom();
    lastInput = now;
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight || 800 : 1);
    const speed = Math.max(0, Math.min(1, getSpeed()));
    // 默认一格约 0.4 级：减轻机械滚轮的跳跃感，速度滑块仍可调整。
    const delta = Math.max(-1, Math.min(1, pixels / 120)) * (0.15 + speed * 0.5);
    const range = map.getZooms?.() || [2, 20];
    target = Math.max(range[0], Math.min(range[1], target - delta));
    // 固定窗口合并高频事件，持续滚动时也能及时开始动画。
    if (timer === null) timer = setTimeout(flush, 50);
  };
  element.addEventListener('wheel', wheel, { capture: true, passive: false });
  element.addEventListener('pointerdown', clear, { capture: true });
  return () => {
    clear();
    element.removeEventListener('wheel', wheel, true);
    element.removeEventListener('pointerdown', clear, true);
  };
}
