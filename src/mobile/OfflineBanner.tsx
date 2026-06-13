import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

/**
 * Thin banner shown when the browser reports no network connection.
 * Mobile connections drop frequently (lock screen, elevator, Wi-Fi → LTE
 * handoff) — make the dead state explicit instead of silently failing.
 */
const OfflineBanner = () => {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-1.5 bg-amber-500/15 px-3 py-1.5 font-sans text-[11px] font-medium text-amber-500"
    >
      <WifiOff className="h-3 w-3" />
      No connection — reconnecting when network returns
    </div>
  );
};

export default OfflineBanner;
