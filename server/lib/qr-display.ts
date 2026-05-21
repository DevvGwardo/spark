import * as os from 'os';
import * as QRCode from 'qrcode';

/**
 * Get the LAN IP address of this machine.
 * Prefers the first non-internal IPv4 address.
 */
export function getLanIp(): string | null {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      // Skip internal (127.0.0.1), non-IPv4, and docker/bridge interfaces
      if (!net.internal && net.family === 'IPv4') {
        return net.address;
      }
    }
  }
  return null;
}

/**
 * Generate a terminal QR code string for an URL.
 */
export async function generateTerminalQr(url: string): Promise<string> {
  try {
    return await QRCode.toString(url, {
      type: 'terminal',
      small: true,
    });
  } catch {
    return '[QR code generation failed]';
  }
}

/**
 * Generate an SVG data URI for an URL (embeddable in <img> or background-image).
 */
export async function generateQrSvgDataUri(url: string): Promise<string> {
  const svg = await QRCode.toString(url, {
    type: 'svg',
    width: 300,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#00000000', // transparent
    },
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Format connection info block for terminal output.
 */
export function formatConnectionInfo(ip: string | null, port: number): { lanUrl: string; localUrl: string } {
  const lanUrl = ip ? `http://${ip}:${port}` : '(not available)';
  const localUrl = `http://localhost:${port}`;
  return { lanUrl, localUrl };
}
