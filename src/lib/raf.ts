export const rafThrottle = <Args extends unknown[]>(callback: (...args: Args) => void) => {
  let frame: number | null = null;
  let latestArgs: Args | null = null;

  const run = () => {
    frame = null;
    if (!latestArgs) return;
    callback(...latestArgs);
    latestArgs = null;
  };

  const throttled = (...args: Args) => {
    latestArgs = args;
    if (frame !== null) return;
    frame = window.requestAnimationFrame(run);
  };

  throttled.cancel = () => {
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
    latestArgs = null;
  };

  throttled.flush = () => {
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      run();
    }
  };

  return throttled;
};
